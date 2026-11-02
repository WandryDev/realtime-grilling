-- First schema of the local database (design.md, decision 10).
--
-- Ids are UUID v7 strings issued by the backend. `created_at` / `updated_at`
-- are milliseconds since the Unix epoch, UTC. Shapes the design still changes
-- (brief, person profile, card fields, call summary, question evidence) live in
-- JSON text columns until a query needs a field of them.

CREATE TABLE projects (
  id          TEXT PRIMARY KEY NOT NULL,
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  brief       TEXT CHECK (brief IS NULL OR json_valid(brief)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

-- People of the client. `profile`: how to ask, tech / project levels,
-- portrait rows, notes, the pending agent suggestion.
CREATE TABLE people (
  id         TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  role       TEXT NOT NULL DEFAULT '',
  profile    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX people_project_id ON people (project_id);

-- `summary`: summary build state, proposal and task-card reviews, recording state.
CREATE TABLE calls (
  id         TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('live', 'finishing', 'finished')),
  started_at INTEGER,
  ended_at   INTEGER,
  summary    TEXT CHECK (summary IS NULL OR json_valid(summary)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX calls_project_id ON calls (project_id);

-- A person's profile is stored once; calls point at it.
-- "Participant from the same project" is checked by the command, so the error
-- reaches the frontend as `Invalid`.
CREATE TABLE call_participants (
  call_id   TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  PRIMARY KEY (call_id, person_id)
) STRICT; -- rowid keeps the order people were added in

CREATE INDEX call_participants_person_id ON call_participants (person_id);

CREATE TABLE topics (
  id         TEXT PRIMARY KEY NOT NULL,
  call_id    TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  title      TEXT NOT NULL CHECK (length(trim(title)) > 0),
  position   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX topics_call_id ON topics (call_id, position);

-- `call_id` repeats the topic's call so a call's cards are one indexed read.
CREATE TABLE task_cards (
  id         TEXT PRIMARY KEY NOT NULL,
  topic_id   TEXT NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  call_id    TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  fields     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(fields)),
  decision   TEXT NOT NULL DEFAULT 'pending'
               CHECK (decision IN ('pending', 'accepted', 'discarded')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX task_cards_topic_id ON task_cards (topic_id);
CREATE INDEX task_cards_call_id ON task_cards (call_id);

CREATE TABLE questions (
  id         TEXT PRIMARY KEY NOT NULL,
  call_id    TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  topic_id   TEXT REFERENCES topics (id) ON DELETE SET NULL,
  card_id    TEXT REFERENCES task_cards (id) ON DELETE SET NULL,
  text       TEXT NOT NULL CHECK (length(trim(text)) > 0),
  status     TEXT NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'answered', 'dismissed')),
  priority   INTEGER NOT NULL DEFAULT 0,
  evidence   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX questions_call_id ON questions (call_id, status);
CREATE INDEX questions_topic_id ON questions (topic_id);
CREATE INDEX questions_card_id ON questions (card_id);

CREATE TABLE transcript_segments (
  id         TEXT PRIMARY KEY NOT NULL,
  call_id    TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  channel    TEXT NOT NULL CHECK (channel IN ('me', 'others')),
  start_ms   INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms     INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX transcript_segments_call_start ON transcript_segments (call_id, start_ms);

-- App preferences: key → JSON value, the keys of `SettingsValues` plus
-- `onboardingCompleted`.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK (json_valid(value))
) STRICT, WITHOUT ROWID;
