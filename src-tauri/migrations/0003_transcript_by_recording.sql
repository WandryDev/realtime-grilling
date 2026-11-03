-- Transcript by recording (speech-recognition design.md, decision 13).
--
-- A segment now belongs to a recording, which may have no call yet; SQLite
-- can't drop the NOT NULL of `call_id`, so the table is rebuilt. The old rows
-- have no recording to move to and are dropped (`storage::migrate` logs how
-- many). `pass`: `live` while recording, `refined` from the second pass.

DROP TABLE transcript_segments;

CREATE TABLE transcript_segments (
  id           TEXT PRIMARY KEY NOT NULL,
  recording_id TEXT NOT NULL REFERENCES recordings (id) ON DELETE CASCADE,
  -- The recording's call when the segment was written.
  call_id      TEXT REFERENCES calls (id) ON DELETE CASCADE,
  pass         TEXT NOT NULL CHECK (pass IN ('live', 'refined')),
  channel      TEXT NOT NULL CHECK (channel IN ('me', 'others')),
  start_ms     INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms       INTEGER NOT NULL CHECK (end_ms >= start_ms),
  text         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX transcript_segments_recording ON transcript_segments (recording_id, pass, start_ms);
CREATE INDEX transcript_segments_call_id ON transcript_segments (call_id);

-- The project and the client's people the recording was started for (the
-- glossary of both passes). Deleting the project deletes its recordings; a
-- recording without a project or call outlives every delete.
-- `participant_ids`: JSON array of people ids of `project_id`, in order.
ALTER TABLE recordings
  ADD COLUMN project_id TEXT REFERENCES projects (id) ON DELETE CASCADE;
ALTER TABLE recordings
  ADD COLUMN participant_ids TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(participant_ids) AND json_type(participant_ids) = 'array');
-- Where the second pass is: `live` (not started), `refining`, `refined`, `failed`.
ALTER TABLE recordings
  ADD COLUMN transcript_state TEXT NOT NULL DEFAULT 'live'
    CHECK (transcript_state IN ('live', 'refining', 'refined', 'failed'));

-- A recording of a call belongs to the call's project.
UPDATE recordings
   SET project_id = (SELECT calls.project_id FROM calls WHERE calls.id = recordings.call_id)
 WHERE call_id IS NOT NULL;

CREATE INDEX recordings_project_id ON recordings (project_id);
