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
};

pub type SettingsMap = BTreeMap<String, Value>;

/// Shortcuts by action id; an empty list means "not set".
pub type Shortcuts = BTreeMap<String, Vec<String>>;

pub const ONBOARDING_COMPLETED: &str = "onboardingCompleted";
pub const LAUNCH_AT_LOGIN: &str = "launchAtLogin";
pub const HIDE_ON_SHARE: &str = "hideOnShare";
pub const SHORTCUTS: &str = "shortcuts";
/// Where the agent CLI was found (`null`: not found). Optional, no default;
/// written by the agent commands.
pub const AGENT_PATH: &str = "agentPath";

pub const SETTINGS_ID: &str = "settings";

/// Defaults of the keys Rust acts on. They match `DEFAULT_SETTINGS` in
/// `src/data/settings.ts`.
pub fn defaults() -> SettingsMap {
    SettingsMap::from([
        (ONBOARDING_COMPLETED.to_owned(), json!(false)),
        (LAUNCH_AT_LOGIN.to_owned(), json!(true)),
        (HIDE_ON_SHARE.to_owned(), json!(true)),
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
    Ok(settings)
}

/// Checks the types of the keys Rust acts on.
pub fn validate(patch: &SettingsMap) -> CommandResult<()> {
    for (key, value) in patch {
        if key.trim().is_empty() {
            return Err(CommandError::invalid("Пустой ключ настройки"));
        }
        let valid = match key.as_str() {
            ONBOARDING_COMPLETED | LAUNCH_AT_LOGIN | HIDE_ON_SHARE => value.is_boolean(),
            SHORTCUTS => serde_json::from_value::<Shortcuts>(value.clone()).is_ok(),
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
