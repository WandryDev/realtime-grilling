// What the web reads (spec `analytics-web`): aggregates over the
// projections. A call belongs to a project through its local project
// (`local_projects`), so a rename in Grill moves its calls with no rewrite;
// a call without one, or whose project hasn't arrived yet, is «Без проекта».

import { Context, Effect, Layer } from "effect";
import { SqlClient, type SqlError, type Statement } from "effect/sql";
import type {
  AgentCallDetails,
  AgentCallOp,
  AgentCallSummary,
  CallTimeline,
  FindingDetails,
  KindCost,
  ProjectListItem,
  ProjectSummary,
} from "./api";

type Of<S> = S extends { readonly Type: infer T } ? T : never;

/** The name of the calls without a project. */
export const NO_PROJECT = "Без проекта";
export const NO_PROJECT_ID = "none";

const kinds = [
  "fastLoop",
  "topicCheck",
  "slowLoop",
  "summary",
  "proposals",
] as const;

export class Read extends Context.Service<
  Read,
  {
    readonly projects: Effect.Effect<
      readonly Of<typeof ProjectListItem>[],
      SqlError.SqlError
    >;
    project: (
      id: string
    ) => Effect.Effect<Of<typeof ProjectSummary> | null, SqlError.SqlError>;
    call: (
      id: string
    ) => Effect.Effect<Of<typeof CallTimeline> | null, SqlError.SqlError>;
    agentCall: (
      id: string
    ) => Effect.Effect<Of<typeof AgentCallDetails> | null, SqlError.SqlError>;
    finding: (
      id: string
    ) => Effect.Effect<Of<typeof FindingDetails> | null, SqlError.SqlError>;
  }
>()("grill-analytics/Read") {
  static readonly layer = Layer.effect(
    Read,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      /** The server project of each call: `none` without one. */
      const callProject = sql`
        SELECT c.id AS call_id,
               coalesce(lp.project_id::text, ${NO_PROJECT_ID}) AS project_id
          FROM calls c LEFT JOIN local_projects lp ON lp.local_id = c.project_local_id`;

      /** The agent calls of each call: its recordings' and its own. */
      const callAgentCalls = sql`
        SELECT a.*, coalesce(a.call_id, r.call_id) AS owner_call
          FROM agent_calls a LEFT JOIN recordings r ON r.id = a.recording_id`;

      const projects = Effect.gen(function* () {
        const rows = yield* sql<{
          id: string;
          name: string | null;
          calls: number;
          costUsd: number | null;
          live: boolean;
          lastCallAt: number | null;
        }>`
          WITH cp AS (${callProject}),
               cost AS (SELECT owner_call, sum(cost_usd) AS cost FROM (${callAgentCalls}) x
                         GROUP BY owner_call)
          SELECT cp.project_id AS id, p.display_name AS name,
                 count(*)::float8 AS calls,
                 coalesce(sum(cost.cost), 0)::float8 AS "costUsd",
                 bool_or(c.status = 'live') AS live,
                 max(c.started_at) AS "lastCallAt"
            FROM calls c JOIN cp ON cp.call_id = c.id
            LEFT JOIN projects p ON p.id::text = cp.project_id
            LEFT JOIN cost ON cost.owner_call = c.id
           GROUP BY cp.project_id, p.display_name
           ORDER BY max(c.started_at) DESC NULLS LAST`;
        return rows.map((row) => ({
          ...row,
          costUsd: row.costUsd ?? 0,
          name: row.name ?? NO_PROJECT,
        }));
      });

      const kindCost = (
        row: Partial<Of<typeof KindCost>> & { kind: string }
      ) => ({
        cacheRead: row.cacheRead ?? 0,
        cacheWrite: row.cacheWrite ?? 0,
        calls: row.calls ?? 0,
        costUsd: row.costUsd ?? 0,
        inputTokens: row.inputTokens ?? 0,
        kind: row.kind,
        outputTokens: row.outputTokens ?? 0,
      });

      const costColumns = sql`
        count(*)::float8 AS calls,
        coalesce(sum(cost_usd), 0)::float8 AS "costUsd",
        coalesce(sum(input_tokens), 0)::float8 AS "inputTokens",
        coalesce(sum(output_tokens), 0)::float8 AS "outputTokens",
        coalesce(sum(cache_read), 0)::float8 AS "cacheRead",
        coalesce(sum(cache_write), 0)::float8 AS "cacheWrite"`;

      const project = Effect.fn("Read.project")(function* (id: string) {
        const name =
          id === NO_PROJECT_ID
            ? NO_PROJECT
            : (yield* sql<{ name: string }>`
                SELECT display_name AS name FROM projects WHERE id::text = ${id}`)[0]
                ?.name;
        if (name === undefined) {
          return null;
        }
        const calls = yield* sql<Of<typeof ProjectSummary>["calls"][number]>`
          WITH cp AS (${callProject}), ac AS (${callAgentCalls})
          SELECT c.id, c.title, c.status, c.started_at AS "startedAt", c.ended_at AS "endedAt",
                 coalesce((SELECT sum(cost_usd) FROM ac WHERE ac.owner_call = c.id), 0)::float8
                   AS "costUsd",
                 (SELECT count(*) FROM ac WHERE ac.owner_call = c.id)::float8 AS "agentCalls",
                 (SELECT count(*) FROM ac WHERE ac.owner_call = c.id
                     AND ac.outcome NOT IN ('ok', 'empty'))::float8 AS failures
            FROM calls c JOIN cp ON cp.call_id = c.id
           WHERE cp.project_id = ${id}
           ORDER BY c.started_at DESC NULLS LAST`;
        const callIds = calls.map((row) => row.id);
        const byKind = yield* sql<Of<typeof KindCost>>`
          WITH ac AS (${callAgentCalls})
          SELECT kind, ${costColumns} FROM ac
           WHERE owner_call IN ${sql.in(callIds.length > 0 ? callIds : [""])}
           GROUP BY kind`;
        const brief = yield* sql<Of<typeof KindCost>>`
          SELECT 'brief' AS kind, ${costColumns} FROM agent_calls a
            JOIN local_projects lp ON lp.local_id = a.project_local_id
           WHERE a.kind = 'brief' AND lp.project_id::text = ${id}`;
        const recordings = sql`
          SELECT id FROM recordings
           WHERE call_id IN ${sql.in(callIds.length > 0 ? callIds : [""])}`;
        const steps = yield* sql<{ step: string; questions: number }>`
          SELECT step, count(DISTINCT question_id)::float8 AS questions
            FROM question_events WHERE recording_id IN (${recordings})
           GROUP BY step`;
        const count = (step: string) =>
          steps.find((row) => row.step === step)?.questions ?? 0;
        const sources = yield* sql<
          Of<typeof ProjectSummary>["sources"][number]
        >`
          WITH cand AS (
                 SELECT s.source_kind, s.source_name, max(s.source_url) AS source_url,
                        count(*)::float8 AS candidates
                   FROM slow_loop_candidates s JOIN agent_calls a ON a.id = s.agent_call_id
                  WHERE a.recording_id IN (${recordings})
                  GROUP BY s.source_kind, s.source_name),
               found AS (
                 SELECT source_kind, source_name, max(source_url) AS source_url,
                        count(*)::float8 AS findings,
                        count(*) FILTER (WHERE question_id IS NOT NULL)::float8 AS grounds
                   FROM findings WHERE recording_id IN (${recordings})
                  GROUP BY source_kind, source_name)
          SELECT coalesce(cand.source_kind, found.source_kind) AS "sourceKind",
                 coalesce(cand.source_name, found.source_name) AS "sourceName",
                 coalesce(found.source_url, cand.source_url) AS "sourceUrl",
                 coalesce(cand.candidates, 0)::float8 AS candidates,
                 coalesce(found.findings, 0)::float8 AS findings,
                 coalesce(found.grounds, 0)::float8 AS grounds
            FROM cand FULL JOIN found
              ON found.source_kind = cand.source_kind AND found.source_name = cand.source_name
           ORDER BY grounds DESC, findings DESC, candidates DESC`;
        return {
          brief: kindCost(brief[0] ?? { kind: "brief" }),
          calls,
          costByKind: kinds.map((kind) =>
            kindCost(byKind.find((row) => row.kind === kind) ?? { kind })
          ),
          id,
          name,
          questions: {
            answered: count("answered"),
            asked: count("asked"),
            created: count("created"),
            hidden: count("hidden"),
            pinned: count("pinned"),
            restored: count("restored"),
            shown: count("shown"),
          },
          sources,
        };
      });

      const summaries = Effect.fnUntraced(function* (
        where: Statement.Fragment
      ) {
        const calls = yield* sql<Omit<Of<typeof AgentCallSummary>, "ops">>`
          SELECT a.id, a.kind, a.recording_id AS "recordingId", a.started_at AS "startedAt",
                 a.duration_ms AS "durationMs", a.outcome, a.input_tokens AS "inputTokens",
                 a.output_tokens AS "outputTokens", a.cache_read AS "cacheRead",
                 a.cache_write AS "cacheWrite", a.cost_usd AS "costUsd", a.error, a.trigger,
                 a.trigger_segment_id AS "triggerSegmentId",
                 a.window_segments AS "windowSegments",
                 a.findings_in_prompt AS "findingsInPrompt",
                 coalesce((SELECT sum(length(t.text)) FROM agent_call_parts p
                             JOIN prompt_parts t ON t.hash = p.hash
                            WHERE p.agent_call_id = a.id), 0)::float8 AS "promptBytes"
            FROM agent_calls a WHERE ${where}
           ORDER BY a.started_at, a.id`;
        const ids = calls.map((row) => row.id);
        const ops = yield* sql<
          Of<typeof AgentCallOp> & { agentCallId: string }
        >`
          SELECT agent_call_id AS "agentCallId", idx::float8 AS idx, op, applied, reason,
                 subject_kind AS "subjectKind", subject_id AS "subjectId"
            FROM agent_call_ops
           WHERE agent_call_id IN ${sql.in(ids.length > 0 ? ids : [""])}
           ORDER BY agent_call_id, idx`;
        return calls.map((summary) => ({
          ...summary,
          ops: ops
            .filter((op) => op.agentCallId === summary.id)
            .map(({ agentCallId: _, ...op }) => op),
        }));
      });

      const call = Effect.fn("Read.call")(function* (id: string) {
        const head = yield* sql<Of<typeof CallTimeline>["call"]>`
          WITH cp AS (${callProject})
          SELECT c.id, c.title, c.status, c.started_at AS "startedAt", c.ended_at AS "endedAt",
                 cp.project_id AS "projectId",
                 coalesce(p.display_name, ${NO_PROJECT}) AS "projectName"
            FROM calls c JOIN cp ON cp.call_id = c.id
            LEFT JOIN projects p ON p.id::text = cp.project_id
           WHERE c.id = ${id}`;
        if (!head[0]) {
          return null;
        }
        const recordings = yield* sql<
          Of<typeof CallTimeline>["recordings"][number]
        >`
          SELECT r.id, r.status, r.started_at AS "startedAt", r.ended_at AS "endedAt",
                 (t.recording_id IS NOT NULL) AS refined
            FROM recordings r LEFT JOIN refined_transcripts t ON t.recording_id = r.id
           WHERE r.call_id = ${id} ORDER BY r.started_at`;
        const recordingIds = recordings.map((recording) => recording.id);
        const inRecordings = sql.in(
          recordingIds.length > 0 ? recordingIds : [""]
        );
        const live = yield* sql<Of<typeof CallTimeline>["segments"][number]>`
          SELECT id, recording_id AS "recordingId", channel, start_ms AS "startMs",
                 end_ms AS "endMs", text
            FROM segments WHERE recording_id IN ${inRecordings}
              AND recording_id NOT IN (SELECT recording_id FROM refined_transcripts)
           ORDER BY recording_id, start_ms`;
        const refined = yield* sql<{
          recordingId: string;
          segments: readonly Record<string, unknown>[];
        }>`
          SELECT recording_id AS "recordingId", segments FROM refined_transcripts
           WHERE recording_id IN ${inRecordings}`;
        const segments = [
          ...live,
          ...refined.flatMap(({ recordingId, segments: list }) =>
            list.map((segment) => ({
              channel: String(segment.channel),
              endMs: Number(segment.endMs),
              id: String(segment.id),
              recordingId,
              startMs: Number(segment.startMs),
              text: String(segment.text),
            }))
          ),
        ];
        const topics = yield* sql<Of<typeof CallTimeline>["topics"][number]>`
          SELECT id, recording_id AS "recordingId", title, created_at AS "createdAt"
            FROM topics WHERE recording_id IN ${inRecordings} ORDER BY created_at`;
        const cards = yield* sql<Of<typeof CallTimeline>["cards"][number]>`
          SELECT id, topic_id AS "topicId", fields FROM cards
           WHERE recording_id IN ${inRecordings}`;
        const questions = yield* sql<
          Of<typeof CallTimeline>["questions"][number]
        >`
          SELECT id, recording_id AS "recordingId", topic_id AS "topicId", text, description,
                 card_field AS "cardField", gap_type AS "gapType", priority::float8 AS priority,
                 evidence, answer_evidence AS "answerEvidence", status, pinned,
                 shown_at AS "shownAt", created_at AS "createdAt"
            FROM questions WHERE recording_id IN ${inRecordings} ORDER BY created_at`;
        const questionSteps = yield* sql<
          Of<typeof CallTimeline>["questionSteps"][number]
        >`
          SELECT id, question_id AS "subjectId", step, agent_call_id AS "agentCallId", at
            FROM question_events WHERE recording_id IN ${inRecordings} ORDER BY at, id`;
        const findings = yield* sql<
          Of<typeof CallTimeline>["findings"][number]
        >`
          SELECT id, recording_id AS "recordingId", source_kind AS "sourceKind",
                 source_name AS "sourceName", source_url AS "sourceUrl", quote, note,
                 question_id AS "questionId", agent_call_id AS "agentCallId",
                 created_at AS "createdAt", hidden_at AS "hiddenAt", evicted_at AS "evictedAt"
            FROM findings WHERE recording_id IN ${inRecordings} ORDER BY created_at`;
        const findingSteps = yield* sql<
          Of<typeof CallTimeline>["findingSteps"][number]
        >`
          SELECT id, finding_id AS "subjectId", step, NULL AS "agentCallId", at
            FROM finding_events WHERE recording_id IN ${inRecordings} ORDER BY at, id`;
        const agentCalls = yield* summaries(
          sql`(a.recording_id IN ${inRecordings} OR a.call_id = ${id})`
        );
        return {
          agentCalls,
          call: head[0],
          cards,
          costUsd: agentCalls.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
          findingSteps,
          findings,
          questionSteps,
          questions,
          recordings,
          segments,
          topics,
        };
      });

      const agentCall = Effect.fn("Read.agentCall")(function* (id: string) {
        const [summary] = yield* summaries(sql`a.id = ${id}`);
        if (!summary) {
          return null;
        }
        const [extra] = yield* sql<{
          model: string | null;
          effort: string | null;
          queries: unknown;
          rawReply: string | null;
          reply: unknown;
        }>`SELECT model, effort, queries, raw_reply AS "rawReply", reply
             FROM agent_calls WHERE id = ${id}`;
        const parts = yield* sql<Of<typeof AgentCallDetails>["parts"][number]>`
          SELECT p.label, p.hash, t.text FROM agent_call_parts p
            LEFT JOIN prompt_parts t ON t.hash = p.hash
           WHERE p.agent_call_id = ${id} ORDER BY p.ord`;
        const candidates = yield* sql<
          Of<typeof AgentCallDetails>["candidates"][number]
        >`
          SELECT label, rank::float8 AS rank, source_kind AS "sourceKind",
                 source_name AS "sourceName", source_url AS "sourceUrl",
                 heading_path AS "headingPath", text
            FROM slow_loop_candidates WHERE agent_call_id = ${id} ORDER BY rank`;
        return {
          call: summary,
          candidates,
          effort: extra?.effort ?? null,
          model: extra?.model ?? null,
          parts,
          queries: extra?.queries ?? null,
          rawReply: extra?.rawReply ?? null,
          reply: extra?.reply ?? null,
        };
      });

      const finding = Effect.fn("Read.finding")(function* (id: string) {
        const [row] = yield* sql<Of<typeof FindingDetails>["finding"]>`
          SELECT id, recording_id AS "recordingId", source_kind AS "sourceKind",
                 source_name AS "sourceName", source_url AS "sourceUrl", quote, note,
                 question_id AS "questionId", agent_call_id AS "agentCallId",
                 created_at AS "createdAt", hidden_at AS "hiddenAt", evicted_at AS "evictedAt"
            FROM findings WHERE id = ${id}`;
        if (!row) {
          return null;
        }
        const steps = yield* sql<Of<typeof FindingDetails>["steps"][number]>`
          SELECT id, finding_id AS "subjectId", step, NULL AS "agentCallId", at
            FROM finding_events WHERE finding_id = ${id} ORDER BY at, id`;
        const givenTo = yield* sql<{ id: string }>`
          SELECT id FROM agent_calls
           WHERE findings_in_prompt @> ${JSON.stringify([id])}::jsonb ORDER BY started_at`;
        const citedBy = yield* sql<{ id: string }>`
          SELECT id FROM questions
           WHERE evidence @> ${JSON.stringify([{ id }])}::jsonb ORDER BY created_at`;
        return {
          citedBy: citedBy.map((question) => question.id),
          finding: row,
          givenTo: givenTo.map((given) => given.id),
          steps,
        };
      });

      return Read.of({ agentCall, call, finding, project, projects });
    })
  );
}
