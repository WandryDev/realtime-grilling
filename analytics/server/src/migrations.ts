// The server's schema (call-analytics design.md, decision 8): the log of
// every accepted event is the source of truth; the other tables are
// projections of it that `rebuild` can make again. The projections have no
// foreign keys between them: the events of a call may come in any order.
//
// Times and counts are `double precision`: whole milliseconds and tokens,
// exact far beyond what they reach, and read back as numbers.

import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE events (
      seq         bigserial PRIMARY KEY,
      id          text NOT NULL UNIQUE,
      v           integer NOT NULL,
      kind        text NOT NULL,
      at          double precision NOT NULL,
      received_at timestamptz NOT NULL DEFAULT now(),
      body        jsonb NOT NULL
    )`;
  yield* sql`
    CREATE TABLE rejected_events (
      seq         bigserial PRIMARY KEY,
      event_id    text,
      received_at timestamptz NOT NULL DEFAULT now(),
      reason      text NOT NULL,
      body        jsonb NOT NULL
    )`;
  yield* sql`
    CREATE TABLE projects (
      id           bigserial PRIMARY KEY,
      norm_name    text NOT NULL UNIQUE,
      display_name text NOT NULL,
      at           double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE local_projects (
      local_id   text PRIMARY KEY,
      project_id bigint NOT NULL,
      name       text NOT NULL,
      at         double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE calls (
      id               text PRIMARY KEY,
      project_local_id text,
      title            text NOT NULL,
      status           text NOT NULL,
      started_at       double precision,
      ended_at         double precision,
      at               double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE recordings (
      id         text PRIMARY KEY,
      call_id    text,
      status     text NOT NULL,
      started_at double precision NOT NULL,
      ended_at   double precision,
      at         double precision NOT NULL
    )`;
  yield* sql`CREATE INDEX recordings_call ON recordings (call_id)`;
  yield* sql`
    CREATE TABLE segments (
      id           text PRIMARY KEY,
      recording_id text NOT NULL,
      channel      text NOT NULL,
      start_ms     double precision NOT NULL,
      end_ms       double precision NOT NULL,
      text         text NOT NULL
    )`;
  yield* sql`CREATE INDEX segments_recording ON segments (recording_id, start_ms)`;
  yield* sql`
    CREATE TABLE refined_transcripts (
      recording_id text PRIMARY KEY,
      segments     jsonb NOT NULL,
      at           double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE topics (
      id           text PRIMARY KEY,
      recording_id text NOT NULL,
      title        text NOT NULL,
      created_at   double precision NOT NULL,
      at           double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE cards (
      id           text PRIMARY KEY,
      topic_id     text NOT NULL,
      recording_id text NOT NULL,
      fields       jsonb NOT NULL,
      at           double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE questions (
      id              text PRIMARY KEY,
      recording_id    text NOT NULL,
      topic_id        text,
      text            text NOT NULL,
      description     text NOT NULL,
      card_field      text,
      gap_type        text NOT NULL,
      priority        integer NOT NULL,
      evidence        jsonb NOT NULL,
      answer_evidence jsonb,
      status          text NOT NULL,
      pinned          boolean NOT NULL,
      shown_at        double precision,
      created_at      double precision NOT NULL,
      at              double precision NOT NULL
    )`;
  yield* sql`CREATE INDEX questions_recording ON questions (recording_id)`;
  yield* sql`
    CREATE TABLE question_events (
      id            text PRIMARY KEY,
      question_id   text NOT NULL,
      recording_id  text NOT NULL,
      step          text NOT NULL,
      agent_call_id text,
      at            double precision NOT NULL
    )`;
  yield* sql`CREATE INDEX question_events_recording ON question_events (recording_id, at)`;
  yield* sql`
    CREATE TABLE findings (
      id            text PRIMARY KEY,
      recording_id  text NOT NULL,
      source_kind   text NOT NULL,
      source_name   text NOT NULL,
      source_url    text,
      chunk_key     text NOT NULL,
      quote         text NOT NULL,
      note          text NOT NULL,
      question_id   text,
      agent_call_id text,
      created_at    double precision NOT NULL,
      hidden_at     double precision,
      evicted_at    double precision,
      at            double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE finding_events (
      id           text PRIMARY KEY,
      finding_id   text NOT NULL,
      recording_id text NOT NULL,
      step         text NOT NULL,
      at           double precision NOT NULL
    )`;
  yield* sql`
    CREATE TABLE prompt_parts (
      hash text PRIMARY KEY,
      text text NOT NULL
    )`;
  yield* sql`
    CREATE TABLE agent_calls (
      id                 text PRIMARY KEY,
      kind               text NOT NULL,
      recording_id       text,
      call_id            text,
      project_local_id   text,
      started_at         double precision NOT NULL,
      duration_ms        double precision NOT NULL,
      outcome            text NOT NULL,
      input_tokens       double precision,
      output_tokens      double precision,
      cache_read         double precision,
      cache_write        double precision,
      cost_usd           double precision,
      utilization        double precision,
      error              text,
      model              text,
      effort             text,
      trigger            text,
      trigger_segment_id text,
      window_segments    jsonb,
      findings_in_prompt jsonb,
      queries            jsonb,
      raw_reply          text,
      reply              jsonb
    )`;
  yield* sql`CREATE INDEX agent_calls_recording ON agent_calls (recording_id, started_at)`;
  yield* sql`
    CREATE TABLE agent_call_parts (
      agent_call_id text NOT NULL,
      ord           integer NOT NULL,
      label         text NOT NULL,
      hash          text NOT NULL,
      PRIMARY KEY (agent_call_id, ord)
    )`;
  yield* sql`
    CREATE TABLE slow_loop_candidates (
      agent_call_id text NOT NULL,
      label         text NOT NULL,
      rank          integer NOT NULL,
      chunk_key     text NOT NULL,
      source_kind   text NOT NULL,
      source_name   text NOT NULL,
      source_url    text,
      heading_path  text,
      text          text NOT NULL,
      PRIMARY KEY (agent_call_id, label)
    )`;
  yield* sql`
    CREATE TABLE agent_call_ops (
      agent_call_id text NOT NULL,
      idx           integer NOT NULL,
      op            text NOT NULL,
      body          jsonb NOT NULL,
      applied       boolean NOT NULL,
      reason        jsonb,
      subject_kind  text,
      subject_id    text,
      PRIMARY KEY (agent_call_id, idx)
    )`;
  yield* sql`CREATE INDEX agent_call_ops_subject ON agent_call_ops (subject_id)`;
});

/** The projection tables, in the order `rebuild` empties them. */
export const PROJECTIONS = [
  "projects",
  "local_projects",
  "calls",
  "recordings",
  "segments",
  "refined_transcripts",
  "topics",
  "cards",
  "questions",
  "question_events",
  "findings",
  "finding_events",
  "prompt_parts",
  "agent_calls",
  "agent_call_parts",
  "slow_loop_candidates",
  "agent_call_ops",
] as const;

/** Brings the database to this build's schema. */
export const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_initial": initial,
  }),
});
