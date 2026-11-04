-- Project notes, the brief's provenance and the project's documents
-- (projects-people-brief design.md, decisions 1, 5 and 7).
--
-- Same conventions as 0001: UUID v7 ids, times in milliseconds since the Unix
-- epoch, UTC. Existing projects get empty notes and keep their brief (NULL
-- for all of them so far) without a fingerprint.

-- What the manager wrote about the project for the agent.
ALTER TABLE projects ADD COLUMN notes TEXT NOT NULL DEFAULT '';
-- When the current `brief` was built; NULL without a brief.
ALTER TABLE projects ADD COLUMN brief_built_at INTEGER;
-- SHA-256 (hex) of the canonical JSON of the inputs the brief was built from
-- (`projects::brief_inputs`); NULL when unknown. The brief is outdated when
-- the inputs now hash differently.
ALTER TABLE projects ADD COLUMN brief_inputs TEXT;
-- 1 when the agent got shortened materials.
ALTER TABLE projects
  ADD COLUMN brief_truncated INTEGER NOT NULL DEFAULT 0 CHECK (brief_truncated IN (0, 1));

-- Documents of a project. The copy of the file lives at `stored_path`,
-- relative to the app data folder: `projects/<project_id>/sources/<id>.<ext>`.
-- Deleting the project deletes the rows; its folder goes after the commit, or
-- with the sweep at the next start. The same content is added to a project
-- once (`sha256`, hex of the file's bytes).
-- `text`: the extracted text, at most 200 000 characters (`truncated` when
-- cut), empty unless `status` is `ready`. `no_text`: nothing to read, e.g. a
-- scanned PDF. `failed`: `error` says why.
CREATE TABLE project_sources (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file')),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  extension   TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  sha256      TEXT NOT NULL CHECK (length(sha256) = 64),
  stored_path TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  text_chars  INTEGER NOT NULL DEFAULT 0 CHECK (text_chars >= 0),
  truncated   INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  status      TEXT NOT NULL CHECK (status IN ('ready', 'no_text', 'failed')),
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, sha256)
) STRICT;
