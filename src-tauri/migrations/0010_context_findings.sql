-- The slow loop (agent-slow-loop design.md, decision 5): what it found in the
-- project's sources during a recording, and its calls in the journal.
--
-- Same conventions as 0001: UUID v7 ids, times in milliseconds since the Unix
-- epoch, UTC.

-- `agent_calls.kind` takes `slowLoop`. SQLite can't change a CHECK in place,
-- so the table is rebuilt (as `project_sources` in 0009); every row is copied
-- as it is. Nothing referred to it by a foreign key before this migration.
CREATE TABLE agent_calls_new (
  id            TEXT PRIMARY KEY NOT NULL,
  recording_id  TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL,
  duration_ms   INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome       TEXT NOT NULL
                  CHECK (outcome IN ('ok', 'empty', 'invalid', 'error', 'timeout',
                                     'rate_limited', 'not_logged_in', 'cancelled')),
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_read    INTEGER,
  cache_write   INTEGER,
  cost_usd      REAL,
  -- Share of the subscription limit used, 0–1, as the CLI reported it.
  utilization   REAL,
  rejected      TEXT NOT NULL DEFAULT '[]'
                  CHECK (json_valid(rejected) AND json_type(rejected) = 'array'),
  error         TEXT,
  created_at    INTEGER NOT NULL,
  -- `fastLoop`: the call that patches the call's state; `topicCheck`: the
  -- short call that asks whether the topic changed; `slowLoop`: the search
  -- in the project's sources.
  kind          TEXT NOT NULL DEFAULT 'fastLoop'
                  CHECK (kind IN ('fastLoop', 'topicCheck', 'slowLoop'))
) STRICT;

INSERT INTO agent_calls_new
  (id, recording_id, started_at, duration_ms, outcome, input_tokens, output_tokens,
   cache_read, cache_write, cost_usd, utilization, rejected, error, created_at, kind)
SELECT id, recording_id, started_at, duration_ms, outcome, input_tokens, output_tokens,
       cache_read, cache_write, cost_usd, utilization, rejected, error, created_at, kind
  FROM agent_calls;

DROP TABLE agent_calls;

ALTER TABLE agent_calls_new RENAME TO agent_calls;

CREATE INDEX agent_calls_recording ON agent_calls (recording_id, started_at);

-- A finding of the slow loop: a quote of a chunk of a project's source with
-- a line of what it is about. The source's name, kind and link are a
-- snapshot: the finding stays as it was when the source is synced again or
-- removed (`source_id` then becomes NULL). `chunk_key`: `<source id>#<n>`,
-- the chunk of the index it was found in. `quote`: in the source's own
-- spelling. `question_id`: the open question it is about, or the first new
-- question that cited it. `hidden_at`: the manager removed it; `evicted_at`:
-- a newer finding took its place over the limit of visible ones.
CREATE TABLE context_findings (
  id            TEXT PRIMARY KEY NOT NULL,
  recording_id  TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  source_id     TEXT REFERENCES project_sources (id) ON DELETE SET NULL,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('file', 'outline', 'clickup')),
  source_name   TEXT NOT NULL,
  source_url    TEXT,
  chunk_key     TEXT NOT NULL,
  quote         TEXT NOT NULL,
  note          TEXT NOT NULL,
  question_id   TEXT REFERENCES questions (id) ON DELETE SET NULL,
  agent_call_id TEXT REFERENCES agent_calls (id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL,
  hidden_at     INTEGER,
  evicted_at    INTEGER
) STRICT;

CREATE INDEX context_findings_recording ON context_findings (recording_id, created_at);
