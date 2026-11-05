-- A call without a project (call-lifecycle design.md, decision 3).
--
-- SQLite can't drop the NOT NULL of `calls.project_id`, so the table is
-- rebuilt: copied into a new one, dropped, the new one renamed. The calls of
-- a project still go with it (`ON DELETE CASCADE`). `storage::migrate`
-- turns the foreign keys off around the migrations, as rusqlite_migration
-- asks: with them on, dropping `calls` would delete the participants,
-- recordings, transcript, topics, cards and questions of every call. The
-- tables that refer to `calls` keep referring to it by name, so they point
-- at the new table after the rename; the foreign keys are checked before
-- the migration commits (`foreign_key_check`).

CREATE TABLE calls_new (
  id         TEXT PRIMARY KEY NOT NULL,
  -- NULL: a call without a project.
  project_id TEXT REFERENCES projects (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL CHECK (status IN ('live', 'finishing', 'finished')),
  started_at INTEGER,
  ended_at   INTEGER,
  summary    TEXT CHECK (summary IS NULL OR json_valid(summary)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

INSERT INTO calls_new
  (id, project_id, title, status, started_at, ended_at, summary, created_at, updated_at)
SELECT id, project_id, title, status, started_at, ended_at, summary, created_at, updated_at
  FROM calls;

DROP TABLE calls;

ALTER TABLE calls_new RENAME TO calls;

CREATE INDEX calls_project_id ON calls (project_id);
