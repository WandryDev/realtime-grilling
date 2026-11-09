//! The raw results of a replay: `.grill-eval/reports/<time>-<label>/report.json`
//! (question-quality task 2.3). Every time is in ms from the start of the
//! call, so two runs of one corpus line up whatever their wall clocks were.
//! The metrics, `report.md` and `compare` read this file (task 2.5): it
//! keeps the questions, topics and calls as stored, not summaries of them.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use super::corpus::Channels;
use crate::{
    agent::fast_loop::events::AgentLoopState,
    error::CommandResult,
    storage::call_state::{self, AgentCallOutcome, CardLens, Evidence, GapType, QuestionStatus},
};

/// The version of the report format.
pub const FORMAT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    /// The corpus's name.
    pub corpus: String,
    pub label: String,
    /// `false` when the run stopped early (the agent not signed in, the
    /// limit used up): what came before is here, the rest of the call is
    /// not.
    pub complete: bool,
    /// Why it stopped early.
    pub stopped: Option<String>,
    pub channels: Channels,
    /// sha256 of the rules text the prefix opened with, hex.
    pub rules_sha256: String,
    pub flags: Flags,
    pub run: Run,
    pub topics: Vec<ReportTopic>,
    pub questions: Vec<ReportQuestion>,
    pub calls: Vec<ReportCall>,
    /// What the loop reported to its host, in order.
    pub log: Vec<LogEntry>,
}

/// How the run was started.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    /// `--from` / `--to`, minutes.
    pub from_min: Option<f64>,
    pub to_min: Option<f64>,
    pub realtime: bool,
    /// `--rules`: the file the rules came from; `null` for the built-in ones.
    pub rules_file: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    /// When the run started, Unix ms (the real clock).
    pub started_at: i64,
    /// How long it took, real ms.
    pub wall_ms: i64,
    /// The recording's start in the corpus, Unix ms: the zero of every
    /// `atMs`.
    pub call_started_at: i64,
    /// Live segments of the corpus in `--from`…`--to`, and how many of them
    /// the loop got before the run ended.
    pub segments: usize,
    pub segments_fed: usize,
    /// Where the fed phrases ended, ms from the start of the call.
    pub last_fed_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTopic {
    pub id: String,
    pub title: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportQuestion {
    pub id: String,
    /// When the agent added it.
    pub at_ms: i64,
    /// When it last became visible; `null` when it isn't at the end.
    pub shown_at_ms: Option<i64>,
    pub topic_id: Option<String>,
    pub topic: Option<String>,
    pub card_field: Option<CardLens>,
    pub gap_type: GapType,
    pub priority: i32,
    pub text: String,
    pub description: String,
    /// Segment ids are the corpus's.
    pub evidence: Vec<Evidence>,
    /// Its state at the end of the run.
    pub status: QuestionStatus,
    pub answer_evidence: Option<Vec<Evidence>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCall {
    pub at_ms: i64,
    pub duration_ms: i64,
    pub outcome: AgentCallOutcome,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    pub cost_usd: Option<f64>,
    /// The operations the checks rejected, with their reasons, as stored
    /// (`validate::Rejection`).
    pub rejected: Value,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at_ms: i64,
    #[serde(flatten)]
    pub event: LogEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum LogEvent {
    CallStateChanged,
    AgentStatus { state: AgentLoopState },
}

/// The topics, questions and calls of `recording_id`, times from
/// `call_started_at`.
pub fn results(
    connection: &Connection,
    recording_id: &str,
    call_started_at: i64,
) -> CommandResult<(Vec<ReportTopic>, Vec<ReportQuestion>, Vec<ReportCall>)> {
    let since = |at: i64| at - call_started_at;
    let state = call_state::get(connection, recording_id)?;
    let titles: HashMap<&str, &str> = state
        .topics
        .iter()
        .map(|topic| (topic.id.as_str(), topic.title.as_str()))
        .collect();
    let topics = state
        .topics
        .iter()
        .map(|topic| ReportTopic {
            id: topic.id.clone(),
            title: topic.title.clone(),
            at_ms: since(topic.created_at),
        })
        .collect();
    let questions = state
        .questions
        .iter()
        .map(|question| ReportQuestion {
            id: question.id.clone(),
            at_ms: since(question.created_at),
            shown_at_ms: question.shown_at.map(since),
            topic_id: question.topic_id.clone(),
            topic: question
                .topic_id
                .as_deref()
                .and_then(|id| titles.get(id))
                .map(|title| (*title).to_owned()),
            card_field: question.card_field,
            gap_type: question.gap_type,
            priority: question.priority,
            text: question.text.clone(),
            description: question.description.clone(),
            evidence: question.evidence.clone(),
            status: question.status,
            answer_evidence: question.answer_evidence.clone(),
        })
        .collect();
    let calls = call_state::agent_calls(connection, recording_id)?
        .into_iter()
        .map(|call| ReportCall {
            at_ms: since(call.started_at),
            duration_ms: call.duration_ms,
            outcome: call.outcome,
            input_tokens: call.input_tokens,
            output_tokens: call.output_tokens,
            cache_read: call.cache_read,
            cache_write: call.cache_write,
            cost_usd: call.cost_usd,
            rejected: call.rejected,
            error: call.error,
        })
        .collect();
    Ok((topics, questions, calls))
}

/// sha256 of `text`, hex.
pub fn sha256_hex(text: &str) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_is_sha256() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
