-- Question volume (question-volume design.md, decision 3).
--
-- Two columns, no table is rebuilt.

-- When an open question last gave its place on the screen to one never
-- shown, after it had been visible too long. NULL: it never did. The waiting
-- questions that never were on the screen come first, then these by this
-- time.
ALTER TABLE questions ADD COLUMN requeued_at INTEGER;

-- What an agent call was for (question-volume design.md, decision 2):
-- `fastLoop`, the call that patches the call's state, or `topicCheck`, the
-- short call that asks whether the topic changed.
ALTER TABLE agent_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'fastLoop'
  CHECK (kind IN ('fastLoop', 'topicCheck'));
