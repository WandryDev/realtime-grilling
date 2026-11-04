import type {
  Call,
  CommandError,
  DataChanged,
  MicActivityChanged,
  Person,
  Project,
  ProjectSource,
  RecordingStatus,
  SourceAddResult,
  Value,
} from "@/bindings";
import { mergePatch } from "@/lib/merge-patch";

/*
 * A stand-in for the Tauri IPC in tests that run the app in "Tauri mode":
 * `invoke` answers the data commands from in-memory tables, `listen`
 * remembers the handlers so a test can play an event Rust would send to
 * every window (a write made in another window, a tray click). The
 * recorder starts one recording at a time (`recording`), and Zoom holds
 * the microphone (`micActivity`) until a test says otherwise.
 *
 * Use with `vi.hoisted` + `vi.mock` of `@tauri-apps/api/core`,
 * `@tauri-apps/api/event` and `@tauri-apps/api/window`, and
 * `globalThis.isTauri = true` before the app modules load.
 */

type Handler = (event: { payload: unknown }) => void;

export interface FakeTauri {
  /**
   * Answers of commands the fake doesn't know (the onboarding ones), set by
   * a test. A returned promise is passed through as is, so a test can keep
   * a command running.
   */
  readonly answers: Map<string, (args: Record<string, unknown>) => unknown>;
  dataChanged: (change: DataChanged) => void;
  readonly db: {
    calls: Call[];
    people: Person[];
    projects: Project[];
    settings: { [key: string]: Value };
    sources: ProjectSource[];
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
  /** What `mic_activity_get` answers. */
  micActivity: MicActivityChanged;
  /** What `recording_status` answers; `recording_start` and `_stop` set it. */
  recording: RecordingStatus;
}

let created = Date.UTC(2026, 9, 1);

export function fakeProject(id: string, name: string): Project {
  created += 1;
  return {
    brief: null,
    briefBuiltAt: null,
    briefState: "none",
    briefTruncated: false,
    createdAt: created,
    description: "",
    id,
    name,
    notes: "",
    openQuestions: 0,
    updatedAt: created,
  };
}

export function fakeSource(
  id: string,
  projectId: string,
  name: string,
  status: ProjectSource["status"] = "ready"
): ProjectSource {
  created += 1;
  return {
    createdAt: created,
    error: status === "ready" ? null : "Нет текста: похоже на скан",
    extension: name.split(".").at(-1)?.toLowerCase() ?? "",
    id,
    name,
    projectId,
    size: 2048,
    status,
    textChars: status === "ready" ? 1500 : 0,
    truncated: false,
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

/** Ids `recording_start` gives: "fake-recording-1", "-2"… */
export const FAKE_RECORDING_PREFIX = "fake-recording-";

export const IDLE_RECORDING: RecordingStatus = {
  channels: { me: "ok", others: "ok" },
  segmentation: "ok",
  transcription: { state: "ok" },
};

export function createFakeTauri(): FakeTauri {
  const db: FakeTauri["db"] = {
    calls: [],
    people: [],
    projects: [],
    settings: { onboardingCompleted: true },
    sources: [],
  };
  const answers: FakeTauri["answers"] = new Map();
  const failures = new Map<string, CommandError>();
  const handlers = new Map<string, Set<Handler>>();
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) {
      handler({ payload });
    }
  };
  const invoked: FakeTauri["invoked"] = [];
  const recordings: string[] = [];
  /** `DataChanged` after a write, as Rust sends it after the commit. */
  const changed = (
    entity: DataChanged["entity"],
    id: string,
    projectId: string | null,
    change: DataChanged["change"]
  ) => {
    queueMicrotask(() =>
      emit("data-changed", { change, entity, id, projectId })
    );
  };

  const answer = (command: string, args: Record<string, unknown>): unknown => {
    switch (command) {
      case "projects_list":
        return db.projects;
      case "people_list":
        return db.people.filter(
          (person) => person.projectId === args.projectId
        );
      case "projects_create": {
        const input = args.input as {
          description?: string;
          name: string;
          notes?: string;
        };
        created += 1;
        const project: Project = {
          ...fakeProject(`fake-project-${created}`, input.name.trim()),
          description: input.description ?? "",
          notes: input.notes ?? "",
        };
        db.projects.push(project);
        changed("project", project.id, project.id, "created");
        return project;
      }
      case "projects_update": {
        const project = db.projects.find((item) => item.id === args.id);
        if (!project) {
          throw new Error(`Проект ${args.id} не найден`);
        }
        const patch = args.patch as Partial<Project>;
        for (const key of ["name", "description", "notes"] as const) {
          const value = patch[key];
          if (typeof value === "string") {
            project[key] = value;
          }
        }
        changed("project", project.id, project.id, "updated");
        return project;
      }
      case "projects_delete": {
        const index = db.projects.findIndex((item) => item.id === args.id);
        db.projects.splice(index, 1);
        changed("project", String(args.id), String(args.id), "deleted");
        return null;
      }
      case "people_create": {
        const input = args.input as {
          name: string;
          profile?: Value;
          projectId: string;
          role?: string;
        };
        created += 1;
        const person: Person = {
          ...fakePerson(`fake-person-${created}`, input.projectId, input.name),
          profile: input.profile ?? {},
          role: input.role ?? "",
        };
        db.people.push(person);
        changed("person", person.id, person.projectId, "created");
        changed("project", person.projectId, person.projectId, "updated");
        return person;
      }
      case "people_update": {
        const person = db.people.find((item) => item.id === args.id);
        if (!person) {
          throw new Error(`Человек ${args.id} не найден`);
        }
        const patch = args.patch as Partial<Person>;
        person.name = patch.name ?? person.name;
        person.role = patch.role ?? person.role;
        person.profile = patch.profile ?? person.profile;
        changed("person", person.id, person.projectId, "updated");
        changed("project", person.projectId, person.projectId, "updated");
        return person;
      }
      case "people_delete": {
        const index = db.people.findIndex((item) => item.id === args.id);
        const [person] = db.people.splice(index, 1);
        if (person) {
          changed("person", person.id, person.projectId, "deleted");
          changed("project", person.projectId, person.projectId, "updated");
        }
        return null;
      }
      case "projects_overview":
        return db.projects.map((project) => {
          const calls = db.calls.filter(
            (call) => call.projectId === project.id
          );
          const started = calls.flatMap((call) =>
            call.startedAt === null ? [] : [call.startedAt]
          );
          return {
            lastRecordingAt: started.length > 0 ? Math.max(...started) : null,
            openQuestions: calls.reduce(
              (sum, call) => sum + call.openQuestions,
              0
            ),
            projectId: project.id,
          };
        });
      case "project_sources_list":
        return db.sources.filter(
          (source) => source.projectId === args.projectId
        );
      case "project_sources_add": {
        const projectId = String(args.projectId);
        return (args.paths as string[]).map((path): SourceAddResult => {
          const name = path.split("/").at(-1) ?? path;
          created += 1;
          const source = fakeSource(`fake-source-${created}`, projectId, name);
          db.sources.push(source);
          changed("project", projectId, projectId, "updated");
          return { name, path, result: { outcome: "added", source } };
        });
      }
      case "project_sources_remove": {
        const index = db.sources.findIndex((item) => item.id === args.id);
        const [removed] = db.sources.splice(index, 1);
        if (removed) {
          changed("project", removed.projectId, removed.projectId, "updated");
        }
        return null;
      }
      case "brief_build":
      case "brief_cancel":
        return null;
      case "brief_prepare":
        return false;
      case "brief_export":
        return `${args.folder}/бриф.md`;
      // The folder or file dialog was closed.
      case "plugin:dialog|open":
        return null;
      case "calls_list":
        return db.calls.filter(
          (call) => !args.projectId || call.projectId === args.projectId
        );
      case "settings_get":
        return db.settings;
      case "settings_update":
        Object.assign(db.settings, args.patch);
        return {
          launchAtLoginError: null,
          settings: db.settings,
          shortcutErrors: [],
        };
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
      case "mic_activity_get":
        return fake.micActivity;
      case "recording_status":
        return fake.recording;
      case "recording_start": {
        if (fake.recording.id) {
          return fake.recording.id;
        }
        const id = `${FAKE_RECORDING_PREFIX}${recordings.length + 1}`;
        recordings.push(id);
        fake.recording = { ...IDLE_RECORDING, id, startedAt: Date.now() };
        return id;
      }
      case "recording_stop":
        if (fake.recording.id === args.id) {
          fake.recording = IDLE_RECORDING;
        }
        return null;
      // The second pass has not started.
      case "transcript_state":
        return "live";
      default:
        throw new Error(`Нет команды ${command} в фейке`);
    }
  };

  const fake: FakeTauri = {
    answers,
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
      if (
        command === "recording_stop" &&
        !recordings.includes(String(args.id))
      ) {
        const unknown: CommandError = {
          kind: "NotFound",
          message: `Записи ${args.id} нет`,
        };
        return Promise.reject(unknown);
      }
      const custom = answers.get(command);
      if (custom) {
        const result = custom(args);
        return result instanceof Promise
          ? result
          : Promise.resolve(structuredClone(result));
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
    micActivity: { app: "Zoom", busy: true, since: created },
    recording: IDLE_RECORDING,
  };
  return fake;
}
