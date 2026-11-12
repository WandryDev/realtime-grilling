-- Real settings (settings-real design.md, decisions 1, 5, 6).
--
-- Settings no one acts on go: the system audio source, the recordings
-- folder, the interface language, the final check and the agent's "signed
-- in" flag. The demo microphone `airpods` becomes «Как в системе».
-- The retention values become days: what the screen stored before
-- (`7d`, `3m`, `1y`, …) maps to the days it meant; `never` stays.

DELETE FROM settings
 WHERE key IN ('systemAudio', 'recordingsFolder', 'interfaceLanguage', 'finalCheck',
               'agentSignedIn');

UPDATE settings SET value = '"system"'
 WHERE key = 'microphone' AND value = '"airpods"';

UPDATE settings
   SET value = CASE value
                 WHEN '"7d"' THEN '"7"'
                 WHEN '"30d"' THEN '"30"'
                 WHEN '"90d"' THEN '"90"'
               END
 WHERE key = 'audioRetention' AND value IN ('"7d"', '"30d"', '"90d"');

UPDATE settings
   SET value = CASE value
                 WHEN '"3m"' THEN '"90"'
                 WHEN '"6m"' THEN '"180"'
                 WHEN '"1y"' THEN '"365"'
               END
 WHERE key = 'transcriptRetention' AND value IN ('"3m"', '"6m"', '"1y"');

-- When the transcript of a recording was deleted by the retention period
-- (`transcriptRetention`); its segments are gone, the summary stays.
ALTER TABLE recordings ADD COLUMN transcript_deleted_at INTEGER;
