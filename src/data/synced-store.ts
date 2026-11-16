import {
  Cause,
  Effect,
  Exit,
  Fiber,
  type ManagedRuntime,
  Option,
  Stream,
} from "effect";
import { useSyncExternalStore } from "react";

import type { DataChanged } from "@/bindings";
import { toast } from "@/components/ui/toast";
import { BackendError } from "@/effect/tauri";

import { DataEvents } from "./services/data-events";

/*
 * A store of `src/data/*` over the data services. Hooks read it through
 * `useSyncExternalStore`, the actions write through the services. Two
 * modes, picked with the layer set (`src/effect/runtime.ts`):
 *
 * - mock (browser, tests, prerender): the mock services answer
 *   synchronously, so the store reads the demo records when it is created
 *   and applies a write before the action returns. After every write all
 *   mock stores re-read, which plays the cascade of the database. The
 *   screens and their tests never wait.
 * - live (Tauri): the store starts in `loading` and reads on its first
 *   subscriber, then follows `DataChanged` from every window: a change of
 *   its entity re-reads what it concerns. A write waits for the command
 *   and re-reads before it resolves; a failed one shows a toast and leaves
 *   the store as the storage has it.
 *
 *   Reads run concurrently and Rust may answer them in any order, so each
 *   read is numbered when it starts and a result older than what the store
 *   already shows is dropped: a re-read of one scope (a project) loses to a
 *   newer read of that scope or of everything, a full read loses to any
 *   newer applied read. Every write sends `DataChanged` after its commit,
 *   so the newest read of each scope always comes after the last write.
 *
 * The server snapshot is the demo data in both modes: the static export is
 * prerendered with the mocks, so hydration matches it before the client
 * switches to its own state.
 */

export type LoadStatus = "loading" | "ready" | "error";

export interface Synced<T> {
  readonly data: T;
  /** Why the first read failed (`status: "error"`). */
  readonly error?: BackendError;
  readonly status: LoadStatus;
}

/** The re-read a `DataChanged` needs. */
export interface ChangeRead<T, R> {
  /**
   * What the read replaces, e.g. one project's records. Results of one
   * scope apply in the order their reads started. Without it the read
   * replaces everything, like a full read.
   */
  readonly scope?: string;
  /** The read, as an update of the current data. */
  readonly update: Effect.Effect<(current: T) => T, BackendError, R>;
}

export interface SyncedStoreOptions<T, R> {
  /** What a live store holds until the first read. */
  readonly empty: T;
  readonly live: boolean;
  /** The re-read a change needs; `undefined` when it doesn't concern the store. */
  readonly onChange: (change: DataChanged) => ChangeRead<T, R> | undefined;
  /** Everything the store holds. */
  readonly read: Effect.Effect<T, BackendError, R>;
  readonly runtime: ManagedRuntime.ManagedRuntime<R | DataEvents, never>;
  /** The demo data the static export was prerendered with. */
  readonly seed: () => T;
}

export interface MutateOptions {
  /** Title of the error toast. */
  readonly error?: string;
}

export interface SyncedStore<T, R> {
  readonly get: () => T;
  /** What the static export was prerendered with. */
  readonly getServerState: () => Synced<T>;
  readonly getState: () => Synced<T>;
  /**
   * Runs a write. Resolves to its result, or `undefined` when it failed
   * (the toast is shown). In mock mode the store is updated before this
   * returns.
   */
  readonly mutate: <A>(
    effect: Effect.Effect<A, BackendError, R>,
    options?: MutateOptions
  ) => Promise<A | undefined>;
  /** Reads everything again. */
  readonly refresh: () => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  /** The data, for components. */
  readonly use: () => T;
  /** Data with its load status, for components. */
  readonly useState: () => Synced<T>;
}

/** Stops a live store this long after its last subscriber left. */
const STOP_DELAY_MS = 1000;

/** Mock stores re-read after any mock write: the cascade of the database. */
const mockStores = new Set<{ reread: () => void }>();

function rereadMockStores() {
  for (const store of mockStores) {
    store.reread();
  }
}

/**
 * Re-reads the mock stores after a mock backend wrote to the mock
 * database on its own (the brief build). Nothing in Tauri: the live
 * stores follow `DataChanged`.
 */
export function refreshMockStores() {
  rereadMockStores();
}

/** The `BackendError` of a failed exit; a defect becomes `Transport`. */
export function backendErrorOf<A, E>(exit: Exit.Failure<A, E>): BackendError {
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  if (error instanceof BackendError) {
    return error;
  }
  const squashed = Cause.squash(exit.cause);
  return new BackendError({
    kind: "Transport",
    message: squashed instanceof Error ? squashed.message : String(squashed),
  });
}

function showError(title: string, error: BackendError) {
  toast.add({ description: error.message, title, type: "error" });
}

const DEFAULT_ERROR_TITLE = "Не удалось сохранить";

/** The scope of a full read. */
const EVERYTHING = "*";

/**
 * Orders the reads of a live store: each gets a number when it starts, and
 * a result is applied only if no newer read of what it covers has been.
 */
export function createReadOrder() {
  let started = 0;
  let newestApplied = 0;
  const appliedByScope = new Map<string, number>();

  const isStale = (read: number, scope: string) => {
    if (scope === EVERYTHING) {
      return read < newestApplied;
    }
    return (
      read < (appliedByScope.get(EVERYTHING) ?? 0) ||
      read < (appliedByScope.get(scope) ?? 0)
    );
  };

  return {
    /**
     * Whether the result of `read` may be applied; if so, it counts as
     * applied from now on.
     */
    accept: (read: number, scope: string = EVERYTHING) => {
      if (isStale(read, scope)) {
        return false;
      }
      appliedByScope.set(scope, read);
      newestApplied = Math.max(newestApplied, read);
      return true;
    },
    /** Whether the result of `read` is older than what is shown. */
    isStale: (read: number, scope: string = EVERYTHING) => isStale(read, scope),
    /** Numbers a read that starts now. */
    start: () => {
      started += 1;
      return started;
    },
  };
}

export function createSyncedStore<T, R>(
  options: SyncedStoreOptions<T, R>
): SyncedStore<T, R> {
  const { live, runtime } = options;
  const listeners = new Set<() => void>();
  const serverState: Synced<T> = { data: options.seed(), status: "ready" };

  const readSync = (): Synced<T> => {
    const exit = runtime.runSyncExit(options.read);
    return Exit.isSuccess(exit)
      ? { data: exit.value, status: "ready" }
      : { data: options.empty, error: backendErrorOf(exit), status: "error" };
  };

  let state: Synced<T> = live
    ? { data: options.empty, status: "loading" }
    : readSync();

  const setState = (next: Synced<T>) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const order = createReadOrder();

  /** Live: the first read, or a full re-read. */
  const load = Effect.suspend(() => {
    const read = order.start();
    return Effect.exit(options.read).pipe(
      Effect.flatMap((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            if (order.accept(read)) {
              setState({ data: exit.value, status: "ready" });
            }
          } else if (state.status !== "ready" && !order.isStale(read)) {
            // A later re-read that fails keeps the data it had.
            setState({
              ...state,
              error: backendErrorOf(exit),
              status: "error",
            });
          }
        })
      )
    );
  });

  const onChange = (change: DataChanged) => {
    const reread = options.onChange(change);
    if (!reread) {
      return Effect.void;
    }
    // Without a first read there is nothing to patch: read it all.
    if (state.status !== "ready") {
      return load;
    }
    return Effect.suspend(() => {
      const read = order.start();
      return Effect.exit(reread.update).pipe(
        Effect.flatMap((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit) && order.accept(read, reread.scope)) {
              setState({ data: exit.value(state.data), status: "ready" });
            }
          })
        )
      );
    });
  };

  let stopFollowing: (() => void) | undefined;
  let stopTimer: ReturnType<typeof setTimeout> | undefined;

  /** Live: listen to the changes first, so nothing written meanwhile is lost. */
  const follow = () => {
    const fiber = runtime.runFork(
      Effect.gen(function* () {
        const events = yield* DataEvents;
        yield* Effect.forkChild(
          events.changes.pipe(
            Stream.runForEach(onChange),
            Effect.catch(() => Effect.void)
          ),
          { startImmediately: true }
        );
        yield* load;
        yield* Effect.never;
      })
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (live) {
      clearTimeout(stopTimer);
      stopFollowing ??= follow();
    }
    return () => {
      listeners.delete(listener);
      if (live && listeners.size === 0) {
        clearTimeout(stopTimer);
        stopTimer = setTimeout(() => {
          if (listeners.size === 0) {
            stopFollowing?.();
            stopFollowing = undefined;
          }
        }, STOP_DELAY_MS);
      }
    };
  };

  const refresh = async () => {
    if (live) {
      await runtime.runPromise(load);
    } else {
      setState(readSync());
    }
  };

  if (!live) {
    mockStores.add({ reread: () => setState(readSync()) });
  }

  const mutate = async <A>(
    effect: Effect.Effect<A, BackendError, R>,
    mutateOptions?: MutateOptions
  ): Promise<A | undefined> => {
    const title = mutateOptions?.error ?? DEFAULT_ERROR_TITLE;
    if (!live) {
      const exit = runtime.runSyncExit(effect);
      if (Exit.isFailure(exit)) {
        showError(title, backendErrorOf(exit));
        return;
      }
      rereadMockStores();
      return exit.value;
    }
    const exit = await runtime.runPromiseExit(effect);
    if (Exit.isFailure(exit)) {
      showError(title, backendErrorOf(exit));
      return;
    }
    await runtime.runPromise(load);
    return exit.value;
  };

  const getState = () => state;
  const getServerState = () => serverState;
  const get = () => state.data;
  const getServerData = () => serverState.data;

  return {
    get,
    getServerState,
    getState,
    mutate,
    refresh,
    subscribe,
    use: () => useSyncExternalStore(subscribe, get, getServerData),
    useState: () => useSyncExternalStore(subscribe, getState, getServerState),
  };
}

/**
 * One synced store per key (a call, a person), made when the key is first
 * used and kept: the per-call reads of the post-call pages.
 */
export function createSyncedStores<T, R>(
  options: (key: string) => SyncedStoreOptions<T, R>
): (key: string) => SyncedStore<T, R> {
  const stores = new Map<string, SyncedStore<T, R>>();
  return (key) => {
    let store = stores.get(key);
    if (!store) {
      store = createSyncedStore(options(key));
      stores.set(key, store);
    }
    return store;
  };
}

const subscribeToNothing = () => () => undefined;

/**
 * The state of `store` for components; `fallback` without one (no key
 * yet, e.g. before the search params are read).
 */
export function useSyncedState<T, R>(
  store: SyncedStore<T, R> | undefined,
  fallback: Synced<T>
): Synced<T> {
  return useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.getState ?? (() => fallback),
    store?.getServerState ?? (() => fallback)
  );
}
