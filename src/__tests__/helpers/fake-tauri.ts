import type {
  Call,
  CommandError,
  DataChanged,
  Person,
  Project,
  Value,
} from "@/bindings";
import { mergePatch } from "@/lib/merge-patch";

/*
 * A stand-in for the Tauri IPC in tests that run the app in "Tauri mode":
 * `invoke` answers the data commands from in-memory tables, `listen`
 * remembers the handlers so a test can play an event Rust would send to
 * every window (a write made in another window, a tray click).
 *
 * Use with `vi.hoisted` + `vi.mock` of `@tauri-apps/api/core`,
 * `@tauri-apps/api/event` and `@tauri-apps/api/window`, and
 * `globalThis.isTauri = true` before the app modules load.
 */

type Handler = (event: { payload: unknown }) => void;

export interface FakeTauri {
  dataChanged: (change: DataChanged) => void;
  readonly db: {
    calls: Call[];
    people: Person[];
    projects: Project[];
    settings: { [key: string]: Value };
  };
  /** Plays an event as Rust would send it. */
  emit: (event: string, payload: unknown) => void;
  /** The next calls of these commands fail with this error. */
  readonly failures: Map<string, CommandError>;
  /** Listeners by event name: every store of every window has its own. */
  readonly handlers: Map<string, Set<Handler>>;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly invoked: { args?: Record<string, unknown>; command: string }[];
  listen: (event: string, handler: Handler) => Promise<() => void>;
}

let created = Date.UTC(2026, 9, 1);

export function fakeProject(id: string, name: string): Project {
  created += 1;
  return {
    brief: null,
    createdAt: created,
    description: "",
    id,
    name,
    openQuestions: 0,
    updatedAt: created,
  };
}

export function fakePerson(
  id: string,
  projectId: string,
  name: string
): Person {
  created += 1;
  return {
    createdAt: created,
    id,
    name,
    profile: {},
    projectId,
    role: "",
    updatedAt: created,
  };
}

export function fakeCall(id: string, projectId: string, title: string): Call {
  created += 1;
  return {
    createdAt: created,
    endedAt: created + 60_000,
    id,
    openQuestions: 0,
    participantIds: [],
    projectId,
    startedAt: created,
    status: "finished",
    summary: null,
    title,
    updatedAt: created,
  };
}

export function createFakeTauri(): FakeTauri {
  const db: FakeTauri["db"] = {
    calls: [],
    people: [],
    projects: [],
    settings: { onboardingCompleted: true },
  };
  const failures = new Map<string, CommandError>();
  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      handler({ payload });
    }
  };
  const invoked: FakeTauri["invoked"] = [];

  const answer = (command: string, args: Record<string, unknown>): unknown => {
    switch (command) {
      case "projects_list":
        return db.projects;
      case "people_list":
        return db.people.filter(
          (person) => person.projectId === args.projectId
        );
      case "calls_list":
        return db.calls.filter(
          (call) => !args.projectId || call.projectId === args.projectId
        );
      case "settings_get":
        return db.settings;
      case "calls_patch_summary": {
        const call = db.calls.find((item) => item.id === args.id);
        if (!call) {
          throw new Error(`Звонок ${args.id} не найден`);
        }
        call.summary = mergePatch(call.summary, args.patch as Value);
        return call;
      }
      case "windows_show":
      case "storage_reopen":
        return null;
      default:
        throw new Error(`Нет команды ${command} в фейке`);
    }
  };

  return {
    dataChanged: (change) => emit("data-changed", change),
    db,
    emit,
    failures,
    handlers,
    invoke: (command, args = {}) => {
      invoked.push({ args, command });
      const failure = failures.get(command);
      if (failure) {
        return Promise.reject(failure);
      }
      try {
        // A copy, like a JSON round trip over the IPC.
        return Promise.resolve(structuredClone(answer(command, args)));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    invoked,
    listen: (event, handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => {
        set.delete(handler);
      });
    },
  };
}
