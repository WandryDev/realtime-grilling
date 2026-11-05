-- After-call summaries, knowledge proposals and deleted audio (post-call
-- design.md, decision 5).
--
-- New tables and a column, no table is rebuilt. Both tables follow their
-- call (`ON DELETE CASCADE`); the calls of a project go with it, so do their
-- summaries and proposals. A proposal about a person goes with the person.

-- When the audio files of a recording were deleted ("Удалить запись"); the
-- row, its transcript, topics, cards and questions stay. NULL: the files are
-- there (or the recording is being written).
ALTER TABLE recordings ADD COLUMN audio_deleted_at INTEGER;

-- One summary per call. `state` is the last build: `building`, `ready` or
-- `failed` (with `error`). `title`, `tldr`, `transcript_pass`, `content` and
-- `built_at` are the last summary that was saved `ready`: a build that starts
-- or fails keeps them (`call-summary`, "Ошибка сборки"). `content`: JSON of
-- `SummaryContent` (topics with their range and points, cards with facts,
-- the questions for the next call).
CREATE TABLE call_summaries (
  call_id         TEXT PRIMARY KEY NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  state           TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed')),
  error           TEXT,
  transcript_pass TEXT CHECK (transcript_pass IS NULL
                              OR transcript_pass IN ('refined', 'live', 'mixed')),
  title           TEXT NOT NULL DEFAULT '',
  tldr            TEXT NOT NULL DEFAULT '',
  content         TEXT CHECK (content IS NULL
                              OR (json_valid(content) AND json_type(content) = 'object')),
  built_at        INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  CHECK ((state = 'failed') = (error IS NOT NULL)),
  CHECK (state <> 'ready' OR content IS NOT NULL),
  CHECK ((content IS NULL) = (built_at IS NULL))
) STRICT;

-- Proposals to update the brief (`target` `brief`) or a person's profile
-- (`person`, `person_id`). `before_value`: the value when the proposal was
-- made, taken from the data (NULL: none); `after_value`: what the agent
-- proposes; `edited`: the manager's text of "Изменить и принять".
-- `evidence`: JSON array of `CallEvidence`. `applied`: JSON of
-- `ProposalApplied`, what an accepted proposal wrote and what was there.
CREATE TABLE call_proposals (
  id           TEXT PRIMARY KEY NOT NULL,
  call_id      TEXT NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  target       TEXT NOT NULL CHECK (target IN ('brief', 'person')),
  person_id    TEXT REFERENCES people (id) ON DELETE CASCADE,
  field        TEXT NOT NULL CHECK (length(trim(field)) > 0),
  before_value TEXT,
  after_value  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('said', 'inferred')),
  evidence     TEXT NOT NULL DEFAULT '[]'
                 CHECK (json_valid(evidence) AND json_type(evidence) = 'array'),
  decision     TEXT NOT NULL DEFAULT 'pending'
                 CHECK (decision IN ('pending', 'accepted', 'rejected')),
  edited       TEXT,
  applied      TEXT CHECK (applied IS NULL OR json_valid(applied)),
  decided_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  CHECK ((target = 'person') = (person_id IS NOT NULL)),
  CHECK ((decision = 'pending') = (decided_at IS NULL))
) STRICT;

CREATE INDEX call_proposals_call_id ON call_proposals (call_id, decision);
CREATE INDEX call_proposals_person_id ON call_proposals (person_id, decision);

-- Before this version «Удалить запись» only set `audioDeleted` in the call's
-- frontend JSON (`calls.summary`) and left the files. Those recordings now
-- read as without audio (no second pass, no player), and the sweep at start
-- removes their files.
UPDATE recordings
   SET audio_deleted_at = (SELECT c.updated_at FROM calls c WHERE c.id = recordings.call_id),
       transcript_state = CASE WHEN transcript_state IN ('live', 'refining')
                               THEN 'failed' ELSE transcript_state END
 WHERE audio_deleted_at IS NULL
   AND status <> 'recording'
   AND call_id IN (SELECT id FROM calls
                    WHERE CASE WHEN json_valid(summary)
                               THEN json_extract(summary, '$.audioDeleted') END = 1);
