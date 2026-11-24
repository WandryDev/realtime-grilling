// The intake of Grill's events (spec «Приём событий ровно один раз»,
// «Версии контракта»). A batch is one transaction: each new event goes to
// the log and to the projections; a repeated one changes nothing; one that
// doesn't fit the contract (unknown version, wrong shape, a field the
// contract doesn't have — the manager's name, say) is kept apart with the
// reason. All of them are acknowledged, and only after the commit, so
// Grill's queue never sticks.

import { Envelope, VERSION } from "@grill/analytics-contract";
import { Context, Effect, Exit, Layer, Predicate, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { type Change, Live, resolve } from "./live";
import { apply } from "./projections";

const decode = Schema.decodeUnknownExit(Envelope, {
  onExcessProperty: "error",
});

/** The versions the server takes: this one and the one before. */
const VERSIONS = new Set([VERSION, VERSION - 1]);

/** Why an event is set aside, or `undefined` when it fits. */
const check = (raw: unknown): { event: Envelope } | { reason: string } => {
  if (
    !(Predicate.isObject(raw) && "v" in raw && VERSIONS.has(raw.v as number))
  ) {
    return { reason: "unknown version" };
  }
  const decoded = decode(raw);
  if (Exit.isFailure(decoded)) {
    return { reason: String(decoded.cause) };
  }
  return { event: decoded.value };
};

export class Ingest extends Context.Service<
  Ingest,
  {
    /** Stores a batch; the ids of the events taken. */
    accept: (
      events: readonly unknown[]
    ) => Effect.Effect<readonly string[], SqlError.SqlError>;
  }
>()("grill-analytics/Ingest") {
  static readonly layer = Layer.effect(
    Ingest,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const live = yield* Live;

      const store = Effect.fnUntraced(function* (events: readonly unknown[]) {
        const accepted: string[] = [];
        const changes: Change[] = [];
        for (const raw of events) {
          const id =
            Predicate.isObject(raw) && "id" in raw && Predicate.isString(raw.id)
              ? raw.id
              : null;
          const checked = check(raw);
          if ("reason" in checked) {
            yield* sql`
              INSERT INTO rejected_events (event_id, reason, body)
              VALUES (${id}, ${checked.reason}, ${JSON.stringify(raw ?? null)}::jsonb)`;
          } else {
            const { event } = checked;
            const inserted = yield* sql<{ seq: string }>`
              INSERT INTO events (id, v, kind, at, body)
              VALUES (${event.id}, ${event.v}, ${event.kind}, ${event.at},
                      ${JSON.stringify(event)}::jsonb)
              ON CONFLICT (id) DO NOTHING
              RETURNING seq::text AS seq`;
            if (inserted[0]) {
              yield* apply(event);
              changes.push(yield* resolve(Number(inserted[0].seq), event));
            }
          }
          if (id) {
            accepted.push(id);
          }
        }
        return { accepted, changes };
      });

      const accept = Effect.fn("Ingest.accept")(function* (
        events: readonly unknown[]
      ) {
        const { accepted, changes } = yield* sql
          .withTransaction(store(events))
          .pipe(Effect.provideService(SqlClient.SqlClient, sql));
        yield* live.publish(changes);
        return accepted;
      });

      return Ingest.of({ accept });
    })
  );
}
