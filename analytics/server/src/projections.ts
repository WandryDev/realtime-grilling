// Applies an accepted event to the projections (call-analytics design.md,
// decision 8). A snapshot replaces what is stored only when it is not
// older (`at`), so the order the events come in does not matter; a fact
// (a step of a question or a finding, an operation, a part of a prompt) is
// kept once by its key.

import type { Envelope } from "@grill/analytics-contract";
import { Effect } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

/** What an event touched, for the pages that watch it. */
export interface Touched {
  readonly callId?: string | null;
  readonly projectLocalId?: string | null;
  readonly recordingId?: string | null;
}

/** A project's name as the projects are joined: trimmed, one space between
 * the words, lower case, «ё» as «е». */
export const normalizeName = (name: string): string =>
  name.trim().replace(/\s+/gu, " ").toLowerCase().replaceAll("ё", "е");

const json = (value: unknown): string => JSON.stringify(value ?? null);

export const apply = Effect.fnUntraced(function* (
  event: Envelope
): Effect.fn.Return<Touched, SqlError.SqlError, SqlClient.SqlClient> {
  const sql = yield* SqlClient.SqlClient;
  const { at } = event;
  switch (event.kind) {
    case "project": {
      const { localId, name } = event.body;
      const norm = normalizeName(name);
      yield* sql`
        INSERT INTO projects (norm_name, display_name, at) VALUES (${norm}, ${name}, ${at})
        ON CONFLICT (norm_name) DO UPDATE
          SET display_name = EXCLUDED.display_name, at = EXCLUDED.at
          WHERE projects.at <= EXCLUDED.at`;
      yield* sql`
        INSERT INTO local_projects (local_id, project_id, name, at)
        SELECT ${localId}, id, ${name}, ${at} FROM projects WHERE norm_name = ${norm}
        ON CONFLICT (local_id) DO UPDATE
          SET project_id = EXCLUDED.project_id, name = EXCLUDED.name, at = EXCLUDED.at
          WHERE local_projects.at <= EXCLUDED.at`;
      return { projectLocalId: localId };
    }
    case "call": {
      const call = event.body;
      yield* sql`
        INSERT INTO calls (id, project_local_id, title, status, started_at, ended_at, at)
        VALUES (${call.id}, ${call.projectLocalId}, ${call.title}, ${call.status},
                ${call.startedAt}, ${call.endedAt}, ${at})
        ON CONFLICT (id) DO UPDATE
          SET project_local_id = EXCLUDED.project_local_id, title = EXCLUDED.title,
              status = EXCLUDED.status, started_at = EXCLUDED.started_at,
              ended_at = EXCLUDED.ended_at, at = EXCLUDED.at
          WHERE calls.at <= EXCLUDED.at`;
      return { callId: call.id, projectLocalId: call.projectLocalId };
    }
    case "recording": {
      const recording = event.body;
      yield* sql`
        INSERT INTO recordings (id, call_id, status, started_at, ended_at, at)
        VALUES (${recording.id}, ${recording.callId}, ${recording.status},
                ${recording.startedAt}, ${recording.endedAt}, ${at})
        ON CONFLICT (id) DO UPDATE
          SET call_id = EXCLUDED.call_id, status = EXCLUDED.status,
              started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, at = EXCLUDED.at
          WHERE recordings.at <= EXCLUDED.at`;
      return { callId: recording.callId, recordingId: recording.id };
    }
    case "segment": {
      const segment = event.body;
      yield* sql`
        INSERT INTO segments (id, recording_id, channel, start_ms, end_ms, text)
        VALUES (${segment.id}, ${segment.recordingId}, ${segment.channel},
                ${segment.startMs}, ${segment.endMs}, ${segment.text})
        ON CONFLICT (id) DO NOTHING`;
      return { recordingId: segment.recordingId };
    }
    case "refinedTranscript": {
      const { recordingId, segments } = event.body;
      yield* sql`
        INSERT INTO refined_transcripts (recording_id, segments, at)
        VALUES (${recordingId}, ${json(segments)}::jsonb, ${at})
        ON CONFLICT (recording_id) DO UPDATE
          SET segments = EXCLUDED.segments, at = EXCLUDED.at
          WHERE refined_transcripts.at <= EXCLUDED.at`;
      return { recordingId };
    }
    case "topic": {
      const topic = event.body;
      yield* sql`
        INSERT INTO topics (id, recording_id, title, created_at, at)
        VALUES (${topic.id}, ${topic.recordingId}, ${topic.title}, ${topic.createdAt}, ${at})
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, at = EXCLUDED.at
          WHERE topics.at <= EXCLUDED.at`;
      return { recordingId: topic.recordingId };
    }
    case "card": {
      const card = event.body;
      yield* sql`
        INSERT INTO cards (id, topic_id, recording_id, fields, at)
        VALUES (${card.id}, ${card.topicId}, ${card.recordingId}, ${json(card.fields)}::jsonb, ${at})
        ON CONFLICT (id) DO UPDATE SET fields = EXCLUDED.fields, at = EXCLUDED.at
          WHERE cards.at <= EXCLUDED.at`;
      return { recordingId: card.recordingId };
    }
    case "question": {
      const q = event.body;
      yield* sql`
        INSERT INTO questions
          (id, recording_id, topic_id, text, description, card_field, gap_type, priority,
           evidence, answer_evidence, status, pinned, shown_at, created_at, at)
        VALUES (${q.id}, ${q.recordingId}, ${q.topicId}, ${q.text}, ${q.description},
                ${q.cardField}, ${q.gapType}, ${q.priority}, ${json(q.evidence)}::jsonb,
                ${json(q.answerEvidence)}::jsonb, ${q.status}, ${q.pinned}, ${q.shownAt},
                ${q.createdAt}, ${at})
        ON CONFLICT (id) DO UPDATE
          SET topic_id = EXCLUDED.topic_id, text = EXCLUDED.text,
              description = EXCLUDED.description, card_field = EXCLUDED.card_field,
              gap_type = EXCLUDED.gap_type, priority = EXCLUDED.priority,
              evidence = EXCLUDED.evidence, answer_evidence = EXCLUDED.answer_evidence,
              status = EXCLUDED.status, pinned = EXCLUDED.pinned, shown_at = EXCLUDED.shown_at,
              at = EXCLUDED.at
          WHERE questions.at <= EXCLUDED.at`;
      return { recordingId: q.recordingId };
    }
    case "questionEvent": {
      const step = event.body;
      yield* sql`
        INSERT INTO question_events (id, question_id, recording_id, step, agent_call_id, at)
        VALUES (${step.id}, ${step.questionId}, ${step.recordingId}, ${step.step},
                ${step.agentCallId}, ${step.at})
        ON CONFLICT (id) DO NOTHING`;
      return { recordingId: step.recordingId };
    }
    case "finding": {
      const f = event.body;
      yield* sql`
        INSERT INTO findings
          (id, recording_id, source_kind, source_name, source_url, chunk_key, quote, note,
           question_id, agent_call_id, created_at, hidden_at, evicted_at, at)
        VALUES (${f.id}, ${f.recordingId}, ${f.sourceKind}, ${f.sourceName}, ${f.sourceUrl},
                ${f.chunkKey}, ${f.quote}, ${f.note}, ${f.questionId}, ${f.agentCallId},
                ${f.createdAt}, ${f.hiddenAt}, ${f.evictedAt}, ${at})
        ON CONFLICT (id) DO UPDATE
          SET question_id = EXCLUDED.question_id, agent_call_id = EXCLUDED.agent_call_id,
              hidden_at = EXCLUDED.hidden_at, evicted_at = EXCLUDED.evicted_at, at = EXCLUDED.at
          WHERE findings.at <= EXCLUDED.at`;
      return { recordingId: f.recordingId };
    }
    case "findingEvent": {
      const step = event.body;
      yield* sql`
        INSERT INTO finding_events (id, finding_id, recording_id, step, at)
        VALUES (${step.id}, ${step.findingId}, ${step.recordingId}, ${step.step}, ${step.at})
        ON CONFLICT (id) DO NOTHING`;
      return { recordingId: step.recordingId };
    }
    case "promptPart": {
      const part = event.body;
      yield* sql`
        INSERT INTO prompt_parts (hash, text) VALUES (${part.hash}, ${part.text})
        ON CONFLICT (hash) DO NOTHING`;
      return {};
    }
    case "agentCall": {
      const c = event.body;
      yield* sql`
        INSERT INTO agent_calls
          (id, kind, recording_id, call_id, project_local_id, started_at, duration_ms, outcome,
           input_tokens, output_tokens, cache_read, cache_write, cost_usd, utilization, error,
           model, effort, trigger, trigger_segment_id, window_segments, findings_in_prompt,
           queries, raw_reply, reply)
        VALUES (${c.id}, ${c.kind}, ${c.recordingId}, ${c.callId}, ${c.projectLocalId},
                ${c.startedAt}, ${c.durationMs}, ${c.outcome}, ${c.inputTokens},
                ${c.outputTokens}, ${c.cacheRead}, ${c.cacheWrite}, ${c.costUsd},
                ${c.utilization}, ${c.error}, ${c.model}, ${c.effort}, ${c.trigger},
                ${c.triggerSegmentId}, ${json(c.windowSegments)}::jsonb,
                ${json(c.findingsInPrompt)}::jsonb, ${json(c.queries)}::jsonb, ${c.rawReply},
                ${json(c.reply)}::jsonb)
        ON CONFLICT (id) DO NOTHING`;
      for (const [ord, part] of c.parts.entries()) {
        yield* sql`
          INSERT INTO agent_call_parts (agent_call_id, ord, label, hash)
          VALUES (${c.id}, ${ord}, ${part.label}, ${part.hash})
          ON CONFLICT DO NOTHING`;
      }
      for (const candidate of c.candidates) {
        yield* sql`
          INSERT INTO slow_loop_candidates
            (agent_call_id, label, rank, chunk_key, source_kind, source_name, source_url,
             heading_path, text)
          VALUES (${c.id}, ${candidate.label}, ${candidate.rank}, ${candidate.chunkKey},
                  ${candidate.sourceKind}, ${candidate.sourceName}, ${candidate.sourceUrl},
                  ${candidate.headingPath}, ${candidate.text})
          ON CONFLICT DO NOTHING`;
      }
      return {
        callId: c.callId,
        projectLocalId: c.projectLocalId,
        recordingId: c.recordingId,
      };
    }
    case "agentCallOp": {
      const op = event.body;
      yield* sql`
        INSERT INTO agent_call_ops
          (agent_call_id, idx, op, body, applied, reason, subject_kind, subject_id)
        VALUES (${op.agentCallId}, ${op.idx}, ${op.op}, ${json(op.body)}::jsonb, ${op.applied},
                ${json(op.reason)}::jsonb, ${op.subjectKind}, ${op.subjectId})
        ON CONFLICT DO NOTHING`;
      const call = yield* sql<{
        recordingId: string | null;
        callId: string | null;
      }>`SELECT recording_id AS "recordingId", call_id AS "callId"
           FROM agent_calls WHERE id = ${op.agentCallId}`;
      return call[0] ?? {};
    }
    default:
      return {};
  }
});
