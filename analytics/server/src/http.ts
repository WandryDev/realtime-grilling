// The server's routes: the API, the live changes (SSE) and the web.

import type { Envelope } from "@grill/analytics-contract";
import { Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { HttpApiBuilder, HttpApiError } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { AnalyticsApi } from "./api";
import { Ingest } from "./ingest";
import { type Change, Live, resolve } from "./live";
import { Read } from "./read";

const orNotFound = <A, E, R>(effect: Effect.Effect<A | null, E, R>) =>
  effect.pipe(
    Effect.orDie,
    Effect.flatMap((found) =>
      found === null
        ? Effect.fail(new HttpApiError.NotFound())
        : Effect.succeed(found)
    )
  );

const IngestHandlers = HttpApiBuilder.group(
  AnalyticsApi,
  "ingest",
  Effect.fn(function* (handlers) {
    const ingest = yield* Ingest;
    return handlers.handle("ingest", ({ payload }) =>
      ingest.accept(payload.events).pipe(
        Effect.map((accepted) => ({ accepted })),
        Effect.orDie
      )
    );
  })
);

const ReadHandlers = HttpApiBuilder.group(
  AnalyticsApi,
  "read",
  Effect.fn(function* (handlers) {
    const read = yield* Read;
    return handlers.handleAll({
      agentCall: ({ params }) => orNotFound(read.agentCall(params.id)),
      call: ({ params }) => orNotFound(read.call(params.id)),
      finding: ({ params }) => orNotFound(read.finding(params.id)),
      project: ({ params }) => orNotFound(read.project(params.id)),
      projects: () => read.projects.pipe(Effect.orDie),
    });
  })
);

/** The most missed changes a page gets back at once. */
const REPLAY_LIMIT = 10_000;
const HEARTBEAT = "15 seconds";

/** The changes after `seq`, from the log. */
const missed = Effect.fnUntraced(function* (seq: number) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ seq: string; body: Envelope }>`
    SELECT seq::text AS seq, body FROM events WHERE seq > ${seq}
     ORDER BY seq LIMIT ${REPLAY_LIMIT}`;
  const changes: Change[] = [];
  for (const row of rows) {
    changes.push(yield* resolve(Number(row.seq), row.body));
  }
  return changes;
});

/**
 * `GET /api/live?project=<id>` or `?call=<id>`: Server-Sent Events, one
 * `change` per event of what the page watches, `id` its `seq`. With
 * `Last-Event-ID` (or `?since=`), what came after it first.
 */
export const LiveRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // Taken when the routes are built: the handler needs nothing per request.
    const live = yield* Live;
    const sql = yield* SqlClient.SqlClient;
    yield* router.add("GET", "/api/live", (request) => {
      const url = new URL(request.url, "http://localhost");
      const call = url.searchParams.get("call");
      const project = url.searchParams.get("project");
      const since = Number(
        request.headers["last-event-id"] ?? url.searchParams.get("since")
      );
      const watched = (change: Change) =>
        (call === null || change.callId === call) &&
        (project === null || change.projectId === project);
      const changes = Stream.unwrap(
        Effect.gen(function* () {
          // Subscribed before the log is read: nothing falls between them.
          const subscription = yield* live.subscribe;
          const before = Number.isFinite(since)
            ? yield* missed(since).pipe(
                Effect.provideService(SqlClient.SqlClient, sql)
              )
            : [];
          const last =
            before.at(-1)?.seq ?? (Number.isFinite(since) ? since : 0);
          return Stream.concat(
            Stream.fromIterable(before),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((change) => change.seq > last)
            )
          );
        })
      ).pipe(
        Stream.filter(watched),
        Stream.map(
          (change) =>
            `id: ${change.seq}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`
        )
      );
      const heartbeat = Stream.tick(HEARTBEAT).pipe(
        Stream.map(() => ": ping\n\n")
      );
      return Effect.succeed(
        HttpServerResponse.stream(
          Stream.concat(
            Stream.make("retry: 2000\n\n"),
            Stream.merge(changes, heartbeat)
          ).pipe(Stream.encodeText, Stream.orDie),
          {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
          }
        )
      );
    });
  })
);

/** The API and the live changes. */
export const ApiRoutes = Layer.mergeAll(
  HttpApiBuilder.layer(AnalyticsApi).pipe(
    Layer.provide([IngestHandlers, ReadHandlers])
  ),
  LiveRoute
);

/** The services the routes need, over a database. */
export const Services = Layer.mergeAll(Ingest.layer, Read.layer).pipe(
  Layer.provideMerge(Live.layer)
);
