// Live changes for the open pages (spec «Живая раздача»): after a batch is
// stored, each event goes out as «call X of project Y changed» with its
// `seq`; the page reads the part that changed again. A page that comes back
// gives the last `seq` it saw (`Last-Event-ID`) and gets what it missed
// from the log.

import type { Envelope } from "@grill/analytics-contract";
import { Context, Effect, Layer, PubSub, type Scope } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** What an event changed, as a page watches it. */
export interface Change {
  readonly callId: string | null;
  /** The server's project, `none` for a call without one. */
  readonly projectId: string | null;
  readonly seq: number;
}

/** The entities an event names directly. */
interface Touched {
  readonly agentCallId?: string | null;
  readonly callId?: string | null;
  readonly projectLocalId?: string | null;
  readonly recordingId?: string | null;
}

export const touchedOf = (event: Envelope): Touched => {
  switch (event.kind) {
    case "project":
      return { projectLocalId: event.body.localId };
    case "call":
      return {
        callId: event.body.id,
        projectLocalId: event.body.projectLocalId,
      };
    case "recording":
      return { callId: event.body.callId, recordingId: event.body.id };
    case "refinedTranscript":
      return { recordingId: event.body.recordingId };
    case "segment":
    case "topic":
    case "card":
    case "question":
    case "questionEvent":
    case "finding":
    case "findingEvent":
      return { recordingId: event.body.recordingId };
    case "agentCall":
      return {
        callId: event.body.callId,
        projectLocalId: event.body.projectLocalId,
        recordingId: event.body.recordingId,
      };
    case "agentCallOp":
      return { agentCallId: event.body.agentCallId };
    default:
      return {};
  }
};

/** The call and the project of an event, from the projections. */
export const resolve = Effect.fnUntraced(function* (
  seq: number,
  event: Envelope
): Effect.fn.Return<Change, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const touched = touchedOf(event);
  let callId = touched.callId ?? null;
  let recordingId = touched.recordingId ?? null;
  let projectLocalId = touched.projectLocalId ?? null;
  if (touched.agentCallId) {
    const rows = yield* sql<{
      recordingId: string | null;
      callId: string | null;
      projectLocalId: string | null;
    }>`SELECT recording_id AS "recordingId", call_id AS "callId",
              project_local_id AS "projectLocalId"
         FROM agent_calls WHERE id = ${touched.agentCallId}`;
    recordingId = rows[0]?.recordingId ?? null;
    callId = rows[0]?.callId ?? null;
    projectLocalId = rows[0]?.projectLocalId ?? null;
  }
  if (!callId && recordingId) {
    const rows = yield* sql<{ callId: string | null }>`
      SELECT call_id AS "callId" FROM recordings WHERE id = ${recordingId}`;
    callId = rows[0]?.callId ?? null;
  }
  let projectId: string | null = null;
  if (callId) {
    const rows = yield* sql<{ projectLocalId: string | null }>`
      SELECT project_local_id AS "projectLocalId" FROM calls WHERE id = ${callId}`;
    const [row] = rows;
    if (row) {
      ({ projectLocalId } = row);
      projectId = "none";
    }
  }
  if (projectLocalId) {
    const rows = yield* sql<{ projectId: string }>`
      SELECT project_id::text AS "projectId" FROM local_projects WHERE local_id = ${projectLocalId}`;
    projectId = rows[0]?.projectId ?? projectId;
  }
  return { callId, projectId, seq };
});

export class Live extends Context.Service<
  Live,
  {
    publish: (changes: readonly Change[]) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<Change>,
      never,
      Scope.Scope
    >;
  }
>()("grill-analytics/Live") {
  static readonly layer = Layer.effect(
    Live,
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<Change>();
      return Live.of({
        publish: (changes) =>
          PubSub.publishAll(pubsub, changes).pipe(Effect.asVoid),
        subscribe: PubSub.subscribe(pubsub),
      });
    })
  );
}
