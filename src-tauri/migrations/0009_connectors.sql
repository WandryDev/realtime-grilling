-- Connectors (connectors-outline design.md, decision 3): one connection per
-- service, a project's selection in a connector, the state of its last sync,
-- and documents of a connector among the project's sources.
--
-- Same conventions as 0001: UUID v7 ids, times in milliseconds since the Unix
-- epoch, UTC. Secrets (API keys, tokens) are never here: they live in the
-- OS store (Keychain, Credential Manager).

-- One row per connected service; no row: not connected. Deleting it
-- (disconnecting) leaves the projects' selections and sources alone.
-- `account`: JSON of what the service says about the key's owner (for
-- Outline: the address, the team's id and name, the user). `status`
-- `error`: the service refused the key (`unauthorized`, `forbidden`); a
-- network failure keeps `connected` and only sets `error_kind`,
-- `error` and `last_attempt_at`.
CREATE TABLE connections (
  kind            TEXT PRIMARY KEY NOT NULL CHECK (kind IN ('outline', 'github', 'clickup')),
  status          TEXT NOT NULL CHECK (status IN ('connected', 'error')),
  account         TEXT NOT NULL CHECK (json_valid(account)),
  connected_at    INTEGER NOT NULL,
  last_ok_at      INTEGER,
  last_attempt_at INTEGER,
  error_kind      TEXT
    CHECK (error_kind IS NULL OR error_kind IN ('unauthorized', 'forbidden', 'unreachable', 'other')),
  error           TEXT
) STRICT;

-- What a project picked in a connector: whole containers (an Outline
-- collection), documents (with their nested ones) and documents of a picked
-- container left out (`exclude`). `account_ref`: the team the pick belongs
-- to; a pick of another team is `unavailable` and removes nothing.
-- `unavailable`: the service no longer has it or denies access.
CREATE TABLE connector_selections (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  connector   TEXT NOT NULL CHECK (connector IN ('outline', 'github', 'clickup')),
  account_ref TEXT NOT NULL,
  item_kind   TEXT NOT NULL CHECK (item_kind IN ('container', 'document', 'exclude')),
  external_id TEXT NOT NULL CHECK (length(external_id) > 0),
  title       TEXT NOT NULL,
  url         TEXT,
  status      TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'unavailable')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (project_id, connector, external_id, item_kind)
) STRICT;

CREATE INDEX connector_selections_project ON connector_selections (project_id, connector);

-- The last sync of a project's selection in a connector: «Обновлено …» and
-- «Не обновлялось: …». `disconnected`: the connector was not connected.
-- `skipped`: documents over the limit of 200 left out by the last sync.
CREATE TABLE project_connector_sync (
  project_id      TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  connector       TEXT NOT NULL CHECK (connector IN ('outline', 'github', 'clickup')),
  last_ok_at      INTEGER,
  last_attempt_at INTEGER,
  error_kind      TEXT CHECK (error_kind IS NULL OR error_kind IN
    ('unauthorized', 'forbidden', 'unreachable', 'other', 'disconnected')),
  error           TEXT,
  skipped         INTEGER NOT NULL DEFAULT 0 CHECK (skipped >= 0),
  PRIMARY KEY (project_id, connector)
) STRICT;

-- `project_sources` takes documents of a connector. SQLite can't change a
-- CHECK in place, so the table is rebuilt (as `calls` in 0006); nothing
-- refers to it by a foreign key. Every row of a file is copied as it is.
--
-- A connector's document: `kind` `connector`, `connector`, `external_id`
-- (the document in the service), `external_url` and `external_version`
-- (Outline: `updatedAt`); its text is in the row, `stored_path` is empty,
-- `extension` `md`, `size` the text's bytes, `sha256` the text's hash.
-- The same content is a file of a project once; two documents of a
-- service may have the same text, but a document is in a project once.
CREATE TABLE project_sources_new (
  id               TEXT PRIMARY KEY NOT NULL,
  project_id       TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'file' CHECK (kind IN ('file', 'connector')),
  name             TEXT NOT NULL CHECK (length(trim(name)) > 0),
  extension        TEXT NOT NULL,
  size             INTEGER NOT NULL CHECK (size >= 0),
  sha256           TEXT NOT NULL CHECK (length(sha256) = 64),
  stored_path      TEXT NOT NULL,
  text             TEXT NOT NULL DEFAULT '',
  text_chars       INTEGER NOT NULL DEFAULT 0 CHECK (text_chars >= 0),
  truncated        INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  status           TEXT NOT NULL CHECK (status IN ('ready', 'no_text', 'failed')),
  error            TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  connector        TEXT CHECK (connector IS NULL OR connector IN ('outline', 'github', 'clickup')),
  external_id      TEXT,
  external_url     TEXT,
  external_version TEXT,
  CHECK (
    (kind = 'file' AND connector IS NULL AND external_id IS NULL)
    OR (kind = 'connector' AND connector IS NOT NULL AND external_id IS NOT NULL
        AND stored_path = '')
  )
) STRICT;

INSERT INTO project_sources_new
  (id, project_id, kind, name, extension, size, sha256, stored_path, text, text_chars,
   truncated, status, error, created_at, updated_at)
SELECT id, project_id, kind, name, extension, size, sha256, stored_path, text, text_chars,
       truncated, status, error, created_at, updated_at
  FROM project_sources;

DROP TABLE project_sources;

ALTER TABLE project_sources_new RENAME TO project_sources;

CREATE UNIQUE INDEX project_sources_file_content
  ON project_sources (project_id, sha256) WHERE kind = 'file';

CREATE UNIQUE INDEX project_sources_connector_document
  ON project_sources (project_id, connector, external_id) WHERE kind = 'connector';
