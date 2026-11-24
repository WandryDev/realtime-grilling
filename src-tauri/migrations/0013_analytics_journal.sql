-- The agent's journal for the team's analytics (call-analytics design.md,
-- decisions 1, 2 and 5): what went into every call of Claude Code, what came
-- back, what became of each operation, what the manager did with the
-- questions and findings, and the queue of events for the analytics server.
--
-- Same conventions as 0001: UUID v7 ids, times in milliseconds since the Unix
-- epoch, UTC.
--
-- Rows that point at a call of the agent are written before the call's own
-- row, in the same savepoint (decision 1): those references are DEFERRABLE
-- INITIALLY DEFERRED, so they are checked at the commit.

-- `agent_calls` gets the calls outside a recording (the summary and the
-- proposals of a call, the brief of a project) and what went in and out.
-- SQLite can't change a CHECK or a NOT NULL in place, so the table is rebuilt
-- (as in 0010); every row is copied as it is. `context_findings` refers to
-- it by name and keeps working after the rename.
CREATE TABLE agent_calls_new (
  id                 TEXT PRIMARY KEY NOT NULL,
  -- The owner: a recording (the loops), a call (`summary`, `proposals`) or a
  -- project (`brief`). Exactly one, by `kind` (CHECK below).
  recording_id       TEXT REFERENCES recordings (id) ON DELETE CASCADE,
  call_id            TEXT REFERENCES calls (id) ON DELETE CASCADE,
  project_id         TEXT REFERENCES projects (id) ON DELETE CASCADE,
  started_at         INTEGER NOT NULL,
  duration_ms        INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome            TEXT NOT NULL
                       CHECK (outcome IN ('ok', 'empty', 'invalid', 'error', 'timeout',
                                          'rate_limited', 'not_logged_in', 'cancelled')),
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read         INTEGER,
  cache_write        INTEGER,
  cost_usd           REAL,
  -- Share of the subscription limit used, 0–1, as the CLI reported it.
  utilization        REAL,
  -- Kept for `grill-eval`: the same reasons are in `agent_call_ops`.
  rejected           TEXT NOT NULL DEFAULT '[]'
                       CHECK (json_valid(rejected) AND json_type(rejected) = 'array'),
  error              TEXT,
  created_at         INTEGER NOT NULL,
  kind               TEXT NOT NULL DEFAULT 'fastLoop'
                       CHECK (kind IN ('fastLoop', 'topicCheck', 'slowLoop',
                                       'summary', 'proposals', 'brief')),
  -- The CLI's model and effort the call ran with.
  model              TEXT,
  effort             TEXT,
  -- Why the loop ran (decision 3); NULL outside the loops. `trigger` is a
  -- keyword of SQLite, hence the `_reason`.
  trigger_reason     TEXT
                       CHECK (trigger_reason IS NULL
                              OR trigger_reason IN ('firstPhrase', 'turnEnd', 'interval',
                                                    'retry', 'manualRetry', 'haltReset',
                                                    'topicChanged')),
  -- The last phrase of the client recognized when the call started. No
  -- foreign key: the journal outlives the transcript's retention.
  trigger_segment_id TEXT,
  -- Ids of the transcript's segments that went into the prompt.
  window_segments    TEXT
                       CHECK (window_segments IS NULL
                              OR (json_valid(window_segments)
                                  AND json_type(window_segments) = 'array')),
  -- Ids of the slow loop's findings that went into the prompt, in the
  -- order it numbers them `D1…Dn`.
  findings_in_prompt TEXT
                       CHECK (findings_in_prompt IS NULL
                              OR (json_valid(findings_in_prompt)
                                  AND json_type(findings_in_prompt) = 'array')),
  -- The slow loop's search queries.
  queries            TEXT CHECK (queries IS NULL OR json_valid(queries)),
  -- The CLI's `result` event as it came, and the reply parsed from it.
  raw_reply          TEXT,
  reply              TEXT CHECK (reply IS NULL OR json_valid(reply)),
  CHECK (
    CASE
      WHEN kind IN ('fastLoop', 'topicCheck', 'slowLoop')
        THEN recording_id IS NOT NULL AND call_id IS NULL AND project_id IS NULL
      WHEN kind IN ('summary', 'proposals')
        THEN call_id IS NOT NULL AND recording_id IS NULL AND project_id IS NULL
      ELSE project_id IS NOT NULL AND recording_id IS NULL AND call_id IS NULL
    END
  )
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
CREATE INDEX agent_calls_call ON agent_calls (call_id, started_at);
CREATE INDEX agent_calls_project ON agent_calls (project_id, started_at);

-- The parts of the prompts, each text once: the calls of a recording share
-- the prompt file and most of the context. `hash`: SHA-256 of `text`, hex.
-- `text` becomes NULL when the transcript's retention clears it; the row
-- and the calls' links to it stay.
CREATE TABLE prompt_parts (
  hash       TEXT PRIMARY KEY NOT NULL,
  text       TEXT,
  bytes      INTEGER NOT NULL CHECK (bytes >= 0),
  created_at INTEGER NOT NULL
) STRICT;

-- A call's prompt, part by part, in the order it went to the CLI. `label`:
-- `file` (the prompt file), `mode`, `topics`, `card`, `questions`,
-- `findings`, `quiet`, `transcript`, `candidates`, `output`, …
CREATE TABLE agent_call_parts (
  agent_call_id TEXT NOT NULL
                  REFERENCES agent_calls (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  ord           INTEGER NOT NULL CHECK (ord >= 0),
  label         TEXT NOT NULL,
  hash          TEXT NOT NULL REFERENCES prompt_parts (hash),
  PRIMARY KEY (agent_call_id, ord)
) STRICT, WITHOUT ROWID;

CREATE INDEX agent_call_parts_hash ON agent_call_parts (hash);

-- Every operation of a call's reply, in the reply's order, and what became
-- of it. `body`: the operation as the agent returned it. `reason`: the
-- rejection (`RejectReason`, `SlowRejectReason`, the topic check's) as JSON.
-- `subject_*`: the question, topic, card or finding it created or changed;
-- a question was created by call X = an applied `addQuestion` of X with
-- `subject_id` = the question.
CREATE TABLE agent_call_ops (
  agent_call_id TEXT NOT NULL
                  REFERENCES agent_calls (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  idx           INTEGER NOT NULL CHECK (idx >= 0),
  op            TEXT NOT NULL,
  body          TEXT NOT NULL CHECK (json_valid(body)),
  applied       INTEGER NOT NULL CHECK (applied IN (0, 1)),
  reason        TEXT CHECK (reason IS NULL OR json_valid(reason)),
  subject_kind  TEXT CHECK (subject_kind IS NULL
                            OR subject_kind IN ('question', 'topic', 'card', 'finding')),
  subject_id    TEXT,
  PRIMARY KEY (agent_call_id, idx)
) STRICT, WITHOUT ROWID;

CREATE INDEX agent_call_ops_subject ON agent_call_ops (subject_id);

-- The chunks of the project's sources the slow loop showed the agent
-- (`C1…`), with their place in the search results. The source's name, kind
-- and link are a snapshot, as in `context_findings`. `text` becomes NULL with
-- the transcript's retention.
CREATE TABLE slow_loop_candidates (
  agent_call_id TEXT NOT NULL
                  REFERENCES agent_calls (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  label         TEXT NOT NULL,
  rank          INTEGER NOT NULL CHECK (rank >= 1),
  chunk_key     TEXT NOT NULL,
  source_id     TEXT REFERENCES project_sources (id) ON DELETE SET NULL,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('file', 'outline', 'clickup')),
  source_name   TEXT NOT NULL,
  source_url    TEXT,
  heading_path  TEXT,
  text          TEXT,
  PRIMARY KEY (agent_call_id, label)
) STRICT, WITHOUT ROWID;

-- What became of a question, step by step. `agent_call_id`: the call that
-- did it (`created`, `answered`); NULL for the manager's actions and for the
-- window's own `recompute` (`shown`, `requeued`, `unshown`). Who of the
-- people did it is never stored.
CREATE TABLE question_events (
  id            TEXT PRIMARY KEY NOT NULL,
  question_id   TEXT NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  recording_id  TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('created', 'shown', 'requeued', 'unshown', 'pinned',
                                  'unpinned', 'hidden', 'restored', 'asked', 'answered')),
  agent_call_id TEXT
                  REFERENCES agent_calls (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  at            INTEGER NOT NULL
) STRICT;

CREATE INDEX question_events_question ON question_events (question_id, at);
CREATE INDEX question_events_recording ON question_events (recording_id, at);

-- What became of a finding of the slow loop on the screen.
CREATE TABLE finding_events (
  id         TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES context_findings (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('shown', 'hidden', 'evicted')),
  at         INTEGER NOT NULL
) STRICT;

CREATE INDEX finding_events_finding ON finding_events (finding_id, at);

-- Events waiting to go to the analytics server (decision 5), in the order
-- they were written. `id`: UUID v7 of the event, the server's key for
-- accepting it once. `v`: the contract's version. `body`: the event's
-- snapshot as JSON. `bytes`: the size of `body`, for the queue's limit.
CREATE TABLE analytics_outbox (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  body       TEXT NOT NULL CHECK (json_valid(body)),
  bytes      INTEGER NOT NULL CHECK (bytes >= 0),
  created_at INTEGER NOT NULL
) STRICT;

-- One row. `enabled_since`: when this database first ran a version with the
-- analytics; calls and recordings created before it are never sent.
CREATE TABLE analytics_meta (
  id            INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  enabled_since INTEGER NOT NULL
) STRICT;

INSERT INTO analytics_meta (id, enabled_since)
VALUES (1, CAST(unixepoch('subsec') * 1000 AS INTEGER));
