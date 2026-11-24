import type {
  AudioInputs,
  BrowseNode,
  Call,
  CallOverview,
  CallSession,
  CommandError,
  ConnectorKind,
  ConnectorView,
  DataChanged,
  MicActivityChanged,
  Person,
  Project,
  ProjectConnectorView,
  ProjectSource,
  RecordingStatus,
  SelectionItem,
  SourceAddResult,
  SubscriptionLimitView,
  Value,
  Workspace,
} from "@/bindings";
import { settingProblem } from "@/data/services/setting-checks";
import { mergePatch } from "@/lib/merge-patch";

/*
 * A stand-in for the Tauri IPC in tests that run the app in "Tauri mode":
 * `invoke` answers the data commands from in-memory tables, `listen`
 * remembers the handlers so a test can play an event Rust would send to
 * every window (a write made in another window, a tray click). The
 * recorder starts one recording at a time (`recording`), and Zoom holds
 * the microphone (`micActivity`) until a test says otherwise. The call
 * commands play the backend's `CallManager` (`session`): `call_start`
 * stores the call and records it, each change sends `DataChanged` of the
 * call, then `CallSessionChanged`.
 *
 * The connectors play Rust's (`connectors_*`): Outline and ClickUp are
 * available, GitHub is not. A key or token starting with `bad` is refused
 * at the key, an Outline host with `nowhere` at the address; a ClickUp
 * token opens `clickup.workspaces` (several: `chooseWorkspace` first). The
 * picker's trees are `outline` and `clickup`, and a saved selection syncs
 * at once: the documents of the picked containers and documents become
 * sources with `origin`, less the excluded ones (a ClickUp exclude takes
 * the nested ones along). A selection over 200 is refused as `Invalid`.
 *
 * Use with `vi.hoisted` + `vi.mock` of `@tauri-apps/api/core`,
 * `@tauri-apps/api/event` and `@tauri-apps/api/window`, and
 * `globalThis.isTauri = true` before the app modules load.
 */

type Handler = (event: { payload: unknown }) => void;

/** A service's tree: the top level, and what each container loads. */
export interface FakeService {
  containers: BrowseNode[];
  trees: Record<string, BrowseNode[]>;
}

export interface FakeTauri {
  /**
   * Answers of commands the fake doesn't know (the onboarding ones), set by
   * a test. A returned promise is passed through as is, so a test can keep
   * a command running.
   */
  readonly answers: Map<string, (args: Record<string, unknown>) => unknown>;
  /**
   * What `audio_inputs_get` answers: the built-in microphone, «Как в
   * системе». `audio-inputs-changed` is played with `emit`.
   */
  audioInputs: AudioInputs;
  /**
   * The ClickUp the picker browses: spaces, what each container holds, the
   * workspaces a token opens.
   */
  clickup: FakeService & { workspaces: Workspace[] };
  dataChanged: (change: DataChanged) => void;
  readonly db: {
    calls: Call[];
    connections: ConnectorView[];
    people: Person[];
    projects: Project[];
    /** The saved selections; a project without one reads as empty. */
    selections: ProjectConnectorView[];
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
  /**
   * What `agent_limit_get` and `agent_limit_refresh` answer: no measures,
   * the default thresholds. `setLimit` changes it and sends
   * `SubscriptionLimitChanged`.
   */
  limit: SubscriptionLimitView;
  listen: (event: string, handler: Handler) => Promise<() => void>;
  /** What `mic_activity_get` answers. */
  micActivity: MicActivityChanged;
  /** The Outline the picker browses: collections, and each one's tree. */
  outline: FakeService;
  /**
   * What the recording of a call fails with (`call_start`, `call_resume`);
   * null: it starts.
   */
  recordFailure: CommandError | null;
  /** What `recording_status` answers; `recording_start` and `_stop` set it. */
  recording: RecordingStatus;
  /** The backend's call in progress, as `call_current` answers it. */
  session: CallSession;
  setLimit: (limit: SubscriptionLimitView) => void;
  /** Sets the call in progress and sends it to every window. */
  setSession: (session: CallSession) => void;
}

/** A live call of the backend, started now unless said otherwise. */
export function liveSession(session: Partial<CallSession> = {}): CallSession {
  return {
    ...IDLE_SESSION,
    callId: "fake-call-live",
    startedAt: Date.now(),
    status: "live",
    ...session,
  };
}

/** The share of the limit before any measure. */
export const NO_LIMIT_DATA: SubscriptionLimitView = {
  checking: false,
  outlook: { kind: "ok" },
  session: null,
  thresholds: { session: 90, week: 80 },
  week: null,
};

/** The commands of the `CallManager`. */
const CALL_COMMANDS = new Set([
  "call_current",
  "call_start",
  "call_finish",
  "call_resume",
  "call_close",
  "call_keep",
  "call_discard",
]);

export const IDLE_SESSION: CallSession = {
  autoEnd: null,
  callId: null,
  participantIds: [],
  participants: [],
  projectId: null,
  recordingId: null,
  startedAt: null,
  status: "idle",
};

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

export function fakeCall(
  id: string,
  projectId: string | null,
  title: string
): Call {
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

const AUTH: Record<ConnectorKind, ConnectorView["auth"]> = {
  clickup: { host: false, type: "apiKey" },
  github: { type: "deviceCode" },
  outline: { host: true, type: "apiKey" },
};

/** A connector of the catalog, not connected. */
export function fakeConnector(
  kind: ConnectorKind,
  view: Partial<ConnectorView> = {}
): ConnectorView {
  const available = kind !== "github";
  return {
    account: null,
    auth: AUTH[kind],
    available,
    capabilities: available ? ["projectSources"] : [],
    connectedAt: null,
    error: null,
    errorKind: null,
    kind,
    lastAttemptAt: null,
    lastOkAt: null,
    status: "disconnected",
    ...view,
  };
}

export const FAKE_OUTLINE_ACCOUNT = {
  host: "https://docs.pixel.agency",
  teamId: "team-pixel",
  teamName: "Pixel Agency",
  userName: "Дима",
};

/** Outline connected to Pixel Agency, answered at `at`. */
export function connectedOutline(at: number = Date.now()): ConnectorView {
  return fakeConnector("outline", {
    account: FAKE_OUTLINE_ACCOUNT,
    connectedAt: at,
    lastAttemptAt: at,
    lastOkAt: at,
    status: "connected",
  });
}

export const FAKE_CLICKUP_ACCOUNT = {
  host: null,
  teamId: "9001",
  teamName: "Pixel Agency",
  userName: "Дима",
};

/** ClickUp connected to Pixel Agency, answered at `at`. */
export function connectedClickUp(at: number = Date.now()): ConnectorView {
  return fakeConnector("clickup", {
    account: FAKE_CLICKUP_ACCOUNT,
    connectedAt: at,
    lastAttemptAt: at,
    lastOkAt: at,
    status: "connected",
  });
}

/** A node of the picker's tree. */
export function fakeNode(
  id: string,
  title: string,
  kind: BrowseNode["kind"] = "document",
  children: BrowseNode[] = []
): BrowseNode {
  const nested = children.reduce((sum, child) => sum + child.documentCount, 0);
  return {
    children,
    documentCount: kind === "document" ? 1 + nested : nested,
    hasChildren: children.length > 0,
    id,
    kind,
    title,
    url: `https://docs.pixel.agency/${kind === "container" ? "collection" : "doc"}/${id}`,
  };
}

/** The connectors that give a project its sources. */
const SOURCE_KINDS: ConnectorKind[] = ["outline", "clickup"];

/** The most documents a project takes from a connector. */
const FAKE_LIMIT = 200;

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
    connections: [
      fakeConnector("outline"),
      fakeConnector("github"),
      fakeConnector("clickup"),
    ],
    people: [],
    projects: [],
    selections: [],
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

  /** The next recording of the fake recorder. */
  const record = () => {
    const id = `${FAKE_RECORDING_PREFIX}${recordings.length + 1}`;
    recordings.push(id);
    fake.recording = { ...IDLE_RECORDING, id, startedAt: Date.now() };
    return id;
  };

  /** A change of the call in progress: `DataChanged` first, as Rust sends. */
  const sessionChanged = (session: CallSession) => {
    fake.session = session;
    const call = db.calls.find((item) => item.id === session.callId);
    if (call) {
      changed("call", call.id, call.projectId, "updated");
    }
    queueMicrotask(() => emit("call-session-changed", { session }));
    return session;
  };

  const commandError = (kind: CommandError["kind"], message: string) => {
    const error: CommandError = { kind, message };
    return error;
  };

  /** `call_*` of the `CallManager`; a failure rejects with its `CommandError`. */
  const callCommand = (
    command: string,
    args: Record<string, unknown>
  ): CallSession => {
    const { session } = fake;
    if (command === "call_current") {
      return session;
    }
    if (command === "call_start") {
      if (session.status !== "idle") {
        return session;
      }
      if (fake.recordFailure) {
        throw fake.recordFailure;
      }
      const input = args.input as {
        participantIds?: string[] | null;
        projectId?: string | null;
      };
      const participantIds = input.participantIds ?? [];
      const projectId = input.projectId ?? null;
      created += 1;
      const now = Date.now();
      const call: Call = {
        ...fakeCall(`fake-call-${created}`, projectId, ""),
        endedAt: null,
        participantIds,
        startedAt: now,
        status: "live",
      };
      db.calls.push(call);
      changed("call", call.id, projectId, "created");
      return sessionChanged({
        autoEnd: null,
        callId: call.id,
        participantIds,
        participants: participantIds.map(
          (id) => db.people.find((person) => person.id === id)?.name ?? id
        ),
        projectId,
        recordingId: record(),
        startedAt: now,
        status: "live",
      });
    }
    const callId = String(args.callId);
    // A session a test set may have no row: it is the current call anyway.
    const call = db.calls.find((item) => item.id === callId) ?? {
      endedAt: null,
      status: session.status,
    };
    if (session.callId !== callId) {
      throw db.calls.some((item) => item.id === callId)
        ? commandError("Invalid", `Звонок ${callId} сейчас не идёт`)
        : commandError("NotFound", `Звонок ${callId} не найден`);
    }
    switch (command) {
      case "call_finish":
        if (session.status !== "live") {
          return session;
        }
        fake.recording = IDLE_RECORDING;
        call.status = "finishing";
        call.endedAt = Date.now();
        return sessionChanged({
          ...session,
          autoEnd: null,
          status: "finishing",
        });
      case "call_resume": {
        if (session.status !== "finishing") {
          return session;
        }
        call.status = "live";
        call.endedAt = null;
        const failure = fake.recordFailure;
        sessionChanged({
          ...session,
          recordingId: failure ? null : record(),
          status: "live",
        });
        if (failure) {
          throw failure;
        }
        return fake.session;
      }
      case "call_close":
        if (session.status !== "finishing") {
          return session;
        }
        call.status = "finished";
        return sessionChanged(IDLE_SESSION);
      case "call_keep":
        return sessionChanged({ ...session, autoEnd: null });
      // The call goes without a summary; its row is left for the delete.
      case "call_discard":
        if (session.status === "idle") {
          return session;
        }
        if (session.status === "live") {
          fake.recording = IDLE_RECORDING;
        }
        fake.session = IDLE_SESSION;
        queueMicrotask(() =>
          emit("call-session-changed", { session: IDLE_SESSION })
        );
        return IDLE_SESSION;
      default:
        throw new Error(`Нет команды ${command} в фейке`);
    }
  };

  const connectionOf = (kind: ConnectorKind) =>
    db.connections.find((view) => view.kind === kind) ?? fakeConnector(kind);

  const selectionOf = (
    projectId: string,
    kind: ConnectorKind
  ): ProjectConnectorView =>
    db.selections.find(
      (view) => view.projectId === projectId && view.kind === kind
    ) ?? {
      connected: connectionOf(kind).status !== "disconnected",
      items: [],
      kind,
      projectId,
      sync: null,
      syncing: false,
    };

  const serviceOf = (kind: ConnectorKind): FakeService =>
    kind === "clickup" ? fake.clickup : fake.outline;

  /** What is inside a node as far as the fake knows. */
  const inside = (service: FakeService, node: BrowseNode) =>
    node.children.length > 0 ? node.children : (service.trees[node.id] ?? []);

  /** The documents a selection brings, by id. */
  const resolve = (kind: ConnectorKind, items: SelectionItem[]) => {
    const service = serviceOf(kind);
    const excluded = new Set(
      items
        .filter((item) => item.itemKind === "exclude")
        .map((item) => item.externalId)
    );
    const picked = new Set(
      items
        .filter((item) => item.itemKind !== "exclude")
        .map((item) => item.externalId)
    );
    const documents = new Map<string, BrowseNode>();
    const takesNested = kind === "clickup";
    // Walks a level, collecting documents brought (`covered`).
    const walk = (nodes: BrowseNode[], covered: boolean) => {
      for (const node of nodes) {
        const left = excluded.has(node.id);
        const here = (covered && !left) || picked.has(node.id);
        if (node.kind === "document" && here) {
          documents.set(node.id, node);
        }
        const nested =
          node.kind === "container" ? here : here || (covered && !takesNested);
        walk(inside(service, node), nested);
      }
    };
    walk(service.containers, false);
    return documents;
  };

  /** Rust's sync: the project's sources of the connector become the selection's. */
  const syncConnector = (projectId: string, kind: ConnectorKind) => {
    const view = selectionOf(projectId, kind);
    const now = Date.now();
    const connection = connectionOf(kind);
    if (connection.status !== "connected") {
      const revoked = connection.status === "error";
      view.sync = {
        error: revoked ? "Ключ больше не подходит" : `${kind} отключён`,
        errorKind: revoked ? "unauthorized" : "disconnected",
        lastAttemptAt: now,
        lastOkAt: view.sync?.lastOkAt ?? null,
        skipped: 0,
      };
      changed("connectorSelections", kind, projectId, "updated");
      return;
    }
    const documents = resolve(kind, view.items);
    const before = JSON.stringify(db.sources);
    db.sources = db.sources.filter(
      (source) =>
        source.projectId !== projectId ||
        source.origin?.connector !== kind ||
        documents.has(source.origin.externalId)
    );
    for (const node of documents.values()) {
      if (
        !db.sources.some(
          (source) =>
            source.projectId === projectId &&
            source.origin?.connector === kind &&
            source.origin.externalId === node.id
        )
      ) {
        created += 1;
        db.sources.push({
          ...fakeSource(`fake-source-${created}`, projectId, node.title),
          extension: "md",
          origin: {
            connector: kind,
            externalId: node.id,
            updatedAt: now,
            url: node.url,
          },
        });
      }
    }
    // The brief depends on the texts: a change makes it «мог устареть».
    const project = db.projects.find((item) => item.id === projectId);
    if (project?.brief && JSON.stringify(db.sources) !== before) {
      project.briefState = "outdated";
    }
    view.sync = {
      error: null,
      errorKind: null,
      lastAttemptAt: now,
      lastOkAt: now,
      skipped: 0,
    };
    changed("project", projectId, projectId, "updated");
  };

  /** `connector_connect_api_key` of ClickUp: the token, then the workspace. */
  const connectClickUp = (key: string, workspace: string | null) => {
    if (key.startsWith("bad")) {
      return { rejected: { field: "key", reason: "Токен не подошёл" } };
    }
    const { workspaces } = fake.clickup;
    if (workspace === null && workspaces.length > 1) {
      return { chooseWorkspace: { workspaces } };
    }
    const picked = workspaces.find(
      (item) => workspace === null || item.id === workspace
    );
    if (!picked) {
      return {
        rejected: {
          field: "key",
          reason: "Токен не открывает это пространство",
        },
      };
    }
    const view = {
      ...connectedClickUp(),
      account: {
        ...FAKE_CLICKUP_ACCOUNT,
        teamId: picked.id,
        teamName: picked.name,
      },
    };
    db.connections = db.connections.map((item) =>
      item.kind === "clickup" ? view : item
    );
    changed("connections", "clickup", null, "updated");
    return { connected: view };
  };

  const connectorCommand = (
    command: string,
    args: Record<string, unknown>
  ): unknown => {
    switch (command) {
      case "connectors_list":
        return db.connections;
      case "connector_connect_api_key": {
        const host = String(args.host);
        const key = String(args.key);
        if (args.kind === "clickup") {
          return connectClickUp(key, (args.workspace as string | null) ?? null);
        }
        if (key.startsWith("bad")) {
          return { rejected: { field: "key", reason: "Ключ не подошёл" } };
        }
        if (host.includes("nowhere")) {
          return {
            rejected: {
              field: "host",
              reason: "Не удалось подключиться к Outline",
            },
          };
        }
        const view = {
          ...connectedOutline(),
          account: { ...FAKE_OUTLINE_ACCOUNT, host: new URL(host).origin },
        };
        db.connections = db.connections.map((item) =>
          item.kind === "outline" ? view : item
        );
        changed("connections", "outline", null, "updated");
        return { connected: view };
      }
      case "connector_disconnect":
        db.connections = db.connections.map((item) =>
          item.kind === args.kind ? fakeConnector(item.kind) : item
        );
        changed("connections", String(args.kind), null, "deleted");
        return null;
      case "connector_browse": {
        const service = serviceOf(args.kind as ConnectorKind);
        const parent = args.parent as { id: string } | null;
        return parent ? (service.trees[parent.id] ?? []) : service.containers;
      }
      case "connector_selection_get": {
        const projectId = String(args.projectId);
        return SOURCE_KINDS.map((kind) => selectionOf(projectId, kind));
      }
      case "connector_selection_set": {
        const projectId = String(args.projectId);
        const kind = args.kind as ConnectorKind;
        const items = args.items as SelectionItem[];
        const count = resolve(kind, items).size;
        if (count > FAKE_LIMIT) {
          throw commandError(
            "Invalid",
            kind === "clickup"
              ? `Из ClickUp в проект загружается не больше ${FAKE_LIMIT} задач, а в выбранном ${count}. Выберите списки или отдельные задачи.`
              : `Из Outline в проект загружается не больше ${FAKE_LIMIT} документов, а в выбранном ${count}. Выберите отдельные документы.`
          );
        }
        const view = {
          ...selectionOf(projectId, kind),
          items: items.map((item) => ({
            ...item,
            otherAccount: false,
            status: "ok" as const,
            url: item.url ?? null,
          })),
        };
        db.selections = [
          ...db.selections.filter(
            (item) => item.projectId !== projectId || item.kind !== kind
          ),
          view,
        ];
        changed("connectorSelections", kind, projectId, "updated");
        syncConnector(projectId, kind);
        return view;
      }
      case "connector_sync": {
        const projectId = String(args.projectId);
        const kinds = args.kind ? [args.kind as ConnectorKind] : SOURCE_KINDS;
        for (const kind of kinds) {
          syncConnector(projectId, kind);
        }
        return null;
      }
      default:
        return undefined;
    }
  };

  const answer = (command: string, args: Record<string, unknown>): unknown => {
    if (command.startsWith("connector")) {
      return connectorCommand(command, args);
    }
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
        if (db.sources[index]?.origin) {
          throw commandError(
            "Invalid",
            "Документ Outline убирается из проекта через выбор в Outline"
          );
        }
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
      // The calls' own titles and open counts; a test sets the rest.
      case "calls_overview":
        return db.calls
          .filter(
            (call) => !args.projectId || call.projectId === args.projectId
          )
          .map(
            (call): CallOverview => ({
              audioDeleted: false,
              callId: call.id,
              openQuestions: call.openQuestions,
              pendingProposals: 0,
              projectId: call.projectId,
              title: call.title,
            })
          );
      case "settings_get":
        return db.settings;
      case "settings_update": {
        // Rust's `settings::validate`: an unknown key or value writes nothing.
        const patch = args.patch as { [key: string]: Value };
        for (const [key, value] of Object.entries(patch)) {
          const problem = settingProblem(key, value);
          if (problem) {
            throw commandError("Invalid", problem);
          }
        }
        Object.assign(db.settings, patch);
        return {
          launchAtLoginError: null,
          settings: db.settings,
          shortcutErrors: [],
        };
      }
      // The settings' system side: one microphone, every access given,
      // Claude Code found and signed in. A test answers otherwise.
      case "audio_inputs_get":
        return fake.audioInputs;
      case "audio_inputs_start":
      case "audio_inputs_stop":
      case "audio_level_start":
      case "audio_level_stop":
        return null;
      case "permissions_get":
        return {
          microphone: { message: null, state: "granted" },
          systemAudio: { message: null, state: "granted" },
        };
      case "recordings_info":
        return { bytes: 0, calls: 0, path: "/tmp/grill/recordings" };
      case "data_summary":
        return { bytes: 0, calls: 0, projects: db.projects.length };
      case "agent_status":
        return {
          email: "a@b.c",
          status: "ready",
          subscriptionType: "max",
          version: "2.1.14",
        };
      case "agent_usage":
        return null;
      case "agent_limit_get":
      case "agent_limit_refresh":
        return fake.limit;
      case "agent_limit_override":
        return null;
      case "updates_get":
        return { current: "0.3.0", state: { status: "disabled" } };
      case "calls_delete": {
        const index = db.calls.findIndex((item) => item.id === args.id);
        const [removed] = db.calls.splice(index, 1);
        if (removed) {
          changed("call", removed.id, removed.projectId, "deleted");
        }
        return null;
      }
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
      case "recording_start":
        return fake.recording.id ?? record();
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
    audioInputs: {
      devices: [
        {
          id: "Микрофон MacBook Pro",
          isDefault: true,
          name: "Микрофон MacBook Pro",
        },
      ],
      missingSince: null,
      selected: "system",
    },
    clickup: {
      containers: [],
      trees: {},
      workspaces: [{ id: "9001", name: "Pixel Agency" }],
    },
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
      if (CALL_COMMANDS.has(command)) {
        try {
          return Promise.resolve(structuredClone(callCommand(command, args)));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      const custom = answers.get(command);
      if (custom) {
        const result = custom(args);
        return result instanceof Promise
          ? result
          : Promise.resolve(structuredClone(result));
      }
      if (command === "projects_get") {
        const project = db.projects.find((item) => item.id === args.id);
        const missing: CommandError = {
          kind: "NotFound",
          message: `Проект ${args.id} не найден`,
        };
        return project
          ? Promise.resolve(structuredClone(project))
          : Promise.reject(missing);
      }
      try {
        // A copy, like a JSON round trip over the IPC.
        return Promise.resolve(structuredClone(answer(command, args)));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    invoked,
    limit: NO_LIMIT_DATA,
    listen: (event, handler) => {
      const set = handlers.get(event) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(event, set);
      return Promise.resolve(() => {
        set.delete(handler);
      });
    },
    micActivity: { app: "Zoom", busy: true, since: created },
    outline: { containers: [], trees: {} },
    recordFailure: null,
    recording: IDLE_RECORDING,
    session: IDLE_SESSION,
    setLimit: (limit) => {
      fake.limit = limit;
      emit("subscription-limit-changed", { limit });
    },
    setSession: (session) => {
      fake.session = session;
      emit("call-session-changed", { session });
    },
  };
  return fake;
}
