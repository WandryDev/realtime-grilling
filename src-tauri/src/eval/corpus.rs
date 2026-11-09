//! The corpus of one call (question-quality design.md, decision 2): a JSON
//! file `<name>.json` in `.grill-eval/corpus/`. It holds everything a
//! replay needs without the app's database: the project with its brief and
//! the texts of its documents, the client's people, the recording's start
//! and length, the live transcript (what the fast loop saw), the refined
//! one apart (for the judge), and the original call's topics, questions
//! and agent calls (to compare a replay with the live run).
//!
//! `.grill-eval/` is in the repository root (the nearest folder up from the
//! current one that has `.git`; the current folder when none has) and is
//! git-ignored: corpora and reports hold clients' conversations.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::{settings::SettingsMap, transcript::TranscriptChannel};

/// The version of the corpus format; a corpus of another one is refused.
pub const FORMAT: u32 = 1;

/// The folder of corpora, audio and reports.
pub const EVAL_DIR: &str = ".grill-eval";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Corpus {
    pub version: u32,
    pub name: String,
    pub origin: Origin,
    /// Whether «Я» and «Остальные» are the real channels.
    #[serde(default)]
    pub channels: Channels,
    /// `None` for a recording without a project.
    pub project: Option<Project>,
    /// The project's people, all of them.
    pub people: Vec<Person>,
    /// Ids of `people` on the call (empty: none picked).
    pub participant_ids: Vec<String>,
    /// The recording's glossary as the app built it (the full one); a
    /// replay rebuilds it from the project and the people.
    pub glossary: String,
    /// The settings the fast loop reads (`questionFrequency`,
    /// `questionCount`, `callLanguage`) when the corpus was made.
    #[serde(default)]
    pub settings: SettingsMap,
    pub recording: Recording,
    /// The live pass: what the fast loop saw, in time order.
    pub live: Vec<Segment>,
    /// The second pass, when the recording has one.
    #[serde(default)]
    pub refined: Option<Vec<Segment>>,
    /// What the live run of the call produced.
    #[serde(default)]
    pub original: Option<Original>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Origin {
    /// `grill-eval export`: a recording of the app's database.
    #[serde(rename_all = "camelCase")]
    Export {
        recording_id: String,
        /// Unix ms.
        exported_at: i64,
    },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Channels {
    /// Two channels as recorded: the manager's microphone and the system.
    #[default]
    Real,
    /// A mono recording split by the text (question-quality design.md,
    /// decision 2a): compare only with others split so.
    Approximate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub description: String,
    pub notes: String,
    /// As stored: the shape of `projects/brief/brief.schema.json`.
    pub brief: Option<Value>,
    /// The texts of the project's read documents (`grill-eval brief`).
    #[serde(default)]
    pub sources: Vec<SourceText>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceText {
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    pub role: String,
    pub profile: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recording {
    /// Unix ms.
    pub started_at: i64,
    pub duration_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub channel: TranscriptChannel,
    /// From the start of the recording.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// The live run, as stored by the app (camelCase, times in Unix ms).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Original {
    pub topics: Vec<Value>,
    pub questions: Vec<Value>,
    pub calls: Vec<Value>,
}

/// `.grill-eval` in the repository root that holds the current folder.
pub fn eval_dir() -> io::Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    let root = cwd
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(&cwd);
    Ok(root.join(EVAL_DIR))
}

/// A corpus or report name: a plain file name, so it stays in its folder.
pub fn check_name(name: &str) -> Result<(), String> {
    let plain = !name.trim().is_empty()
        && !name.starts_with('.')
        && !name.contains(['/', '\\', ':'])
        && name.trim() == name;
    if plain {
        Ok(())
    } else {
        Err(format!(
            "Имя «{name}» не годится для файла: без пробелов по краям, «/», «\\», «:» и точки в начале"
        ))
    }
}

/// Where the corpus `name` lives.
pub fn path_of(dir: &Path, name: &str) -> PathBuf {
    dir.join("corpus").join(format!("{name}.json"))
}

impl Corpus {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path)
            .map_err(|error| format!("Не удалось прочитать набор {}: {error}", path.display()))?;
        let value: Value = serde_json::from_str(&text)
            .map_err(|error| format!("Набор {} — не JSON: {error}", path.display()))?;
        let version = value.get("version").and_then(Value::as_u64);
        if version != Some(u64::from(FORMAT)) {
            return Err(format!(
                "Набор {} в формате {}, а grill-eval знает {FORMAT}",
                path.display(),
                version.map_or_else(|| "без версии".to_owned(), |v| v.to_string())
            ));
        }
        serde_json::from_value(value)
            .map_err(|error| format!("Набор {} не по формату: {error}", path.display()))
    }

    /// Writes the file whole or not at all (a temporary file renamed over
    /// it), creating its folder.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        write_json(path, self)
    }
}

/// `value` as pretty JSON at `path`, through a temporary file next to it.
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let failed =
        |error: &dyn std::fmt::Display| format!("Не удалось записать {}: {error}", path.display());
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| failed(&error))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|error| failed(&error))?;
    let temporary = path.with_extension("json.part");
    fs::write(&temporary, text).map_err(|error| failed(&error))?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        failed(&error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_plain_file_names() {
        assert!(check_name("obmennik-0511").is_ok());
        assert!(check_name("звонок 05.11").is_ok());
        for bad in ["", " x", "../x", "a/b", "a\\b", ".hidden", "c:x"] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn another_format_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.json");
        fs::write(&path, r#"{ "version": 99, "name": "old" }"#).unwrap();
        let error = Corpus::load(&path).unwrap_err();
        assert!(error.contains("в формате 99"), "{error}");
    }
}
