import { Context, Effect, Layer, Queue, Stream } from "effect";

import { commands, events, type UpdateStatus } from "@/bindings";
import { type BackendError, call, listenFromCurrent } from "@/effect/tauri";

/*
 * The app's updates (`src-tauri/src/updates.rs`). Rust checks the GitHub
 * releases in the background, downloads a found update and reports it
 * ready; «Перезапустить» installs it and starts the new version. The
 * contract types are the generated `UpdateStatus` / `UpdateState`.
 */
export class UpdatesBackend extends Context.Service<
  UpdatesBackend,
  {
    /** The status now, then every change, while the stream runs. */
    readonly status: Stream.Stream<UpdateStatus, BackendError>;
    /** «Проверить обновления»: the status after the check (and download). */
    readonly check: Effect.Effect<UpdateStatus, BackendError>;
    /**
     * «Перезапустить»: installs the downloaded update; the app restarts and
     * the effect never succeeds. `Invalid` during a call.
     */
    readonly install: Effect.Effect<void, BackendError>;
  }
>()("grill/features/updates/UpdatesBackend") {
  static readonly layerTauri = Layer.succeed(UpdatesBackend, {
    check: call(() => commands.updatesCheck()),
    install: Effect.asVoid(call(() => commands.updatesInstall())),
    status: listenFromCurrent(
      events.updateStatus,
      call(() => commands.updatesGet()),
      (status) => status
    ),
  });

  /*
   * The browser demo: version 0.3.0, up to date; a check finds and
   * downloads 0.4.0, «Перезапустить» "restarts" into it.
   */
  static readonly layerMock = Layer.succeed(UpdatesBackend, {
    check: Effect.gen(function* () {
      mockUpdates.set({ current: MOCK_CURRENT, state: { status: "checking" } });
      yield* Effect.sleep(MOCK_STEP_MS);
      for (const percent of [0, 40, 80]) {
        mockUpdates.set({
          current: MOCK_CURRENT,
          state: { percent, status: "downloading", version: MOCK_NEXT },
        });
        yield* Effect.sleep(MOCK_STEP_MS);
      }
      mockUpdates.set(MOCK_READY);
      return MOCK_READY;
    }),
    install: Effect.gen(function* () {
      mockUpdates.set({
        current: MOCK_CURRENT,
        state: { status: "installing", version: MOCK_NEXT },
      });
      yield* Effect.sleep(MOCK_STEP_MS);
      mockUpdates.set({
        current: MOCK_NEXT,
        state: { checkedAt: Date.now(), status: "upToDate" },
      });
    }),
    status: Stream.callback<UpdateStatus, BackendError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          mockUpdates.subscribe((status) => {
            Queue.offerUnsafe(queue, status);
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
    ),
  });
}

const MOCK_CURRENT = "0.3.0";
const MOCK_NEXT = "0.4.0";
const MOCK_STEP_MS = 500;
const MOCK_CHECKED_AGO_MS = 2 * 60 * 60_000;

const MOCK_READY: UpdateStatus = {
  current: MOCK_CURRENT,
  state: {
    notes: "Шаг «Агент» показывает настоящий аккаунт Claude.",
    status: "ready",
    version: MOCK_NEXT,
  },
};

const MOCK_INITIAL: UpdateStatus = {
  current: MOCK_CURRENT,
  state: { checkedAt: Date.now() - MOCK_CHECKED_AGO_MS, status: "upToDate" },
};

let mockStatus = MOCK_INITIAL;
const mockListeners = new Set<(status: UpdateStatus) => void>();

/*
 * The status `layerMock` reports. Plain synchronous state, so the demo and
 * the tests can put the updater in any state.
 */
export const mockUpdates = {
  reset() {
    mockUpdates.set(MOCK_INITIAL);
  },
  set(next: UpdateStatus) {
    mockStatus = next;
    for (const listener of mockListeners) {
      listener(mockStatus);
    }
  },
  subscribe(listener: (status: UpdateStatus) => void) {
    mockListeners.add(listener);
    listener(mockStatus);
    return () => {
      mockListeners.delete(listener);
    };
  },
};
