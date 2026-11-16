-- Call recordings (audio-capture design.md, decision 13).
--
-- Same conventions as 0001: UUID v7 ids, times in milliseconds since the Unix
-- epoch, UTC. A recording may exist before its call does (`call_id` NULL);
-- deleting a call (or its project) deletes its recordings, the files go with
-- the next sweep of the recordings folder. `me_file` / `others_file` are paths
-- relative to the app data folder.

CREATE TABLE recordings (
  id          TEXT PRIMARY KEY NOT NULL,
  call_id     TEXT REFERENCES calls (id) ON DELETE CASCADE,
  status      TEXT NOT NULL CHECK (status IN ('recording', 'finished', 'interrupted')),
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  me_file     TEXT NOT NULL,
  others_file TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX recordings_call_id ON recordings (call_id);
CREATE INDEX recordings_status ON recordings (status);
