//! App preferences: key → JSON value.
//!
//! The keys are those of the frontend's `SettingsValues` plus the ones Rust
//! writes itself (`onboardingCompleted`, `speechModel`, `speechBenchmark`,
//! `agentPath`). Only the keys of [`KNOWN_KEYS`] are stored, each with its
//! value checked (settings-real design.md, decision 6); the frontend merges
//! what it gets over its own defaults.

use std::collections::BTreeMap;

use rusqlite::{Connection, params};
use serde_json::{Value, json};

use super::json::Json;
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
    speech::{language::CallLanguage, models::ModelId},
};

pub type SettingsMap = BTreeMap<String, Value>;

/// Shortcuts by action id; an empty list means "not set".
pub type Shortcuts = BTreeMap<String, Vec<String>>;

pub const ONBOARDING_COMPLETED: &str = "onboardingCompleted";
pub const LAUNCH_AT_LOGIN: &str = "launchAtLogin";
pub const HIDE_ON_SHARE: &str = "hideOnShare";
pub const SHORTCUTS: &str = "shortcuts";
/// What a busy microphone does: [`MicBusyBehavior`].
pub const MIC_BUSY_BEHAVIOR: &str = "micBusyBehavior";
/// Where the agent CLI was found (`null`: not found). Optional, no default;
/// written by the agent commands.
pub const AGENT_PATH: &str = "agentPath";
/// The speech model to recognize with: `turbo` or `small` (speech-recognition
/// design.md, decision 3). Written by `speech_model_select`.
pub const SPEECH_MODEL: &str = "speechModel";
/// The hardware check by model, as the benchmark writes it; stored as given.
pub const SPEECH_BENCHMARK: &str = "speechBenchmark";
/// «Язык звонка»: `ru`, `uk` or `both` (speech-recognition design.md,
/// decision 7). Not stored by default: the frontend's default is `ru`.
pub const CALL_LANGUAGE: &str = "callLanguage";
/// «Сколько вопросов показывать»: `"1"`, `"3"` or `"5"` (agent-fast-loop
/// design.md, decision 7). Stored as the frontend writes it.
pub const QUESTION_COUNT: &str = "questionCount";
/// Visible questions when `questionCount` is missing or unreadable.
pub const DEFAULT_QUESTION_COUNT: usize = 3;
/// «Как часто предлагать вопросы»: `rare`, `normal` or `often`
/// (agent-fast-loop design.md, decision 2). Stored as the frontend writes it.
pub const QUESTION_FREQUENCY: &str = "questionFrequency";
/// «Завершать звонок сам»: minutes after the meeting app let the
/// microphone go, as a string (`"5"`, `"10"`), or `"never"`
/// (call-lifecycle design.md, decision 6).
pub const AUTO_END: &str = "autoEnd";
/// «Компактный оверлей»: a started call shows the overlay, not the call
/// window (decision 5).
pub const COMPACT_OVERLAY: &str = "compactOverlay";
/// «Микрофон»: [`MIC_SYSTEM`] («Как в системе») or a device name
/// (settings-real design.md, decision 1).
pub const MICROPHONE: &str = "microphone";
/// The `microphone` value «Как в системе»: the default input at capture.
pub const MIC_SYSTEM: &str = "system";
/// «Аудиозаписи звонков»: days as a string (`"7"`, `"30"`, `"90"`) or
/// `"never"` (settings-real design.md, decision 5).
pub const AUDIO_RETENTION: &str = "audioRetention";
/// «Расшифровки»: days as a string (`"90"`, `"180"`, `"365"`) or `"never"`
/// for a value an earlier build stored.
pub const TRANSCRIPT_RETENTION: &str = "transcriptRetention";
/// «Тема»: only `light` works for now; `dark` and `system` are «скоро».
pub const THEME: &str = "theme";

/// Every key the app stores; anything else is `Invalid`.
pub const KNOWN_KEYS: &[&str] = &[
    ONBOARDING_COMPLETED,
    LAUNCH_AT_LOGIN,
    HIDE_ON_SHARE,
    SHORTCUTS,
    MIC_BUSY_BEHAVIOR,
    AGENT_PATH,
    SPEECH_MODEL,
    SPEECH_BENCHMARK,
    CALL_LANGUAGE,
    QUESTION_COUNT,
    QUESTION_FREQUENCY,
    QUESTION_REQUEUE_MINUTES,
    AUTO_END,
    COMPACT_OVERLAY,
    MICROPHONE,
    AUDIO_RETENTION,
    TRANSCRIPT_RETENTION,
    THEME,
];

const AUDIO_RETENTION_VALUES: &[&str] = &["7", "30", "90", NEVER];
const TRANSCRIPT_RETENTION_VALUES: &[&str] = &["90", "180", "365", NEVER];
const NEVER: &str = "never";
/// `transcriptRetention` when nothing is stored: «Через 6 месяцев».
pub const DEFAULT_TRANSCRIPT_RETENTION: &str = "180";

pub const SETTINGS_ID: &str = "settings";

/// "Когда микрофон занят" (`specs/mic-activity`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicBusyBehavior {
    /// Show the start widget.
    Widget,
    /// Start a call right away, with the last call's project and people,
    /// and show the overlay (call-lifecycle design.md, decision 7).
    Record,
    /// Do nothing; the windows still get `MicActivityChanged`.
    Nothing,
}

impl MicBusyBehavior {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "widget" => Some(Self::Widget),
            "record" => Some(Self::Record),
            "nothing" => Some(Self::Nothing),
            _ => None,
        }
    }
}

/// Defaults of the keys Rust acts on. They match `DEFAULT_SETTINGS` in
/// `src/data/settings.ts`.
pub fn defaults() -> SettingsMap {
    SettingsMap::from([
        (ONBOARDING_COMPLETED.to_owned(), json!(false)),
        (LAUNCH_AT_LOGIN.to_owned(), json!(true)),
        (HIDE_ON_SHARE.to_owned(), json!(true)),
        (MIC_BUSY_BEHAVIOR.to_owned(), json!("widget")),
        (AUTO_END.to_owned(), json!("10")),
        (COMPACT_OVERLAY.to_owned(), json!(true)),
        (SPEECH_MODEL.to_owned(), json!(ModelId::Turbo.as_str())),
        (MICROPHONE.to_owned(), json!(MIC_SYSTEM)),
        (AUDIO_RETENTION.to_owned(), json!(NEVER)),
        (
            TRANSCRIPT_RETENTION.to_owned(),
            json!(DEFAULT_TRANSCRIPT_RETENTION),
        ),
        (THEME.to_owned(), json!("light")),
        (
            SHORTCUTS.to_owned(),
            json!({
                "toggle-call": ["⌥", "⌘", "G"],
                "toggle-overlay": ["⌥", "⌘", "O"],
                "next-question": ["⌥", "⌘", "→"],
                "mark-asked": ["⌥", "⌘", "↩"],
                "hide-question": ["⌥", "⌘", "⌫"],
            }),
        ),
    ])
}

/// Stored values over the defaults.
pub fn get(connection: &Connection) -> CommandResult<SettingsMap> {
    let mut settings = defaults();
    let mut statement = connection.prepare("SELECT key, value FROM settings")?;
    let rows = statement.query_map([], |row| {
        let Json(value) = row.get(1)?;
        Ok((row.get::<_, String>(0)?, value))
    })?;
    for row in rows {
        let (key, value) = row?;
        settings.insert(key, value);
    }
    // Earlier builds stored `whisper` / `gigaam`: the windows see `turbo`.
    let model = speech_model(&settings);
    settings.insert(SPEECH_MODEL.to_owned(), json!(model.as_str()));
    Ok(settings)
}

/// Checks that every key is known and its value fits it. `Invalid`
/// otherwise; nothing of the patch is written then.
pub fn validate(patch: &SettingsMap) -> CommandResult<()> {
    for (key, value) in patch {
        if !KNOWN_KEYS.contains(&key.as_str()) {
            return Err(CommandError::invalid(format!(
                "Неизвестная настройка: {key}"
            )));
        }
        if !valid_value(key, value) {
            return Err(CommandError::invalid(format!(
                "Неверное значение настройки {key}: {value}"
            )));
        }
    }
    Ok(())
}

fn one_of(value: &Value, allowed: &[&str]) -> bool {
    value.as_str().is_some_and(|text| allowed.contains(&text))
}

/// A whole number as a string or a number.
fn whole_number(value: &Value) -> Option<i64> {
    match value {
        Value::String(text) => text.trim().parse().ok(),
        Value::Number(number) => number.as_i64(),
        _ => None,
    }
}

fn valid_value(key: &str, value: &Value) -> bool {
    match key {
        ONBOARDING_COMPLETED | LAUNCH_AT_LOGIN | HIDE_ON_SHARE | COMPACT_OVERLAY => {
            value.is_boolean()
        }
        // Minutes as the frontend stores them (`"10"`), a number, or `"never"`.
        AUTO_END => value.as_str() == Some(NEVER) || whole_number(value).is_some_and(|m| m >= 0),
        SHORTCUTS => serde_json::from_value::<Shortcuts>(value.clone()).is_ok(),
        MIC_BUSY_BEHAVIOR => value.as_str().and_then(MicBusyBehavior::parse).is_some(),
        SPEECH_MODEL => value.as_str().and_then(ModelId::parse).is_some(),
        CALL_LANGUAGE => value.as_str().and_then(CallLanguage::parse).is_some(),
        QUESTION_COUNT => matches!(whole_number(value), Some(1 | 3 | 5)),
        QUESTION_FREQUENCY => one_of(value, &["rare", "normal", "often"]),
        QUESTION_REQUEUE_MINUTES => whole_number(value).is_some_and(|minutes| minutes >= 1),
        // Any JSON: the benchmark owns its shape.
        SPEECH_BENCHMARK => true,
        // Only a path to the agent CLI: it is what the agent commands run.
        AGENT_PATH => {
            value.is_null()
                || value.as_str().is_some_and(|path| {
                    crate::agent::discover::has_cli_name(std::path::Path::new(path))
                })
        }
        // «Как в системе» or a device name, which may be absent right now.
        MICROPHONE => value.as_str().is_some_and(|name| !name.trim().is_empty()),
        AUDIO_RETENTION => one_of(value, AUDIO_RETENTION_VALUES),
        TRANSCRIPT_RETENTION => one_of(value, TRANSCRIPT_RETENTION_VALUES),
        THEME => one_of(value, &["light", "dark", "system"]),
        _ => false,
    }
}

/// Writes the given keys; the others keep their values.
pub fn put(connection: &Connection, patch: &SettingsMap) -> CommandResult<Vec<DataChanged>> {
    validate(patch)?;
    if patch.is_empty() {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )?;
    for (key, value) in patch {
        statement.execute(params![key, Json(value.clone())])?;
    }
    Ok(vec![DataChanged::new(
        Entity::Settings,
        SETTINGS_ID,
        None,
        Change::Updated,
    )])
}

/// A patch's `shortcuts` changes only the actions it names: they are merged
/// over the stored ones, so two windows changing different shortcuts never
/// undo each other. Returns the patch with the whole merged map.
pub fn merge_shortcuts(stored: &SettingsMap, mut patch: SettingsMap) -> SettingsMap {
    if patch.contains_key(SHORTCUTS) {
        let mut merged = shortcuts(stored);
        merged.extend(shortcuts(&patch));
        if let Ok(value) = serde_json::to_value(merged) {
            patch.insert(SHORTCUTS.to_owned(), value);
        }
    }
    patch
}

pub fn flag(settings: &SettingsMap, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub fn shortcuts(settings: &SettingsMap) -> Shortcuts {
    settings
        .get(SHORTCUTS)
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

/// `micBusyBehavior`; a missing (or unreadable) value is `widget`.
pub fn mic_busy_behavior(settings: &SettingsMap) -> MicBusyBehavior {
    settings
        .get(MIC_BUSY_BEHAVIOR)
        .and_then(Value::as_str)
        .and_then(MicBusyBehavior::parse)
        .unwrap_or(MicBusyBehavior::Widget)
}

/// `speechModel`; legacy `whisper` / `gigaam`, a missing or unreadable value
/// are `turbo`.
pub fn speech_model(settings: &SettingsMap) -> ModelId {
    settings
        .get(SPEECH_MODEL)
        .and_then(Value::as_str)
        .and_then(ModelId::parse)
        .unwrap_or(ModelId::Turbo)
}

/// `callLanguage`; a missing or unreadable value is Russian.
pub fn call_language(settings: &SettingsMap) -> CallLanguage {
    settings
        .get(CALL_LANGUAGE)
        .and_then(Value::as_str)
        .and_then(CallLanguage::parse)
        .unwrap_or_default()
}

/// `autoEnd` as a delay: whole minutes above zero, as a string (how the
/// frontend stores it) or a number. `"never"`, zero or anything else is
/// `None` ("Никогда"); a missing key is the default, 10 minutes.
pub fn auto_end(settings: &SettingsMap) -> Option<std::time::Duration> {
    let minutes = match settings.get(AUTO_END) {
        None => Some(10),
        Some(Value::String(text)) => text.trim().parse::<u64>().ok(),
        Some(Value::Number(number)) => number.as_u64(),
        Some(_) => None,
    };
    minutes
        .filter(|minutes| *minutes > 0)
        .map(|minutes| std::time::Duration::from_secs(minutes * 60))
}

/// The chosen microphone: `None` for «Как в системе» (also a missing or
/// unreadable value), else the device name.
pub fn microphone(settings: &SettingsMap) -> Option<String> {
    settings
        .get(MICROPHONE)
        .and_then(Value::as_str)
        .filter(|name| *name != MIC_SYSTEM && !name.trim().is_empty())
        .map(str::to_owned)
}

/// Days of a retention value; `None` for `"never"` (and anything unreadable).
fn retention_days(settings: &SettingsMap, key: &str, default: Option<i64>) -> Option<i64> {
    match settings.get(key) {
        None => default,
        Some(value) => match value.as_str() {
            Some(NEVER) => None,
            _ => whole_number(value).filter(|days| *days > 0).or(default),
        },
    }
}

/// `audioRetention` in days; `None` keeps the audio («Не удалять», the
/// default).
pub fn audio_retention_days(settings: &SettingsMap) -> Option<i64> {
    retention_days(settings, AUDIO_RETENTION, None)
}

/// `transcriptRetention` in days; `None` keeps the transcripts (`"never"`).
/// Missing or unreadable is [`DEFAULT_TRANSCRIPT_RETENTION`].
pub fn transcript_retention_days(settings: &SettingsMap) -> Option<i64> {
    let default = DEFAULT_TRANSCRIPT_RETENTION.parse().ok();
    retention_days(settings, TRANSCRIPT_RETENTION, default)
}

/// `compactOverlay`; a missing (or unreadable) value is on.
pub fn compact_overlay(settings: &SettingsMap) -> bool {
    settings
        .get(COMPACT_OVERLAY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// The longest time between the starts of two agent calls while the client
/// talks and the manager doesn't, by `questionFrequency`: `rare` 45 s,
/// `normal` 20 s, `often` 10 s. Anything else is `normal`.
pub fn question_interval(settings: &SettingsMap) -> std::time::Duration {
    let seconds = match settings.get(QUESTION_FREQUENCY).and_then(Value::as_str) {
        Some("rare") => 45,
        Some("often") => 10,
        _ => 20,
    };
    std::time::Duration::from_secs(seconds)
}

/// The least time between the starts of two agent calls once the client
/// finished a turn (the manager spoke after them), by `questionFrequency`
/// (question-volume design.md, decision 1): `rare` 30 s, `normal` 5 s,
/// `often` none. Anything else is `normal`.
pub fn question_gap(settings: &SettingsMap) -> std::time::Duration {
    let seconds = match settings.get(QUESTION_FREQUENCY).and_then(Value::as_str) {
        Some("rare") => 30,
        Some("often") => 0,
        _ => 5,
    };
    std::time::Duration::from_secs(seconds)
}

/// Minutes a visible question keeps its place while questions never shown
/// wait (question-volume design.md, decision 3). Not on the settings
/// screen: a replay tries other values (`grill-eval replay
/// --requeue-minutes`).
pub const QUESTION_REQUEUE_MINUTES: &str = "questionRequeueMinutes";
pub const DEFAULT_REQUEUE_MINUTES: i64 = 8;

/// `questionRequeueMinutes` in ms: a whole number of minutes from 1, as a
/// number or a string; anything else is [`DEFAULT_REQUEUE_MINUTES`].
pub fn question_requeue_ms(settings: &SettingsMap) -> i64 {
    let minutes = match settings.get(QUESTION_REQUEUE_MINUTES) {
        Some(Value::String(text)) => text.trim().parse().ok(),
        Some(Value::Number(number)) => number.as_i64(),
        _ => None,
    };
    minutes
        .filter(|minutes| *minutes >= 1)
        .unwrap_or(DEFAULT_REQUEUE_MINUTES)
        * 60_000
}

/// `questionCount` as a number of visible questions: `1`, `3` or `5`, as a
/// string (how the frontend stores it) or a number. Anything else is 3.
pub fn question_count(settings: &SettingsMap) -> usize {
    let count = match settings.get(QUESTION_COUNT) {
        Some(Value::String(text)) => text.trim().parse().ok(),
        Some(Value::Number(number)) => number.as_u64(),
        _ => None,
    };
    match count {
        Some(1) => 1,
        Some(5) => 5,
        _ => DEFAULT_QUESTION_COUNT,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[test]
    fn auto_end_is_minutes_or_never() {
        let with = |value: Value| SettingsMap::from([(AUTO_END.to_owned(), value)]);
        assert_eq!(auto_end(&defaults()), Some(Duration::from_secs(600)));
        assert_eq!(
            auto_end(&SettingsMap::new()),
            Some(Duration::from_secs(600))
        );
        assert_eq!(auto_end(&with(json!("5"))), Some(Duration::from_secs(300)));
        assert_eq!(auto_end(&with(json!(10))), Some(Duration::from_secs(600)));
        for never in [
            json!("never"),
            json!("0"),
            json!(0),
            json!(null),
            json!("soon"),
        ] {
            assert_eq!(auto_end(&with(never.clone())), None, "{never}");
        }
    }

    fn invalid(patch: &SettingsMap) -> bool {
        matches!(validate(patch), Err(CommandError::Invalid { .. }))
    }

    fn one(key: &str, value: Value) -> SettingsMap {
        SettingsMap::from([(key.to_owned(), value)])
    }

    /// `app-settings`, «Неизвестный ключ».
    #[test]
    fn an_unknown_key_is_invalid_and_nothing_is_written() {
        let connection = crate::storage::open_in_memory().unwrap();
        for removed in [
            "systemAudio",
            "recordingsFolder",
            "interfaceLanguage",
            "finalCheck",
            "agentSignedIn",
            "whatever",
        ] {
            // With a valid key next to it: the whole patch is refused.
            let patch = SettingsMap::from([
                (HIDE_ON_SHARE.to_owned(), json!(false)),
                (removed.to_owned(), json!("x")),
            ]);
            let error = put(&connection, &patch).unwrap_err();
            assert!(matches!(error, CommandError::Invalid { .. }), "{removed}");
        }
        let rows: i64 = connection
            .query_row("SELECT count(*) FROM settings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0, "nothing written");
        assert_eq!(get(&connection).unwrap(), defaults());
    }

    #[test]
    fn known_keys_take_only_their_values() {
        let good = [
            (ONBOARDING_COMPLETED, json!(true)),
            (AUTO_END, json!("5")),
            (AUTO_END, json!("never")),
            (AUTO_END, json!(15)),
            (CALL_LANGUAGE, json!("both")),
            (QUESTION_COUNT, json!("5")),
            (QUESTION_COUNT, json!(1)),
            (QUESTION_FREQUENCY, json!("often")),
            (QUESTION_REQUEUE_MINUTES, json!(8)),
            (MICROPHONE, json!("system")),
            (MICROPHONE, json!("AirPods Pro")),
            (AUDIO_RETENTION, json!("7")),
            (AUDIO_RETENTION, json!("never")),
            (TRANSCRIPT_RETENTION, json!("365")),
            (THEME, json!("light")),
        ];
        for (key, value) in good {
            assert!(validate(&one(key, value.clone())).is_ok(), "{key} {value}");
        }
        let bad = [
            (ONBOARDING_COMPLETED, json!("yes")),
            (AUTO_END, json!("soon")),
            (AUTO_END, json!(null)),
            (CALL_LANGUAGE, json!("en")),
            (QUESTION_COUNT, json!("4")),
            (QUESTION_FREQUENCY, json!("always")),
            (QUESTION_REQUEUE_MINUTES, json!(0)),
            (MICROPHONE, json!("")),
            (MICROPHONE, json!(null)),
            (AUDIO_RETENTION, json!("30d")),
            (AUDIO_RETENTION, json!(30)),
            (TRANSCRIPT_RETENTION, json!("6m")),
            (TRANSCRIPT_RETENTION, json!("30")),
            (THEME, json!("blue")),
        ];
        for (key, value) in bad {
            assert!(invalid(&one(key, value.clone())), "{key} {value}");
        }
    }

    #[test]
    fn readers_of_the_new_keys() {
        assert_eq!(microphone(&defaults()), None);
        assert_eq!(microphone(&SettingsMap::new()), None);
        assert_eq!(
            microphone(&one(MICROPHONE, json!("USB Mic"))).as_deref(),
            Some("USB Mic")
        );
        assert_eq!(audio_retention_days(&defaults()), None, "«Не удалять»");
        assert_eq!(
            audio_retention_days(&one(AUDIO_RETENTION, json!("30"))),
            Some(30)
        );
        assert_eq!(
            audio_retention_days(&one(AUDIO_RETENTION, json!("30d"))),
            None
        );
        assert_eq!(transcript_retention_days(&defaults()), Some(180));
        assert_eq!(transcript_retention_days(&SettingsMap::new()), Some(180));
        assert_eq!(
            transcript_retention_days(&one(TRANSCRIPT_RETENTION, json!("90"))),
            Some(90)
        );
        assert_eq!(
            transcript_retention_days(&one(TRANSCRIPT_RETENTION, json!("never"))),
            None
        );
    }

    /// Migration 0012 on a version 11 database: the demo `macbook` is «Как
    /// в системе», a real device's name stays.
    #[test]
    fn migration_0012_maps_the_demo_macbook_to_the_system_input() {
        use rusqlite_migration::Migrations;

        use crate::storage::{DATABASE_FILE, MIGRATION_LIST, MIGRATIONS, open};

        let microphone = |stored: &str| -> String {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(DATABASE_FILE);
            {
                let connection =
                    open(&path, &Migrations::from_slice(&MIGRATION_LIST[..11])).unwrap();
                connection
                    .execute(
                        "INSERT INTO settings (key, value) VALUES ('microphone', ?1)",
                        [stored],
                    )
                    .unwrap();
            }
            let connection = open(&path, &MIGRATIONS).unwrap();
            connection
                .query_row(
                    "SELECT value FROM settings WHERE key = 'microphone'",
                    [],
                    |row| row.get(0),
                )
                .unwrap()
        };
        assert_eq!(microphone("\"macbook\""), "\"system\"");
        assert_eq!(microphone("\"USB Mic\""), "\"USB Mic\"");
    }

    /// Migration 0011 on a version 10 database.
    #[test]
    fn migration_0011_drops_the_dead_keys_and_keeps_the_rest() {
        use rusqlite_migration::Migrations;

        use crate::storage::{DATABASE_FILE, MIGRATION_LIST, MIGRATIONS, SCHEMA_VERSION, open};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let rows = |connection: &Connection| -> Vec<(String, String)> {
            let mut statement = connection
                .prepare("SELECT key, value FROM settings ORDER BY key")
                .unwrap();
            statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let kept = [
            ("autoEnd", "\"5\""),
            ("callLanguage", "\"uk\""),
            ("compactOverlay", "false"),
            ("hideOnShare", "false"),
            ("onboardingCompleted", "true"),
            ("questionCount", "\"1\""),
            ("shortcuts", "{\"toggle-call\":[\"⌥\",\"G\"]}"),
            ("speechBenchmark", "{\"turbo\":{\"passed\":true}}"),
            ("theme", "\"light\""),
        ];
        {
            let connection = open(&path, &Migrations::from_slice(&MIGRATION_LIST[..10])).unwrap();
            let mut insert = connection
                .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)")
                .unwrap();
            for (key, value) in kept.iter().chain(&[
                ("systemAudio", "\"zoom\""),
                ("recordingsFolder", "\"~/Grill\""),
                ("interfaceLanguage", "\"en\""),
                ("finalCheck", "\"10\""),
                ("agentSignedIn", "true"),
                ("microphone", "\"airpods\""),
                ("audioRetention", "\"30d\""),
                ("transcriptRetention", "\"1y\""),
            ]) {
                insert.execute([key, value]).unwrap();
            }
            connection
                .execute_batch(
                    "INSERT INTO calls (id, title, status, created_at, updated_at)
                       VALUES ('call', '', 'finished', 1, 1);
                     INSERT INTO recordings (id, call_id, status, started_at, ended_at,
                                             me_file, others_file, created_at, updated_at)
                       VALUES ('rec', 'call', 'finished', 1, 2, 'm', 'o', 1, 1);",
                )
                .unwrap();
        }

        let connection = open(&path, &MIGRATIONS).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION as i64);
        let mut expected: Vec<(String, String)> = kept
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        expected.extend([
            ("audioRetention".to_owned(), "\"30\"".to_owned()),
            ("microphone".to_owned(), "\"system\"".to_owned()),
            ("transcriptRetention".to_owned(), "\"365\"".to_owned()),
        ]);
        expected.sort();
        assert_eq!(rows(&connection), expected);
        let transcript_deleted: Option<i64> = connection
            .query_row(
                "SELECT transcript_deleted_at FROM recordings WHERE id = 'rec'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(transcript_deleted, None);
        let violations: i64 = connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
        // Every value left is one the whitelist takes.
        let stored = get(&connection).unwrap();
        let patch: SettingsMap = stored
            .into_iter()
            .filter(|(key, _)| key != SPEECH_MODEL)
            .collect();
        validate(&patch).unwrap();
    }

    #[test]
    fn compact_overlay_is_on_unless_turned_off() {
        assert!(compact_overlay(&defaults()));
        assert!(compact_overlay(&SettingsMap::new()));
        let off = SettingsMap::from([(COMPACT_OVERLAY.to_owned(), json!(false))]);
        assert!(!compact_overlay(&off));
        assert!(validate(&off).is_ok());
        let bad = SettingsMap::from([(COMPACT_OVERLAY.to_owned(), json!("yes"))]);
        assert!(validate(&bad).is_err());
    }
}
