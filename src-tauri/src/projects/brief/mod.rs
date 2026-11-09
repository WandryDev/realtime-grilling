//! The project brief (`specs/project-brief`; projects-people-brief
//! design.md, decisions 4–6, 8 and 9): its shape, how the agent builds it
//! and how it is exported.
//!
//! `brief.schema.json` goes to the CLI (`--json-schema`); [`Brief`] reads
//! the reply and agrees with the schema (a test runs the same examples
//! through both). The agent names documents `F1…Fn`; the saved brief has the
//! documents' real ids, and only of the project's `ready` documents.
//! `glossary[].term` and `stack[]` are what `speech/glossary.rs` reads;
//! `fast_loop/assembly.rs` numbers every field but `keyDocuments` and
//! `gaps`; the gaps go to their own section (`G1…Gn`).

pub mod export;
pub mod input;
pub mod run;

use std::{collections::HashMap, sync::LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri_specta::Event;

use crate::storage::call_state::CardLens;

/// The JSON Schema of the agent's reply.
pub const BRIEF_SCHEMA: &str = include_str!("brief.schema.json");

/// The rules of the build, in Russian: the CLI's system prompt file.
pub const PROMPT: &str = include_str!("prompt.md");

/// At most this many gaps (`gaps.maxItems` of the schema); the rest go.
pub const MAX_GAPS: usize = 10;
/// A gap's text is cut to this many characters (`maxLength` of the schema).
pub const MAX_GAP_CHARS: usize = 200;

/// [`BRIEF_SCHEMA`] on one line without spaces, as `--json-schema` takes it:
/// it stays on the command line, so it is kept under 4 KB.
pub fn schema_argument() -> &'static str {
    static MINIFIED: LazyLock<String> = LazyLock::new(|| {
        let schema: Value =
            serde_json::from_str(BRIEF_SCHEMA).expect("brief.schema.json is valid JSON");
        schema.to_string()
    });
    &MINIFIED
}

/// The brief as the agent gives it and as `projects.brief` stores it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Brief {
    /// What the product is and for whom.
    pub product: String,
    pub stack: Vec<String>,
    pub modules: Vec<BriefModule>,
    /// Project terms and names; recognition is prompted with the terms.
    pub glossary: Vec<GlossaryEntry>,
    pub key_documents: Vec<KeyDocument>,
    /// «Неясно до звонка»: what the materials lack to estimate or build the
    /// product. A brief built before them has none.
    #[serde(default)]
    pub gaps: Vec<BriefGap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefModule {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlossaryEntry {
    pub term: String,
    pub definition: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyDocument {
    /// A `ready` document of the project (`F1…` in the agent's reply).
    pub source_id: String,
    pub title: String,
    pub why: String,
}

/// A gap of the materials, about one lens of the task card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BriefGap {
    pub lens: CardLens,
    pub text: String,
}

impl Brief {
    /// The agent's reply as a brief: `Invalid` text when it is not one.
    pub fn from_reply(reply: Value) -> Result<Self, String> {
        let mut brief: Self = serde_json::from_value(reply).map_err(|error| error.to_string())?;
        brief.tidy();
        Ok(brief)
    }

    /// Trims every text and drops entries without a name.
    fn tidy(&mut self) {
        let trim = |text: &mut String| *text = text.trim().to_owned();
        trim(&mut self.product);
        self.stack.iter_mut().for_each(trim);
        self.stack.retain(|item| !item.is_empty());
        for module in &mut self.modules {
            trim(&mut module.name);
            trim(&mut module.description);
        }
        self.modules.retain(|module| !module.name.is_empty());
        for entry in &mut self.glossary {
            trim(&mut entry.term);
            trim(&mut entry.definition);
        }
        self.glossary.retain(|entry| !entry.term.is_empty());
        for document in &mut self.key_documents {
            trim(&mut document.source_id);
            trim(&mut document.title);
            trim(&mut document.why);
        }
        for gap in &mut self.gaps {
            trim(&mut gap.text);
            if let Some((cut, _)) = gap.text.char_indices().nth(MAX_GAP_CHARS) {
                gap.text.truncate(cut);
                gap.text = gap.text.trim_end().to_owned();
            }
        }
        self.gaps.retain(|gap| !gap.text.is_empty());
        self.gaps.truncate(MAX_GAPS);
    }

    /// `F1…` of the reply to the documents' ids (`ids[n]` for `F{n+1}`);
    /// an `F` that is not in the list is dropped, and so is a document
    /// named twice.
    pub fn resolve_documents(&mut self, ids: &HashMap<String, String>) {
        let mut seen = Vec::new();
        self.key_documents.retain_mut(|document| {
            let Some(id) = ids.get(&document.source_id) else {
                return false;
            };
            if seen.contains(id) {
                return false;
            }
            seen.push(id.clone());
            document.source_id.clone_from(id);
            true
        });
    }

    /// Drops the key documents that are not among `ready` (the project's
    /// readable documents at the time of saving).
    pub fn keep_documents(&mut self, ready: &[String]) {
        self.key_documents
            .retain(|document| ready.contains(&document.source_id));
    }
}

/// Where a brief build is (design.md, decision 6). Sent to every window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct BriefProgress {
    pub project_id: String,
    /// 1 reading the documents, 2 starting the agent, 3 the agent reads,
    /// 4 the agent writes, 5 checking and saving.
    pub stage: u8,
    pub state: BriefStageState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum BriefStageState {
    Running,
    Done,
    /// The build ended here; the old brief stays.
    Failed {
        message: String,
    },
    /// `brief_cancel`; the old brief stays.
    Cancelled,
}

#[cfg(test)]
mod tests;

/// The build against a fake `claude` script, never the real CLI.
#[cfg(all(test, unix))]
mod fake_cli_tests;
