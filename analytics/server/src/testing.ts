// What the server's tests share: the app over a fresh test database, as a
// web handler (the whole HTTP pipeline without a port), and events.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { ApiRoutes, Services } from "./http";
import { migrate } from "./migrations";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/realtime-grilling-analytics-test";

/** The test database, emptied and migrated. */
export const TestDatabase = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP SCHEMA IF EXISTS public CASCADE`;
    yield* sql`CREATE SCHEMA public`;
    yield* migrate;
  })
).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) }))
);

export interface App {
  /** Runs `effect` on the app's database. */
  readonly db: <A, E>(
    effect: Effect.Effect<A, E, SqlClient.SqlClient>
  ) => Promise<A>;
  readonly dispose: () => Promise<void>;
  readonly fetch: (request: Request) => Promise<Response>;
}

export const makeApp = async (): Promise<App> => {
  const routes = ApiRoutes.pipe(
    Layer.provide(Services),
    Layer.provide(Layer.fresh(TestDatabase)),
    Layer.provide(HttpServer.layerServices)
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, {
    disableLogger: true,
  });
  // The handler builds its layers (and empties the database) on its first
  // request.
  await handler(new Request("http://localhost/api/projects"));
  // A connection of its own to the same database.
  const db = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(
          PgClient.layer({ url: Redacted.make(TEST_DATABASE_URL) })
        )
      )
    );
  return { db, dispose, fetch: (request) => handler(request) };
};

const JSON_SUFFIX = /\.json$/u;

let counter = 0;

/** A UUID-looking id, unique in a run. */
export const newId = (): string => {
  counter += 1;
  return `0193f2a1-7c4e-7b1a-9f02-${String(Date.now() % 1_000_000).padStart(6, "0")}${String(counter).padStart(6, "0")}`;
};

/** An event of the contract, version 1. */
export const event = (kind: string, body: unknown, at = 1_795_000_000_000) => ({
  at,
  body,
  id: newId(),
  kind,
  v: 1,
});

export const post = async (app: App, events: readonly unknown[]) => {
  const response = await app.fetch(
    new Request("http://localhost/api/ingest", {
      body: JSON.stringify({ events }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  return {
    body: (await response.json()) as { accepted: string[] },
    status: response.status,
  };
};

export const get = async <T = unknown>(app: App, path: string) => {
  const response = await app.fetch(new Request(`http://localhost${path}`));
  const text = await response.text();
  return {
    body: (text ? JSON.parse(text) : null) as T,
    status: response.status,
  };
};

/** The samples of `analytics/contract/fixtures`. */
export const fixtures = (): Record<string, Record<string, unknown>> => {
  const dir = join(import.meta.dirname, "..", "..", "contract", "fixtures");
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [
        name.replace(JSON_SUFFIX, ""),
        JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
          string,
          unknown
        >,
      ])
  );
};
