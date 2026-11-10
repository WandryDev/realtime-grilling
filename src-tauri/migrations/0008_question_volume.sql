-- Question volume (question-volume design.md, decision 3).
--
-- A column, no table is rebuilt.

-- When an open question last gave its place on the screen to one never
-- shown, after it had been visible too long. NULL: it never did. The waiting
-- questions that never were on the screen come first, then these by this
-- time.
ALTER TABLE questions ADD COLUMN requeued_at INTEGER;
