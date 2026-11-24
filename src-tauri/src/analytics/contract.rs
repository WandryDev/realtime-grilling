//! The events Grill sends to the team's analytics (call-analytics design.md,
//! decision 5). The one source of their shape: `cargo test` exports them to
//! `analytics/contract/src/generated.ts` and writes a sample of each to
//! `analytics/contract/fixtures`, which the server's schemas are checked
//! against.
//!
//! An event is a snapshot of its entity when it was written, not a delta:
//! the server keeps the latest by `at`. `questionEvent`, `findingEvent` and
//! `agentCallOp` are facts, each kept once by its id. Nothing here names the
//! manager: no name, mail or account of whoever ran Grill.
//!
//! Times are milliseconds since the Unix epoch, UTC, on the manager's
//! machine. The `i64`s cross as numbers (`#[specta(type = u32)]`), far below
//! 2^53. The JSON values Grill stores as they are cross as `unknown`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// The version of the contract this build writes.
pub const VERSION: u32 = 1;

/// One event: `{ id, v, kind, at, body }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    /// UUID v7: the server accepts an event once by it.
    pub id: String,
    pub v: u32,
    #[specta(type = u32)]
    pub at: i64,
    #[serde(flatten)]
    pub event: Event,
}

/// What happened, by kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", content = "body", rename_all = "camelCase")]
pub enum Event {
    Project(ProjectEvent),
    Call(CallEvent),
    Recording(RecordingEvent),
    Segment(SegmentEvent),
    RefinedTranscript(RefinedTranscriptEvent),
    Topic(TopicEvent),
    Card(CardEvent),
    Question(QuestionEvent),
    #[serde(rename = "questionEvent")]
    QuestionStep(QuestionStepEvent),
    Finding(FindingEvent),
    #[serde(rename = "findingEvent")]
    FindingStep(FindingStepEvent),
    PromptPart(PromptPartEvent),
    /// Boxed: by far the largest.
    AgentCall(Box<AgentCallEvent>),
    AgentCallOp(AgentCallOpEvent),
}

impl Event {
    /// The kind as it goes in the envelope.
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Project(_) => "project",
            Self::Call(_) => "call",
            Self::Recording(_) => "recording",
            Self::Segment(_) => "segment",
            Self::RefinedTranscript(_) => "refinedTranscript",
            Self::Topic(_) => "topic",
            Self::Card(_) => "card",
            Self::Question(_) => "question",
            Self::QuestionStep(_) => "questionEvent",
            Self::Finding(_) => "finding",
            Self::FindingStep(_) => "findingEvent",
            Self::PromptPart(_) => "promptPart",
            Self::AgentCall(_) => "agentCall",
            Self::AgentCallOp(_) => "agentCallOp",
        }
    }
}

/// A project, at its creation and at every rename. The server joins the
/// projects of the team by the normalized name; `localId` carries a
/// rename.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEvent {
    pub local_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CallStatus {
    Live,
    Finishing,
    Finished,
}

/// A call. `projectLocalId`: `null` for a call without a project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallEvent {
    pub id: String,
    pub project_local_id: Option<String>,
    pub title: String,
    pub status: CallStatus,
    #[specta(type = Option<u32>)]
    pub started_at: Option<i64>,
    #[specta(type = Option<u32>)]
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordingStatus {
    Recording,
    Finished,
    Interrupted,
}

/// A recording of a call (or without one).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingEvent {
    pub id: String,
    pub call_id: Option<String>,
    pub status: RecordingStatus,
    #[specta(type = u32)]
    pub started_at: i64,
    #[specta(type = Option<u32>)]
    pub ended_at: Option<i64>,
}

/// Whose audio a phrase came from: the manager's side («Я») or the
/// client's («Остальные»).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Channel {
    Me,
    Others,
}

/// A phrase of the live pass, as it was recognized during the call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SegmentEvent {
    pub id: String,
    pub recording_id: String,
    pub channel: Channel,
    /// From the recording's start.
    #[specta(type = u32)]
    pub start_ms: i64,
    #[specta(type = u32)]
    pub end_ms: i64,
    pub text: String,
}

/// A phrase of the refined transcript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RefinedSegment {
    pub id: String,
    pub channel: Channel,
    #[specta(type = u32)]
    pub start_ms: i64,
    #[specta(type = u32)]
    pub end_ms: i64,
    pub text: String,
}

/// The refined transcript of a recording, whole: a refine replaces it with
/// new ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RefinedTranscriptEvent {
    pub recording_id: String,
    pub segments: Vec<RefinedSegment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicEvent {
    pub id: String,
    pub recording_id: String,
    pub title: String,
    #[specta(type = u32)]
    pub created_at: i64,
}

/// The task card of a topic. `fields`: its facts with their evidence, as
/// Grill stores them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CardEvent {
    pub id: String,
    pub topic_id: String,
    pub recording_id: String,
    #[specta(type = specta_typescript::Unknown)]
    pub fields: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QuestionStatus {
    Open,
    Answered,
    Hidden,
    Asked,
}

/// A question of a recording as it is now. `evidence`, `answerEvidence`:
/// as Grill stores them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionEvent {
    pub id: String,
    pub recording_id: String,
    pub topic_id: Option<String>,
    pub text: String,
    pub description: String,
    pub card_field: Option<String>,
    pub gap_type: String,
    pub priority: i32,
    #[specta(type = specta_typescript::Unknown)]
    pub evidence: Value,
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub answer_evidence: Option<Value>,
    pub status: QuestionStatus,
    pub pinned: bool,
    #[specta(type = Option<u32>)]
    pub shown_at: Option<i64>,
    #[specta(type = u32)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QuestionStepKind {
    Created,
    Shown,
    Requeued,
    Unshown,
    Pinned,
    Unpinned,
    Hidden,
    Restored,
    Asked,
    Answered,
}

/// A step of a question. `agentCallId`: the call that did it; `null` for
/// the manager's actions and the window's own changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionStepEvent {
    pub id: String,
    pub question_id: String,
    pub recording_id: String,
    pub step: QuestionStepKind,
    pub agent_call_id: Option<String>,
    #[specta(type = u32)]
    pub at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    File,
    Outline,
    #[serde(rename = "clickup")]
    ClickUp,
}

/// A finding of the slow loop as it is now.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FindingEvent {
    pub id: String,
    pub recording_id: String,
    pub source_kind: SourceKind,
    pub source_name: String,
    pub source_url: Option<String>,
    pub chunk_key: String,
    pub quote: String,
    pub note: String,
    pub question_id: Option<String>,
    pub agent_call_id: Option<String>,
    #[specta(type = u32)]
    pub created_at: i64,
    #[specta(type = Option<u32>)]
    pub hidden_at: Option<i64>,
    #[specta(type = Option<u32>)]
    pub evicted_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FindingStepKind {
    Shown,
    Hidden,
    Evicted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FindingStepEvent {
    pub id: String,
    pub finding_id: String,
    pub recording_id: String,
    pub step: FindingStepKind,
    #[specta(type = u32)]
    pub at: i64,
}

/// The text of a part of a prompt, sent once however many calls carry it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptPartEvent {
    /// SHA-256 of `text`, hex.
    pub hash: String,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentCallKind {
    FastLoop,
    TopicCheck,
    SlowLoop,
    Summary,
    Proposals,
    Brief,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentCallOutcome {
    Ok,
    Empty,
    Invalid,
    Error,
    Timeout,
    RateLimited,
    NotLoggedIn,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CallTrigger {
    FirstPhrase,
    TurnEnd,
    Interval,
    Retry,
    ManualRetry,
    HaltReset,
    TopicChanged,
}

/// A part of a call's prompt: what it is and its text's hash
/// (`promptPart`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PromptPartRef {
    pub label: String,
    pub hash: String,
}

/// A chunk of the project's sources the slow loop showed the agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    /// `C1…`.
    pub label: String,
    pub rank: u32,
    pub chunk_key: String,
    pub source_kind: SourceKind,
    pub source_name: String,
    pub source_url: Option<String>,
    pub heading_path: Option<String>,
    pub text: String,
}

/// A call of the agent with what went in and came back. The owner by
/// `kind`: `recordingId` for the loops, `callId` for the summary and the
/// proposals, `projectLocalId` for the brief.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCallEvent {
    pub id: String,
    pub kind: AgentCallKind,
    pub recording_id: Option<String>,
    pub call_id: Option<String>,
    pub project_local_id: Option<String>,
    #[specta(type = u32)]
    pub started_at: i64,
    #[specta(type = u32)]
    pub duration_ms: i64,
    pub outcome: AgentCallOutcome,
    #[specta(type = Option<u32>)]
    pub input_tokens: Option<i64>,
    #[specta(type = Option<u32>)]
    pub output_tokens: Option<i64>,
    #[specta(type = Option<u32>)]
    pub cache_read: Option<i64>,
    #[specta(type = Option<u32>)]
    pub cache_write: Option<i64>,
    /// The equivalent at the API's prices.
    pub cost_usd: Option<f64>,
    /// Share of the subscription limit, 0–1.
    pub utilization: Option<f64>,
    pub error: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub trigger: Option<CallTrigger>,
    pub trigger_segment_id: Option<String>,
    /// The phrases that went into the prompt.
    pub window_segments: Option<Vec<String>>,
    /// The findings that went into the prompt, as it numbers them `D1…Dn`.
    pub findings_in_prompt: Option<Vec<String>>,
    /// The slow loop's queries.
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub queries: Option<Value>,
    /// The CLI's `result` event as it came.
    pub raw_reply: Option<String>,
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub reply: Option<Value>,
    pub parts: Vec<PromptPartRef>,
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SubjectKind {
    Question,
    Topic,
    Card,
    Finding,
}

/// An operation of a call's reply and what became of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentCallOpEvent {
    pub agent_call_id: String,
    pub idx: u32,
    pub op: String,
    #[specta(type = specta_typescript::Unknown)]
    pub body: Value,
    pub applied: bool,
    #[specta(type = Option<specta_typescript::Unknown>)]
    pub reason: Option<Value>,
    pub subject_kind: Option<SubjectKind>,
    pub subject_id: Option<String>,
}

#[cfg(test)]
mod tests;
