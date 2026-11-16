-- Real settings (settings-real design.md, decision 1), after 0011.
--
-- The other demo microphone, `macbook`, becomes «Как в системе» too, as the
-- frontend has read it since 0011.

UPDATE settings SET value = '"system"'
 WHERE key = 'microphone' AND value = '"macbook"';
