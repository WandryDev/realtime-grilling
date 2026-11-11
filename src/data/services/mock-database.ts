import { Clock, Context, Effect, Layer, PubSub, Stream } from "effect";

import type {
  BriefState,
  Call,
  CallQuestion,
  CallRecording,
  CallSummary,
  Change,
  ConnectorKind,
  ConnectorView,
  DataChanged,
  Entity,
  Person,
  Project,
  ProjectSource,
  Proposal,
  SelectionItem,
  SummaryProgress,
  SyncState,
  Value,
} from "@/bindings";
import { charCount } from "@/data/project-limits";
import { BackendError } from "@/effect/tauri";
import {
  MOCK_OUTLINE_ACCOUNT,
  type MockOutlineCollection,
  mockOutlineCollections,
} from "./mock-outline";
import { mockSeed } from "./mock-seed";

/*
 * The in-memory database behind every data `layerMock`. It plays the Rust
 * storage: UUID v7 ids, millisecond timestamps, cascade deletes and one
 * `DataChanged` per write. The data services share one instance, so a
 * project deleted through `ProjectsData` takes its people and calls along.
 *
 * Everything runs synchronously, which lets the stores apply a mock write
 * before the call returns (`src/data/synced-store.ts`).
 *
 * The brief state of a project is computed on read, as in Rust: the
 * fingerprint of its description, notes, people and readable documents
 * against the one the brief was built from (design.md, decision 7).
 *
 * The records of a call (post-call design.md, decision 5) live in their
 * own tables, as in Rust: its recordings with their transcript, the
 * questions of those recordings, its summary and its proposals. Deleting
 * the call deletes them (`dropCallRecords`); deleting a person deletes
 * the proposals about them.
 */

/** A recording of a call, as `call_transcript` reads it. */
export interface MockRecording {
  readonly callId: string;
  readonly recording: CallRecording;
}

/** A document of a project with what the screens never see. */
export interface MockSource {
  /** Stands in for the SHA-256 of the content: the same file, the same hash. */
  readonly sha256: string;
  readonly source: ProjectSource;
}

/** A project's selection in a connector (`connector_selections`). */
export interface MockSelection {
  /** The team it was picked in: another team's items are «недоступно». */
  readonly accountRef: string;
  readonly items: SelectionItem[];
  readonly kind: ConnectorKind;
  /** Items the last sync could not find. */
  readonly missing: ReadonlySet<string>;
  readonly projectId: string;
  readonly sync: SyncState | null;
}

export interface MockTables {
  /** The fingerprint each project's brief was built from. */
  briefInputs: Map<string, string>;
  /** Projects whose brief is being built now. */
  building: Set<string>;
  calls: Map<string, Call>;
  /** The connectors' connections, as `connectors_list` gives them. */
  connections: Map<ConnectorKind, ConnectorView>;
  /** The demo Outline the connector reads. */
  outline: MockOutlineCollection[];
  people: Map<string, Person>;
  projects: Map<string, Project>;
  /** By id; `proposals_list` reads them by call. */
  proposals: Map<string, Proposal>;
  /** The questions of the recordings, by id. */
  questions: Map<string, CallQuestion>;
  recordings: Map<string, MockRecording>;
  /** By `${projectId}:${kind}`. */
  selections: Map<string, MockSelection>;
  settings: Map<string, Value>;
  sources: Map<string, MockSource>;
  /** The stored summary of a call, by call id. */
  summaries: Map<string, CallSummary>;
  /** The last progress of the summary build running for a call. */
  summaryBuilds: Map<string, SummaryProgress>;
}

/** The tables that belong to the calls: `resetCalls` seeds them again. */
const CALL_TABLES = [
  "calls",
  "proposals",
  "questions",
  "recordings",
  "summaries",
] as const;

/**
 * Deletes what belongs to a call (the `ON DELETE CASCADE` of its
 * recordings, questions, summary and proposals).
 */
export function dropCallRecords(tables: MockTables, callId: string) {
  for (const [id, { callId: owner }] of tables.recordings) {
    if (owner === callId) {
      tables.recordings.delete(id);
      for (const [questionId, question] of tables.questions) {
        if (question.recordingId === id) {
          tables.questions.delete(questionId);
        }
      }
    }
  }
  for (const [id, proposal] of tables.proposals) {
    if (proposal.callId === callId) {
      tables.proposals.delete(id);
    }
  }
  tables.summaries.delete(callId);
  tables.summaryBuilds.delete(callId);
}

/** Where the browser keeps the mock settings between reloads. */
export const MOCK_SETTINGS_KEY = "grill.settings";

function storedSettings(): Map<string, Value> {
  if (typeof window === "undefined") {
    return new Map();
  }
  try {
    const raw = window.localStorage.getItem(MOCK_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return new Map(
      parsed && typeof parsed === "object"
        ? Object.entries(parsed as { [key: string]: Value })
        : []
    );
  } catch {
    return new Map();
  }
}

/** Ids sorted as SQLite sorts TEXT. */
function byId<T extends { id: string }>(a: T, b: T) {
  return compareIds(a.id, b.id);
}

/**
 * What a project's brief is built from, as one string: the description,
 * the notes, the people by id and the hashes of the readable documents.
 * The name is not part of it: renaming leaves the brief fresh.
 */
export function briefFingerprint(tables: MockTables, projectId: string) {
  const project = tables.projects.get(projectId);
  const people = [...tables.people.values()]
    .filter((person) => person.projectId === projectId)
    .sort(byId)
    .map((person) => [person.name, person.role, person.profile]);
  const sources = [...tables.sources.values()]
    .filter(
      ({ source }) =>
        source.projectId === projectId && source.status === "ready"
    )
    .map(({ sha256 }) => sha256)
    .sort();
  return JSON.stringify([
    project?.description ?? "",
    project?.notes ?? "",
    people,
    sources,
  ]);
}

/** The brief state of a stored project, as the Rust read computes it. */
export function briefStateOf(tables: MockTables, project: Project): BriefState {
  if (tables.building.has(project.id)) {
    return "building";
  }
  if (project.brief === null) {
    return "none";
  }
  return tables.briefInputs.get(project.id) ===
    briefFingerprint(tables, project.id)
    ? "fresh"
    : "outdated";
}

const MOCK_CONNECTED_AT = Date.UTC(2026, 9, 1, 10);
const MOCK_CHECKED_AT = Date.UTC(2026, 9, 14, 9, 30);

/**
 * The demo connections: Outline connected to Pixel Agency; GitHub and
 * ClickUp connect only through their demo flows (the integrations store).
 */
export function mockConnections(): Map<ConnectorKind, ConnectorView> {
  const none = {
    account: null,
    available: true,
    capabilities: [] as ConnectorView["capabilities"],
    connectedAt: null,
    error: null,
    errorKind: null,
    lastAttemptAt: null,
    lastOkAt: null,
    status: "disconnected" as const,
  };
  return new Map<ConnectorKind, ConnectorView>([
    [
      "outline",
      {
        account: MOCK_OUTLINE_ACCOUNT,
        auth: { host: true, type: "apiKey" },
        available: true,
        capabilities: ["projectSources"],
        connectedAt: MOCK_CONNECTED_AT,
        error: null,
        errorKind: null,
        kind: "outline",
        lastAttemptAt: MOCK_CHECKED_AT,
        lastOkAt: MOCK_CHECKED_AT,
        status: "connected",
      },
    ],
    ["github", { ...none, auth: { type: "deviceCode" }, kind: "github" }],
    ["clickup", { ...none, auth: { type: "browserOAuth" }, kind: "clickup" }],
  ]);
}

function seedTables(): MockTables {
  const seed = mockSeed();
  const tables: MockTables = {
    briefInputs: new Map(),
    building: new Set(),
    calls: new Map(seed.calls.map((call) => [call.id, call])),
    connections: mockConnections(),
    outline: mockOutlineCollections(),
    people: new Map(seed.people.map((person) => [person.id, person])),
    projects: new Map(seed.projects.map((project) => [project.id, project])),
    proposals: new Map(seed.proposals.map((item) => [item.id, item])),
    questions: new Map(seed.questions.map((item) => [item.id, item])),
    recordings: new Map(
      seed.recordings.map((item) => [item.recording.id, item])
    ),
    selections: new Map(),
    settings: storedSettings(),
    sources: new Map(),
    summaries: new Map(seed.summaries.map((item) => [item.callId, item])),
    summaryBuilds: new Map(),
  };
  // The demo briefs were built from the demo records as they are.
  for (const project of seed.projects) {
    if (project.brief !== null) {
      tables.briefInputs.set(project.id, briefFingerprint(tables, project.id));
    }
  }
  return tables;
}

const HEX = 16;
const BYTE = 256;
const TIMESTAMP_BYTES = 6;
const VERSION_7 = 0x70;
const VARIANT_RFC = 0x80;
const VARIANT_RANGE = 64;

/** 12-bit counter after the timestamp: ids of one millisecond stay ordered. */
const COUNTER_RANGE = 4096;
const COUNTER_START_RANGE = 2048;
let lastMillis = -1;
let counter = 0;

/**
 * A UUID v7: 48 bits of Unix milliseconds, a 12-bit counter (random at the
 * start of each millisecond), then random bits. Ids sort in creation order,
 * like those of the `uuid` crate.
 */
export function uuidv7(now: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  if (now === lastMillis && counter < COUNTER_RANGE - 1) {
    counter += 1;
  } else {
    lastMillis = now;
    counter = (bytes[7] ?? 0) % COUNTER_START_RANGE;
  }
  let time = now;
  for (let index = TIMESTAMP_BYTES - 1; index >= 0; index -= 1) {
    bytes[index] = time % BYTE;
    time = Math.floor(time / BYTE);
  }
  // Version 7 and the counter's high nibble in byte 6, its low byte in 7,
  // variant 10xx in byte 8.
  bytes[6] = VERSION_7 + Math.floor(counter / BYTE);
  bytes[7] = counter % BYTE;
  bytes[8] = VARIANT_RFC + ((bytes[8] ?? 0) % VARIANT_RANGE);
  const hex = Array.from(bytes, (byte) => byte.toString(HEX).padStart(2, "0"));
  return [
    hex.slice(0, 4),
    hex.slice(4, 6),
    hex.slice(6, 8),
    hex.slice(8, 10),
    hex.slice(10),
  ]
    .map((part) => part.join(""))
    .join("-");
}

/** Byte order of two ids, as SQLite sorts TEXT: `ORDER BY …, id`. */
export function compareIds(a: string, b: string) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

export const notFound = (message: string) =>
  new BackendError({ kind: "NotFound", message });

export const invalid = (message: string) =>
  new BackendError({ kind: "Invalid", message });

/**
 * A nullable field of a patch: absent keeps the current value, `null`
 * clears it (the double option of the Rust patches).
 */
export function orCurrent<T>(patched: T | null | undefined, current: T | null) {
  return patched === undefined ? current : patched;
}

export const EMPTY_NAME = "Название не может быть пустым";

/** Trimmed text of at most `max` characters, or `Invalid` with `message`. */
export const limitedText = Effect.fnUntraced(function* (
  text: string,
  max: number,
  message: string
) {
  const trimmed = text.trim();
  if (charCount(trimmed) > max) {
    return yield* invalid(message);
  }
  return trimmed;
});

/** A trimmed required name, or `Invalid`. */
export const requiredName = Effect.fnUntraced(function* (name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    return yield* invalid(EMPTY_NAME);
  }
  return trimmed;
});

export class MockDatabase extends Context.Service<
  MockDatabase,
  {
    readonly tables: MockTables;
    /** Current time and a fresh UUID v7 for a new record. */
    readonly stamp: Effect.Effect<{ id: string; now: number }>;
    /** `updatedAt` of a changed record: now, and always after the last one. */
    readonly touch: (updatedAt: number) => Effect.Effect<number>;
    readonly emit: (
      entity: Entity,
      id: string,
      projectId: string | null,
      change: Change
    ) => Effect.Effect<void>;
    readonly changes: Stream.Stream<DataChanged>;
    /** Back to the demo records (tests, the dev navigator). */
    readonly reset: Effect.Effect<void>;
    /** Back to the demo calls; projects, people and settings stay. */
    readonly resetCalls: Effect.Effect<void>;
  }
>()("grill/data/services/MockDatabase") {
  static readonly layer = Layer.effect(
    MockDatabase,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<DataChanged>();
      const tables = seedTables();

      return MockDatabase.of({
        changes: Stream.fromPubSub(pubsub),
        emit: (entity, id, projectId, change) =>
          PubSub.publish(pubsub, { change, entity, id, projectId }).pipe(
            Effect.asVoid
          ),
        reset: Effect.sync(() => {
          const seed = seedTables();
          tables.briefInputs = seed.briefInputs;
          tables.building = seed.building;
          tables.connections = seed.connections;
          tables.outline = seed.outline;
          tables.selections = seed.selections;
          tables.people = seed.people;
          tables.projects = seed.projects;
          tables.settings = new Map();
          tables.sources = seed.sources;
          for (const name of CALL_TABLES) {
            Object.assign(tables, { [name]: seed[name] });
          }
          tables.summaryBuilds = seed.summaryBuilds;
        }),
        resetCalls: Effect.sync(() => {
          const seed = seedTables();
          for (const name of CALL_TABLES) {
            Object.assign(tables, { [name]: seed[name] });
          }
        }),
        stamp: Effect.map(Clock.currentTimeMillis, (now) => ({
          id: uuidv7(now),
          now,
        })),
        tables,
        touch: (updatedAt) =>
          Effect.map(Clock.currentTimeMillis, (now) =>
            Math.max(now, updatedAt + 1)
          ),
      });
    })
  );
}
