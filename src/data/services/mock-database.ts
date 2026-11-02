import { Clock, Context, Effect, Layer, PubSub, Stream } from "effect";

import type {
  Call,
  Change,
  DataChanged,
  Entity,
  Person,
  Project,
  Value,
} from "@/bindings";
import { BackendError } from "@/effect/tauri";

import { mockSeed } from "./mock-seed";

/*
 * The in-memory database behind every data `layerMock`. It plays the Rust
 * storage: UUID v7 ids, millisecond timestamps, cascade deletes and one
 * `DataChanged` per write. The data services share one instance, so a
 * project deleted through `ProjectsData` takes its people and calls along.
 *
 * Everything runs synchronously, which lets the stores apply a mock write
 * before the call returns (`src/data/synced-store.ts`).
 */

export interface MockTables {
  calls: Map<string, Call>;
  people: Map<string, Person>;
  projects: Map<string, Project>;
  settings: Map<string, Value>;
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

function seedTables(): MockTables {
  const seed = mockSeed();
  return {
    calls: new Map(seed.calls.map((call) => [call.id, call])),
    people: new Map(seed.people.map((person) => [person.id, person])),
    projects: new Map(seed.projects.map((project) => [project.id, project])),
    settings: storedSettings(),
  };
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
          tables.calls = seed.calls;
          tables.people = seed.people;
          tables.projects = seed.projects;
          tables.settings = new Map();
        }),
        resetCalls: Effect.sync(() => {
          tables.calls = seedTables().calls;
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
