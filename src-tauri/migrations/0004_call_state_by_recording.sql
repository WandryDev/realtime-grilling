-- Topics, task cards and questions by recording (agent-fast-loop design.md,
-- decision 9).
--
-- They now belong to a recording, which may have no call yet; SQLite can't
-- drop the NOT NULL of `call_id`, so the tables are rebuilt, as 0003 did for
-- the transcript. No call was ever created, so the old tables are empty;
-- `storage::migrate` logs how many rows they had. Children go first: dropping
-- a table deletes its rows, and the foreign keys are on.

DROP TABLE questions;
DROP TABLE task_cards;
DROP TABLE topics;

-- A topic of the conversation; the agent splits the call into them.
CREATE TABLE topics (
  id           TEXT PRIMARY KEY NOT NULL,
  recording_id TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  -- The recording's call when the topic was written.
  call_id      TEXT REFERENCES calls (id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (length(trim(title)) > 0),
  -- Order within the recording, ascending.
  position     INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX topics_recording ON topics (recording_id, position);
CREATE INDEX topics_call_id ON topics (call_id);

-- The task card of a topic, one per topic. `fields`: JSON array of
-- `{ field, value, evidence, updatedAt }` in the order they were first set;
-- `field` is one of the seven lenses (`CardLens`).
CREATE TABLE task_cards (
  id           TEXT PRIMARY KEY NOT NULL,
  topic_id     TEXT NOT NULL UNIQUE REFERENCES topics (id) ON DELETE CASCADE,
  recording_id TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  call_id      TEXT REFERENCES calls (id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  fields       TEXT NOT NULL DEFAULT '[]'
                 CHECK (json_valid(fields) AND json_type(fields) = 'array'),
  decision     TEXT NOT NULL DEFAULT 'pending'
                 CHECK (decision IN ('pending', 'accepted', 'discarded')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX task_cards_recording ON task_cards (recording_id);
CREATE INDEX task_cards_call_id ON task_cards (call_id);

-- `evidence` / `answer_evidence`: JSON arrays of `{ source, id, quote }`
-- (`source`: `segment` or `project`). `shown_at`: when the question became
-- visible in the list of its topic; NULL while it waits or after it left.
CREATE TABLE questions (
  id              TEXT PRIMARY KEY NOT NULL,
  recording_id    TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  call_id         TEXT REFERENCES calls (id) ON DELETE CASCADE,
  topic_id        TEXT REFERENCES topics (id) ON DELETE SET NULL,
  card_id         TEXT REFERENCES task_cards (id) ON DELETE SET NULL,
  text            TEXT NOT NULL CHECK (length(trim(text)) > 0),
  description     TEXT NOT NULL DEFAULT '',
  -- One of the seven lenses of the task card (`CardLens`).
  card_field      TEXT
                    CHECK (card_field IS NULL
                           OR card_field IN ('goal', 'users', 'scenarios', 'edgeCases',
                                             'integrations', 'constraints', 'acceptance')),
  gap_type        TEXT NOT NULL DEFAULT 'empty'
                    CHECK (gap_type IN ('empty', 'assumption', 'contradiction')),
  -- Higher comes first.
  priority        INTEGER NOT NULL DEFAULT 0,
  evidence        TEXT NOT NULL DEFAULT '[]'
                    CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  answer_evidence TEXT
                    CHECK (answer_evidence IS NULL
                           OR (json_valid(answer_evidence)
                               AND json_type(answer_evidence) = 'array')),
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'answered', 'hidden', 'asked')),
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  shown_at        INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX questions_recording ON questions (recording_id, status);
CREATE INDEX questions_call_id ON questions (call_id, status);
CREATE INDEX questions_topic_id ON questions (topic_id);
CREATE INDEX questions_card_id ON questions (card_id);

-- When the agent started the final check (decision 8), and the topic the
-- conversation is on.
ALTER TABLE recordings ADD COLUMN final_check_at INTEGER;
ALTER TABLE recordings
  ADD COLUMN current_topic_id TEXT REFERENCES topics (id) ON DELETE SET NULL;

-- One row per agent call of the fast loop. `rejected`: JSON array of the
-- operations the checks dropped, with their reasons.
CREATE TABLE agent_calls (
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
  created_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX agent_calls_recording ON agent_calls (recording_id, started_at);
