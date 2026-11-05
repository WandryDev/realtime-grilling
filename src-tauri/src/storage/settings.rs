//! App preferences: key → JSON value.
//!
//! The keys are those of the frontend's `SettingsValues` plus
//! `onboardingCompleted`. Rust knows the keys it acts on (and their defaults);
//! the rest it stores as given, and the frontend merges them over its own
//! defaults.

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

/// Checks the types of the keys Rust acts on.
pub fn validate(patch: &SettingsMap) -> CommandResult<()> {
    for (key, value) in patch {
        if key.trim().is_empty() {
            return Err(CommandError::invalid("Пустой ключ настройки"));
        }
        let valid = match key.as_str() {
            ONBOARDING_COMPLETED | LAUNCH_AT_LOGIN | HIDE_ON_SHARE | COMPACT_OVERLAY => {
                value.is_boolean()
            }
            AUTO_END => value.is_string() || value.is_number(),
            SHORTCUTS => serde_json::from_value::<Shortcuts>(value.clone()).is_ok(),
            MIC_BUSY_BEHAVIOR => value.as_str().and_then(MicBusyBehavior::parse).is_some(),
            SPEECH_MODEL => value.as_str().and_then(ModelId::parse).is_some(),
            CALL_LANGUAGE => value.as_str().and_then(CallLanguage::parse).is_some(),
            // Any JSON: the benchmark owns its shape.
            SPEECH_BENCHMARK => true,
            // Only a path to the agent CLI: it is what the agent commands run.
            AGENT_PATH => {
                value.is_null()
                    || value.as_str().is_some_and(|path| {
                        crate::agent::discover::has_cli_name(std::path::Path::new(path))
                    })
            }
            _ => true,
        };
        if !valid {
            return Err(CommandError::invalid(format!(
                "Неверное значение настройки {key}: {value}"
            )));
        }
    }
    Ok(())
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

/// `compactOverlay`; a missing (or unreadable) value is on.
pub fn compact_overlay(settings: &SettingsMap) -> bool {
    settings
        .get(COMPACT_OVERLAY)
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// The least time between the starts of two agent calls by
/// `questionFrequency`: `rare` 45 s, `normal` 20 s, `often` 10 s. Anything
/// else is `normal`.
pub fn question_interval(settings: &SettingsMap) -> std::time::Duration {
    let seconds = match settings.get(QUESTION_FREQUENCY).and_then(Value::as_str) {
        Some("rare") => 45,
        Some("often") => 10,
        _ => 20,
    };
    std::time::Duration::from_secs(seconds)
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
