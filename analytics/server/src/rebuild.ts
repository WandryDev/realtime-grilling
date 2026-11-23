// `rebuild` (call-analytics design.md, decision 8): the projections made
// again from the log, in the order the events were stored. A change of the
// projections' schema runs it; the log is never touched.

import type { Envelope } from "@grill/analytics-contract";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PROJECTIONS } from "./migrations";
import { apply } from "./projections";

const BATCH = 1000;

export const rebuild = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql.unsafe(`TRUNCATE ${PROJECTIONS.join(", ")} RESTART IDENTITY`);
      let after = 0;
      let count = 0;
      let rows: readonly { seq: string; body: Envelope }[] = [];
      do {
        rows = yield* sql<{ seq: string; body: Envelope }>`
          SELECT seq::text AS seq, body FROM events WHERE seq > ${after}
           ORDER BY seq LIMIT ${BATCH}`;
        for (const row of rows) {
          yield* apply(row.body);
          after = Number(row.seq);
          count += 1;
        }
      } while (rows.length > 0);
      return count;
    })
  );
});
