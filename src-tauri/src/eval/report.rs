//! The raw results of a replay: `.grill-eval/reports/<time>-<label>/report.json`
//! (question-quality task 2.3). Every time is in ms from the start of the
//! call, so two runs of one corpus line up whatever their wall clocks were.
//! The metrics, `report.md` and `compare` read this file (task 2.5): it
//! keeps the questions, topics and calls as stored, not summaries of them.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::corpus::{Channels, Corpus};
use crate::{
    agent::fast_loop::events::AgentLoopState,
    error::CommandResult,
    storage::{
        call_state::{self, AgentCallOutcome, CardLens, Evidence, GapType, QuestionStatus},
        transcript::TranscriptChannel,
    },
};

/// The version of the report format. In 1 `shownAtMs` was when a question
/// was visible at the end of the run; since 2 it is when it was first shown.
pub const FORMAT: u32 = 2;

/// The raw results in a report's folder.
pub const REPORT_FILE: &str = "report.json";
/// The metrics in Markdown, next to it (replay writes it, judge rewrites it).
pub const MARKDOWN_FILE: &str = "report.md";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    /// The corpus's name.
    pub corpus: String,
    /// The corpus's file the run read; `judge` reads it again. Older
    /// reports have none: then the corpus is looked up by name.
    #[serde(default)]
    pub corpus_path: Option<String>,
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
    /// The live segments the loop got, without their text: the metrics
    /// count the client's phrases in a pause. A report written before them
    /// has none.
    #[serde(default)]
    pub phrases: Vec<Phrase>,
    /// The corpus's end of the discussion, ms from the call's start. A
    /// report without it takes the corpus's when loaded, so a mark set
    /// later applies to the runs made before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub discussion_end_ms: Option<i64>,
}

/// How the run was started.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Flags {
    /// `--from` / `--to`, minutes.
    pub from_min: Option<f64>,
    pub to_min: Option<f64>,
    pub realtime: bool,
    /// `--rules`: the file the rules came from; `null` for the built-in ones.
    pub rules_file: Option<String>,
    /// `--baseline-state`: the state without its empty lenses and pause
    /// line (question-quality design.md, decision 7).
    #[serde(default)]
    pub baseline_state: bool,
    /// `--no-gaps`: the brief without its gaps.
    #[serde(default)]
    pub no_gaps: bool,
    /// `--quiet-minutes`: the pause threshold; `null` for the built-in one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quiet_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_gap_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requeue_minutes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_check: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportTopic {
    pub id: String,
    pub title: String,
    pub at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportQuestion {
    pub id: String,
    /// When the agent added it.
    pub at_ms: i64,
    /// When it first became visible (in the list of the windows or the
    /// final check); `null` when it never was: it waited behind a full list
    /// to the end. The judge, the coverage and the metrics count only the
    /// shown ones, from this time.
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCall {
    /// Fast loop or topic check; reports before the topic check have only
    /// fast-loop calls.
    #[serde(default)]
    pub kind: CallKind,
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

/// What an agent call was for.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CallKind {
    #[default]
    FastLoop,
    TopicCheck,
    /// The slow loop's search in the project's sources (a replay doesn't
    /// run it; an export of a real recording has them).
    SlowLoop,
}

/// A live segment fed to the loop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phrase {
    pub id: String,
    pub channel: TranscriptChannel,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub at_ms: i64,
    #[serde(flatten)]
    pub event: LogEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum LogEvent {
    CallStateChanged,
    AgentStatus { state: AgentLoopState },
}

impl Report {
    /// `report.json` at `path`, or in the folder `path`.
    pub fn load(path: &Path) -> Result<Self, String> {
        let file = file_of(path);
        let text = fs::read_to_string(&file)
            .map_err(|error| format!("Не удалось прочитать отчёт {}: {error}", file.display()))?;
        let mut report: Self = serde_json::from_str(&text)
            .map_err(|error| format!("Отчёт {} не по формату: {error}", file.display()))?;
        if report.version < 2 {
            // Format 1 didn't track the shown time: every question counted
            // as shown when it was added, as its metrics did.
            for question in &mut report.questions {
                question.shown_at_ms = Some(question.at_ms);
            }
        }
        if report.discussion_end_ms.is_none() {
            report.discussion_end_ms = report
                .corpus_path
                .as_deref()
                .and_then(|corpus| Corpus::load(Path::new(corpus)).ok())
                .and_then(|corpus| corpus.discussion_end_ms);
        }
        Ok(report)
    }

    /// The questions that were shown, with their first shown time, in the
    /// report's order.
    pub fn shown(&self) -> impl Iterator<Item = (&ReportQuestion, i64)> {
        self.questions
            .iter()
            .filter_map(|question| Some((question, question.shown_at_ms?)))
    }

    /// The questions that were never shown.
    pub fn never_shown(&self) -> impl Iterator<Item = &ReportQuestion> {
        self.questions
            .iter()
            .filter(|question| question.shown_at_ms.is_none())
    }
}

/// The report's file: `path` itself, or `report.json` in the folder `path`.
pub fn file_of(path: &Path) -> PathBuf {
    if path.is_dir() {
        path.join(REPORT_FILE)
    } else {
        path.to_owned()
    }
}

/// The topics, questions and calls of `recording_id`, times from
/// `call_started_at`; `first_shown` is when each question was first shown,
/// already from `call_started_at`.
pub fn results(
    connection: &Connection,
    recording_id: &str,
    call_started_at: i64,
    first_shown: &HashMap<String, i64>,
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
            shown_at_ms: first_shown.get(&question.id).copied(),
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
            kind: match call.kind {
                call_state::AgentCallKind::FastLoop => CallKind::FastLoop,
                call_state::AgentCallKind::TopicCheck => CallKind::TopicCheck,
                call_state::AgentCallKind::SlowLoop => CallKind::SlowLoop,
            },
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

    /// Format 1 had no shown time: every question counts as shown when it
    /// was added, as its metrics did; format 2 keeps a never shown one.
    #[test]
    fn a_report_of_format_1_counts_every_question_as_shown() {
        use crate::eval::testing::{never_shown, report_with};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(REPORT_FILE);
        let mut report = report_with(
            Vec::new(),
            vec![never_shown("q1", 60_000, "t1", "Кто дежурит ночью?")],
            Vec::new(),
        );

        fs::write(&path, serde_json::to_string(&report).unwrap()).unwrap();
        assert_eq!(Report::load(dir.path()).unwrap().shown().count(), 0);

        report.version = 1;
        fs::write(&path, serde_json::to_string(&report).unwrap()).unwrap();
        let loaded = Report::load(dir.path()).unwrap();
        assert_eq!(loaded.questions[0].shown_at_ms, Some(60_000));
    }

    #[test]
    fn the_hash_is_sha256() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
