//! The state of a call by recording (agent-fast-loop design.md, decisions
//! 7–9): topics, their task cards, the questions with their visible list,
//! the final check and the agent calls.
//!
//! Only the backend writes it: the fast loop applies a patch it has already
//! checked ([`apply_patch`]), the windows send quick actions ([`act`]). After
//! every change the visible list is recomputed here, so every window shows
//! the same questions in the same order. Nothing here sends `DataChanged`;
//! the caller sends `CallStateChanged` once the transaction committed.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{
    context_findings::{self, ContextFinding, ContextSearch, ContextSources},
    json::Json,
    new_id, now_ms, recordings, settings,
};
use crate::error::{CommandError, CommandResult};

/* Evidence */

/// What a quote comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EvidenceSource {
    /// A transcript segment of the recording (`id`: the segment id).
    Segment,
    /// The project: its description `P1` or a brief item `B1…Bn`.
    Project,
    /// A finding of the slow loop in the project's sources (`id`: the
    /// finding's id; the agent sees it as `D1…Dn`).
    Document,
}

/// Where a question, a card field or an answer comes from: the source and a
/// short quote of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub source: EvidenceSource,
    pub id: String,
    pub quote: String,
}

/// Why a question is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum GapType {
    /// Nothing is known about the card field yet.
    Empty,
    /// The client said something that is only assumed.
    Assumption,
    /// Two phrases of the client disagree; the evidence names both.
    Contradiction,
}

impl GapType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Empty => "empty",
            Self::Assumption => "assumption",
            Self::Contradiction => "contradiction",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "empty" => Ok(Self::Empty),
            "assumption" => Ok(Self::Assumption),
            "contradiction" => Ok(Self::Contradiction),
            other => Err(conversion(format!("unknown gap type {other}"))),
        }
    }
}

/// A lens of the task card (`docs/concept.md`): what a card field, and a
/// question about it, is about. Stable ascii ids; the screens show them in
/// Russian.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CardLens {
    /// Цель: why the business needs it.
    Goal,
    /// Пользователи: who uses it and whom it touches.
    Users,
    /// Сценарии: the main flows.
    Scenarios,
    /// Крайние случаи.
    EdgeCases,
    /// Интеграции: systems and data.
    Integrations,
    /// Ограничения: deadlines, budget, law, technology.
    Constraints,
    /// Критерии готовности.
    Acceptance,
}

impl CardLens {
    pub const ALL: [Self; 7] = [
        Self::Goal,
        Self::Users,
        Self::Scenarios,
        Self::EdgeCases,
        Self::Integrations,
        Self::Constraints,
        Self::Acceptance,
    ];

    /// The id the patch, the storage and the windows use.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Goal => "goal",
            Self::Users => "users",
            Self::Scenarios => "scenarios",
            Self::EdgeCases => "edgeCases",
            Self::Integrations => "integrations",
            Self::Constraints => "constraints",
            Self::Acceptance => "acceptance",
        }
    }

    /// The lens in Russian, as the rules of the fast loop name it.
    pub fn label(self) -> &'static str {
        match self {
            Self::Goal => "цель",
            Self::Users => "пользователи",
            Self::Scenarios => "сценарии",
            Self::EdgeCases => "крайние случаи",
            Self::Integrations => "интеграции",
            Self::Constraints => "ограничения",
            Self::Acceptance => "критерии готовности",
        }
    }

    /// The lens of an id ([`Self::as_str`]), if it is one.
    pub fn from_id(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|lens| lens.as_str() == text)
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        Self::ALL
            .into_iter()
            .find(|lens| lens.as_str() == text)
            .ok_or_else(|| conversion(format!("unknown card lens {text}")))
    }
}

/* Records */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QuestionStatus {
    Open,
    /// The agent saw the answer (`answerEvidence`).
    Answered,
    /// The manager hid it; the agent must not suggest it again.
    Hidden,
    /// The manager marked it asked.
    Asked,
}

impl QuestionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Answered => "answered",
            Self::Hidden => "hidden",
            Self::Asked => "asked",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "open" => Ok(Self::Open),
            "answered" => Ok(Self::Answered),
            "hidden" => Ok(Self::Hidden),
            "asked" => Ok(Self::Asked),
            other => Err(conversion(format!("unknown question status {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TaskCardDecision {
    Pending,
    Accepted,
    Discarded,
}

impl TaskCardDecision {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Discarded => "discarded",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "discarded" => Ok(Self::Discarded),
            other => Err(conversion(format!("unknown task card decision {other}"))),
        }
    }
}

pub(super) fn conversion(message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, message.into())
}

/// A topic of the conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub recording_id: String,
    /// The recording's call when the topic was written.
    pub call_id: Option<String>,
    pub title: String,
    /// Order within the recording, ascending.
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A field of a task card with what it is based on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CardField {
    pub field: CardLens,
    pub value: String,
    pub evidence: Vec<Evidence>,
    pub updated_at: i64,
}

/// The task card of a topic (one per topic).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCard {
    pub id: String,
    pub topic_id: String,
    pub recording_id: String,
    pub call_id: Option<String>,
    pub title: String,
    /// In the order they were first set.
    pub fields: Vec<CardField>,
    pub decision: TaskCardDecision,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub recording_id: String,
    pub call_id: Option<String>,
    pub topic_id: Option<String>,
    pub card_id: Option<String>,
    pub text: String,
    pub description: String,
    /// The field of the topic's card the question is about.
    pub card_field: Option<CardLens>,
    pub gap_type: GapType,
    /// 1–3, higher comes first.
    pub priority: i32,
    pub evidence: Vec<Evidence>,
    /// The quote of the answer, once `answered`.
    pub answer_evidence: Option<Vec<Evidence>>,
    pub status: QuestionStatus,
    pub pinned: bool,
    /// When it became visible; `null` while it waits or after it left.
    pub shown_at: Option<i64>,
    /// In the visible list of the call window and the overlay.
    pub visible: bool,
    /// Place in the visible list from 0 (the main question); `null` when
    /// not visible.
    pub rank: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The final check (decision 8): the most important open questions of all
/// topics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FinalCheck {
    pub started_at: i64,
    /// Top `questionCount` open questions of all topics by priority, then
    /// oldest first.
    pub question_ids: Vec<String>,
}

/// Everything the windows and the agent need about a recording's call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallState {
    pub recording_id: String,
    /// In order.
    pub topics: Vec<Topic>,
    pub current_topic_id: Option<String>,
    /// In topic order.
    pub cards: Vec<TaskCard>,
    /// Every question of the recording, oldest first.
    pub questions: Vec<Question>,
    /// Set once the agent started the final check.
    pub final_check: Option<FinalCheck>,
    /// The slow loop's visible findings, the newest first
    /// (agent-slow-loop design.md, decision 7).
    pub findings: Vec<ContextFinding>,
    /// The slow loop's search while the live pass runs; `null` when it
    /// doesn't search (no live pass, no ready sources).
    pub context_search: Option<ContextSearch>,
    /// The ready sources of the recording's project the slow loop searches.
    pub context_sources: ContextSources,
}

impl CallState {
    /// The card of the current topic, if it has one.
    pub fn current_card(&self) -> Option<&TaskCard> {
        let topic_id = self.current_topic_id.as_deref()?;
        self.cards.iter().find(|card| card.topic_id == topic_id)
    }

    /// The visible questions in their order (rank 0 first).
    #[cfg(test)]
    pub fn visible(&self) -> Vec<&Question> {
        let mut visible: Vec<&Question> = self.questions.iter().filter(|q| q.visible).collect();
        visible.sort_by_key(|question| question.rank);
        visible
    }
}

/* The checked patch */

/// A patch of the agent after the checks of the fast loop: only what may be
/// applied, in the order of the patch. [`apply_patch`] applies it in one
/// transaction; a step that does not fit the stored state fails the whole
/// patch with `Invalid`. The fast loop checks the patch again against the
/// state of that transaction, so a quick action that came during the call
/// drops only the steps it made stale.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ValidatedPatch {
    pub ops: Vec<ValidatedOp>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidatedOp {
    /// A new topic after the others; it becomes the current one.
    CreateTopic { title: String },
    /// Makes a topic of the recording the current one.
    SwitchTopic { topic_id: String },
    /// Sets a field of the current topic's card (the card is created with
    /// its first field).
    SetCardField {
        field: CardLens,
        value: String,
        evidence: Vec<Evidence>,
    },
    /// A new open question of the current topic, about a field of its card.
    AddQuestion(NewQuestion),
    /// An open or asked question of the recording is answered.
    MarkAnswered {
        question_id: String,
        evidence: Vec<Evidence>,
    },
    /// Starts the final check; a started one stays as it is.
    StartFinalCheck,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewQuestion {
    pub text: String,
    pub description: String,
    pub card_field: CardLens,
    pub gap_type: GapType,
    /// 1–3, higher comes first.
    pub priority: i32,
    pub evidence: Vec<Evidence>,
}

/// What [`apply_patch`] created.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppliedPatch {
    pub topic_ids: Vec<String>,
    pub question_ids: Vec<String>,
}

/* Quick actions */

/// «Закрепить», «Открепить», «Скрыть», «Задал», «Вернуть».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QuestionAction {
    Pin,
    Unpin,
    Hide,
    Asked,
    Restore,
}

/* Agent calls */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AgentCallOutcome {
    /// A patch with operations was applied (some may have been rejected).
    Ok,
    /// An empty patch, or every operation was rejected.
    Empty,
    /// The reply did not match the patch schema.
    Invalid,
    Error,
    Timeout,
    RateLimited,
    NotLoggedIn,
    /// The recording stopped, or the app quit, while the call ran.
    Cancelled,
}

impl AgentCallOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Empty => "empty",
            Self::Invalid => "invalid",
            Self::Error => "error",
            Self::Timeout => "timeout",
            Self::RateLimited => "rate_limited",
            Self::NotLoggedIn => "not_logged_in",
            Self::Cancelled => "cancelled",
        }
    }

    #[cfg(any(test, feature = "eval"))]
    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "ok" => Ok(Self::Ok),
            "empty" => Ok(Self::Empty),
            "invalid" => Ok(Self::Invalid),
            "error" => Ok(Self::Error),
            "timeout" => Ok(Self::Timeout),
            "rate_limited" => Ok(Self::RateLimited),
            "not_logged_in" => Ok(Self::NotLoggedIn),
            "cancelled" => Ok(Self::Cancelled),
            other => Err(conversion(format!("unknown agent call outcome {other}"))),
        }
    }
}

/// What an agent call was for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum AgentCallKind {
    /// The fast loop's call that patches the call's state.
    #[default]
    FastLoop,
    /// The short call that asks whether the topic changed
    /// (question-volume design.md, decision 2).
    TopicCheck,
    /// The slow loop's search in the project's sources (agent-slow-loop
    /// design.md, decision 3).
    SlowLoop,
}

impl AgentCallKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::FastLoop => "fastLoop",
            Self::TopicCheck => "topicCheck",
            Self::SlowLoop => "slowLoop",
        }
    }

    #[cfg(any(test, feature = "eval"))]
    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "fastLoop" => Ok(Self::FastLoop),
            "topicCheck" => Ok(Self::TopicCheck),
            "slowLoop" => Ok(Self::SlowLoop),
            other => Err(rusqlite::Error::InvalidColumnType(
                0,
                format!("kind {other}"),
                rusqlite::types::Type::Text,
            )),
        }
    }
}

/// One call of the agent, as the fast loop records it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentCallInput {
    pub recording_id: String,
    pub kind: AgentCallKind,
    /// Milliseconds since the Unix epoch, UTC.
    pub started_at: i64,
    pub duration_ms: i64,
    pub outcome: Option<AgentCallOutcome>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    pub cost_usd: Option<f64>,
    /// Share of the subscription limit used, 0–1.
    pub utilization: Option<f64>,
    /// The rejected operations with their reasons: a JSON array (`[]` when
    /// `null`).
    pub rejected: Value,
    pub error: Option<String>,
}

/// A recorded agent call (read by the tests and `grill-eval`; the windows
/// don't need it).
#[cfg(any(test, feature = "eval"))]
#[derive(Debug, Clone, PartialEq)]
pub struct AgentCall {
    pub id: String,
    pub recording_id: String,
    pub started_at: i64,
    pub duration_ms: i64,
    pub outcome: AgentCallOutcome,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read: Option<i64>,
    pub cache_write: Option<i64>,
    pub cost_usd: Option<f64>,
    pub utilization: Option<f64>,
    pub rejected: Value,
    pub error: Option<String>,
    pub created_at: i64,
    pub kind: AgentCallKind,
}

/* Reading */

struct RecordingRow {
    call_id: Option<String>,
    current_topic_id: Option<String>,
    final_check_at: Option<i64>,
}

fn recording_row(connection: &Connection, recording_id: &str) -> CommandResult<RecordingRow> {
    connection
        .query_row(
            "SELECT call_id, current_topic_id, final_check_at FROM recordings WHERE id = ?1",
            [recording_id],
            |row| {
                Ok(RecordingRow {
                    call_id: row.get(0)?,
                    current_topic_id: row.get(1)?,
                    final_check_at: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| recordings::not_found(recording_id))
}

fn topic_from_row(row: &Row) -> rusqlite::Result<Topic> {
    Ok(Topic {
        id: row.get(0)?,
        recording_id: row.get(1)?,
        call_id: row.get(2)?,
        title: row.get(3)?,
        position: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn topics(connection: &Connection, recording_id: &str) -> CommandResult<Vec<Topic>> {
    let mut statement = connection.prepare(
        "SELECT id, recording_id, call_id, title, position, created_at, updated_at
           FROM topics WHERE recording_id = ?1 ORDER BY position, id",
    )?;
    let rows = statement.query_map([recording_id], topic_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A JSON column read into a typed value.
pub(super) fn typed<T: serde::de::DeserializeOwned>(
    value: Value,
    column: usize,
) -> rusqlite::Result<T> {
    serde_json::from_value(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, error.into())
    })
}

pub(super) const CARD_COLUMNS: &str =
    "id, topic_id, recording_id, call_id, title, fields, decision,
       created_at, updated_at";

pub(super) fn card_from_row(row: &Row) -> rusqlite::Result<TaskCard> {
    let Json(fields) = row.get(5)?;
    let decision: String = row.get(6)?;
    Ok(TaskCard {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        recording_id: row.get(2)?,
        call_id: row.get(3)?,
        title: row.get(4)?,
        fields: typed(fields, 5)?,
        decision: TaskCardDecision::parse(&decision)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn cards(connection: &Connection, recording_id: &str) -> CommandResult<Vec<TaskCard>> {
    let mut statement = connection.prepare(
        "SELECT k.id, k.topic_id, k.recording_id, k.call_id, k.title, k.fields, k.decision,
                k.created_at, k.updated_at
           FROM task_cards k JOIN topics t ON t.id = k.topic_id
          WHERE k.recording_id = ?1 ORDER BY t.position, k.id",
    )?;
    let rows = statement.query_map([recording_id], card_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn card_of_topic(connection: &Connection, topic_id: &str) -> CommandResult<Option<TaskCard>> {
    Ok(connection
        .query_row(
            &format!("SELECT {CARD_COLUMNS} FROM task_cards WHERE topic_id = ?1"),
            [topic_id],
            card_from_row,
        )
        .optional()?)
}

pub(super) const QUESTION_COLUMNS: &str =
    "id, recording_id, call_id, topic_id, card_id, text, description,
       card_field, gap_type, priority, evidence, answer_evidence, status, pinned, shown_at,
       created_at, updated_at";

pub(super) fn question_from_row(row: &Row) -> rusqlite::Result<Question> {
    let gap_type: String = row.get(8)?;
    let Json(evidence) = row.get(10)?;
    let answer_evidence: Option<Json> = row.get(11)?;
    let status: String = row.get(12)?;
    let card_field: Option<String> = row.get(7)?;
    Ok(Question {
        id: row.get(0)?,
        recording_id: row.get(1)?,
        call_id: row.get(2)?,
        topic_id: row.get(3)?,
        card_id: row.get(4)?,
        text: row.get(5)?,
        description: row.get(6)?,
        card_field: card_field.as_deref().map(CardLens::parse).transpose()?,
        gap_type: GapType::parse(&gap_type)?,
        priority: row.get(9)?,
        evidence: typed(evidence, 10)?,
        answer_evidence: answer_evidence
            .map(|Json(value)| typed(value, 11))
            .transpose()?,
        status: QuestionStatus::parse(&status)?,
        pinned: row.get(13)?,
        shown_at: row.get(14)?,
        visible: false,
        rank: None,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn questions(connection: &Connection, recording_id: &str) -> CommandResult<Vec<Question>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {QUESTION_COLUMNS} FROM questions WHERE recording_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map([recording_id], question_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn question(connection: &Connection, id: &str) -> CommandResult<Question> {
    connection
        .query_row(
            &format!("SELECT {QUESTION_COLUMNS} FROM questions WHERE id = ?1"),
            [id],
            question_from_row,
        )
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Вопрос {id} не найден")))
}

/// How the visible list is made, from the settings.
#[derive(Debug, Clone, Copy)]
struct ListRules {
    /// `questionCount`.
    count: usize,
    /// `questionRequeueMinutes`, ms.
    requeue_after_ms: i64,
}

fn list_rules(connection: &Connection) -> CommandResult<ListRules> {
    let settings = settings::get(connection)?;
    Ok(ListRules {
        count: settings::question_count(&settings),
        requeue_after_ms: settings::question_requeue_ms(&settings),
    })
}

/// `questionCount` from the settings.
fn question_count(connection: &Connection) -> CommandResult<usize> {
    Ok(list_rules(connection)?.count)
}

/// The whole state of a recording's call. `NotFound` for an unknown
/// recording.
///
/// `visible` / `rank` are the list [`recompute_visible`] stored: every
/// pinned question, then the others up to `questionCount` (a lowered
/// setting shows fewer at once).
pub fn get(connection: &Connection, recording_id: &str) -> CommandResult<CallState> {
    let recording = recording_row(connection, recording_id)?;
    let count = question_count(connection)?;
    let mut questions = questions(connection, recording_id)?;
    let mut shown: Vec<usize> = (0..questions.len())
        .filter(|&index| {
            let question = &questions[index];
            question.status == QuestionStatus::Open && question.shown_at.is_some()
        })
        .collect();
    shown.sort_by_key(|&index| {
        let question = &questions[index];
        (!question.pinned, question.shown_at, question.id.clone())
    });
    let pinned = shown
        .iter()
        .filter(|&&index| questions[index].pinned)
        .count();
    let room = pinned.max(count);
    for (rank, index) in shown.into_iter().take(room).enumerate() {
        questions[index].visible = true;
        questions[index].rank = u32::try_from(rank).ok();
    }
    let final_check = recording.final_check_at.map(|started_at| FinalCheck {
        started_at,
        question_ids: final_check_ids(&questions, count),
    });
    Ok(CallState {
        recording_id: recording_id.to_owned(),
        topics: topics(connection, recording_id)?,
        current_topic_id: recording.current_topic_id,
        cards: cards(connection, recording_id)?,
        questions,
        final_check,
        findings: context_findings::visible(connection, recording_id)?,
        context_search: None,
        context_sources: context_findings::source_counts(connection, recording_id)?,
    })
}

/// Top `count` open questions of all topics: by priority, then oldest first.
fn final_check_ids(questions: &[Question], count: usize) -> Vec<String> {
    let mut open: Vec<&Question> = questions
        .iter()
        .filter(|question| question.status == QuestionStatus::Open)
        .collect();
    open.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
    open.into_iter()
        .take(count)
        .map(|question| question.id.clone())
        .collect()
}

/* Writing */

/// Runs `work` in a savepoint: atomic inside or outside a transaction.
pub(super) fn in_savepoint<T>(
    connection: &Connection,
    work: impl FnOnce() -> CommandResult<T>,
) -> CommandResult<T> {
    connection.execute_batch("SAVEPOINT call_state")?;
    match work() {
        Ok(value) => {
            connection.execute_batch("RELEASE call_state")?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback) =
                connection.execute_batch("ROLLBACK TO call_state; RELEASE call_state")
            {
                eprintln!("grill: could not roll back the call state: {rollback}");
            }
            Err(error)
        }
    }
}

/// Applies a checked patch in one transaction and recomputes the visible
/// list. An empty patch changes nothing. `NotFound` for an unknown
/// recording; `Invalid` (and nothing applied) when a step does not fit the
/// stored state: an unknown topic or question, no current topic, a field the
/// card does not have, an answered question that is neither open nor asked.
#[cfg(test)]
pub fn apply_patch(
    connection: &Connection,
    recording_id: &str,
    patch: &ValidatedPatch,
) -> CommandResult<AppliedPatch> {
    apply_patch_at(connection, recording_id, patch, now_ms())
}

/// [`apply_patch`] at `now` (Unix ms) for every time it writes. The fast
/// loop passes its host's clock, so a replay on a virtual clock stores the
/// times of the call it replays (question-quality design.md, decision 3).
pub fn apply_patch_at(
    connection: &Connection,
    recording_id: &str,
    patch: &ValidatedPatch,
    now: i64,
) -> CommandResult<AppliedPatch> {
    let recording = recording_row(connection, recording_id)?;
    if patch.ops.is_empty() {
        return Ok(AppliedPatch::default());
    }
    let rules = list_rules(connection)?;
    in_savepoint(connection, || {
        let mut applied = AppliedPatch::default();
        let mut current = recording.current_topic_id.clone();
        for op in &patch.ops {
            match op {
                ValidatedOp::CreateTopic { title } => {
                    let id = create_topic(connection, recording_id, &recording, title, now)?;
                    set_current_topic(connection, recording_id, &id, now)?;
                    applied.topic_ids.push(id.clone());
                    current = Some(id);
                }
                ValidatedOp::SwitchTopic { topic_id } => {
                    check_topic(connection, recording_id, topic_id)?;
                    set_current_topic(connection, recording_id, topic_id, now)?;
                    current = Some(topic_id.clone());
                }
                ValidatedOp::SetCardField {
                    field,
                    value,
                    evidence,
                } => {
                    let topic_id = current.as_deref().ok_or_else(no_current_topic)?;
                    set_card_field(
                        connection,
                        &recording,
                        recording_id,
                        topic_id,
                        CardField {
                            field: *field,
                            value: value.clone(),
                            evidence: evidence.clone(),
                            updated_at: now,
                        },
                        now,
                    )?;
                }
                ValidatedOp::AddQuestion(new) => {
                    let topic_id = current.as_deref().ok_or_else(no_current_topic)?;
                    let id =
                        add_question(connection, &recording, recording_id, topic_id, new, now)?;
                    applied.question_ids.push(id);
                }
                ValidatedOp::MarkAnswered {
                    question_id,
                    evidence,
                } => mark_answered(connection, recording_id, question_id, evidence, now)?,
                ValidatedOp::StartFinalCheck => {
                    connection.execute(
                        "UPDATE recordings SET final_check_at = coalesce(final_check_at, ?2)
                          WHERE id = ?1",
                        params![recording_id, now],
                    )?;
                }
            }
        }
        recompute(connection, recording_id, rules, now)?;
        Ok(applied)
    })
}

fn no_current_topic() -> CommandError {
    CommandError::invalid("У записи нет текущей темы")
}

fn create_topic(
    connection: &Connection,
    recording_id: &str,
    recording: &RecordingRow,
    title: &str,
    now: i64,
) -> CommandResult<String> {
    let title = super::required(title, "Название темы не может быть пустым")?;
    let position: i32 = connection.query_row(
        "SELECT coalesce(max(position) + 1, 0) FROM topics WHERE recording_id = ?1",
        [recording_id],
        |row| row.get(0),
    )?;
    let id = new_id();
    connection.execute(
        "INSERT INTO topics (id, recording_id, call_id, title, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, recording_id, recording.call_id, title, position, now],
    )?;
    Ok(id)
}

fn check_topic(connection: &Connection, recording_id: &str, topic_id: &str) -> CommandResult<()> {
    let of: Option<String> = connection
        .query_row(
            "SELECT recording_id FROM topics WHERE id = ?1",
            [topic_id],
            |row| row.get(0),
        )
        .optional()?;
    if of.as_deref() != Some(recording_id) {
        return Err(CommandError::invalid(format!(
            "Тема {topic_id} не относится к записи"
        )));
    }
    Ok(())
}

fn set_current_topic(
    connection: &Connection,
    recording_id: &str,
    topic_id: &str,
    now: i64,
) -> CommandResult<()> {
    connection.execute(
        "UPDATE recordings SET current_topic_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![recording_id, topic_id, now],
    )?;
    Ok(())
}

fn set_card_field(
    connection: &Connection,
    recording: &RecordingRow,
    recording_id: &str,
    topic_id: &str,
    field: CardField,
    now: i64,
) -> CommandResult<()> {
    let card = card_or_new(connection, recording, recording_id, topic_id, now)?;
    let mut fields = card.fields;
    match fields.iter_mut().find(|known| known.field == field.field) {
        Some(known) => *known = field,
        None => fields.push(field),
    }
    connection.execute(
        "UPDATE task_cards SET fields = ?2, updated_at = MAX(?3, updated_at + 1)
          WHERE id = ?1",
        params![card.id, Json(serde_json::to_value(fields)?), now],
    )?;
    Ok(())
}

/// The topic's card, created empty (titled as the topic) when it has none.
fn card_or_new(
    connection: &Connection,
    recording: &RecordingRow,
    recording_id: &str,
    topic_id: &str,
    now: i64,
) -> CommandResult<TaskCard> {
    if let Some(card) = card_of_topic(connection, topic_id)? {
        return Ok(card);
    }
    let title: String = connection.query_row(
        "SELECT title FROM topics WHERE id = ?1",
        [topic_id],
        |row| row.get(0),
    )?;
    connection.execute(
        "INSERT INTO task_cards
           (id, topic_id, recording_id, call_id, title, fields, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?6)",
        params![
            new_id(),
            topic_id,
            recording_id,
            recording.call_id,
            title,
            now
        ],
    )?;
    card_of_topic(connection, topic_id)?
        .ok_or_else(|| CommandError::invalid("Карточка темы не создана"))
}

fn add_question(
    connection: &Connection,
    recording: &RecordingRow,
    recording_id: &str,
    topic_id: &str,
    new: &NewQuestion,
    now: i64,
) -> CommandResult<String> {
    let text = super::required(&new.text, "Текст вопроса не может быть пустым")?;
    // A question about an empty field needs only the card (`validate.rs`
    // lets `empty` name a field the card doesn't have yet); an assumption
    // or a contradiction is about a value the card already holds.
    let card = if new.gap_type == GapType::Empty {
        Some(card_or_new(
            connection,
            recording,
            recording_id,
            topic_id,
            now,
        )?)
    } else {
        card_of_topic(connection, topic_id)?.filter(|card| {
            card.fields
                .iter()
                .any(|field| field.field == new.card_field)
        })
    }
    .ok_or_else(|| {
        CommandError::invalid(format!(
            "У карточки текущей темы нет поля {}",
            new.card_field.as_str()
        ))
    })?;
    let id = new_id();
    connection.execute(
        "INSERT INTO questions
           (id, recording_id, call_id, topic_id, card_id, text, description, card_field,
            gap_type, priority, evidence, status, pinned, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'open', 0, ?12, ?12)",
        params![
            id,
            recording_id,
            recording.call_id,
            topic_id,
            card.id,
            text,
            new.description.trim(),
            new.card_field.as_str(),
            new.gap_type.as_str(),
            new.priority,
            Json(serde_json::to_value(&new.evidence)?),
            now
        ],
    )?;
    // The finding's card links to the first question that cites it
    // (agent-slow-loop design.md, decision 6).
    for item in &new.evidence {
        if item.source == EvidenceSource::Document {
            context_findings::link_question(connection, recording_id, &item.id, &id)?;
        }
    }
    Ok(id)
}

fn mark_answered(
    connection: &Connection,
    recording_id: &str,
    question_id: &str,
    evidence: &[Evidence],
    now: i64,
) -> CommandResult<()> {
    let changed = connection.execute(
        "UPDATE questions
            SET status = 'answered', answer_evidence = ?3, pinned = 0, shown_at = NULL,
                updated_at = MAX(?4, updated_at + 1)
          WHERE id = ?1 AND recording_id = ?2 AND status IN ('open', 'asked')",
        params![
            question_id,
            recording_id,
            Json(serde_json::to_value(evidence)?),
            now
        ],
    )?;
    if changed == 0 {
        return Err(CommandError::invalid(format!(
            "Вопрос {question_id} уже закрыт или не относится к записи"
        )));
    }
    Ok(())
}

/// A quick action of the manager on a question, then the visible list is
/// recomputed. Returns the question's recording (for `CallStateChanged`).
///
/// `pin` takes an open question (it stays visible until unpinned or
/// answered); `hide` / `asked` an open, hidden or asked one (and unpin it);
/// `restore` brings a hidden or asked question back to the list. Repeating
/// an action changes nothing. `NotFound` for an unknown question, `Invalid`
/// for an action its state does not allow (an answered question stays
/// answered).
pub fn act(
    connection: &Connection,
    question_id: &str,
    action: QuestionAction,
) -> CommandResult<String> {
    let current = question(connection, question_id)?;
    let rules = list_rules(connection)?;
    let status = current.status;
    let refuse = |message: &str| Err(CommandError::invalid(message));
    let (status, pinned) = match action {
        QuestionAction::Pin if status != QuestionStatus::Open => {
            return refuse("Закрепить можно только открытый вопрос");
        }
        QuestionAction::Pin => (status, true),
        QuestionAction::Unpin => (status, false),
        QuestionAction::Hide | QuestionAction::Asked if status == QuestionStatus::Answered => {
            return refuse("Вопрос уже отвечен");
        }
        QuestionAction::Hide => (QuestionStatus::Hidden, false),
        QuestionAction::Asked => (QuestionStatus::Asked, false),
        QuestionAction::Restore if status == QuestionStatus::Answered => {
            return refuse("Отвеченный вопрос нельзя вернуть");
        }
        QuestionAction::Restore => (QuestionStatus::Open, current.pinned),
    };
    if (status, pinned) == (current.status, current.pinned) {
        return Ok(current.recording_id);
    }
    in_savepoint(connection, || {
        let now = now_ms();
        connection.execute(
            "UPDATE questions
                SET status = ?2, pinned = ?3,
                    shown_at = CASE WHEN ?2 = 'open' THEN shown_at END,
                    updated_at = MAX(?4, updated_at + 1)
              WHERE id = ?1",
            params![question_id, status.as_str(), pinned, now],
        )?;
        recompute(connection, &current.recording_id, rules, now)?;
        Ok(current.recording_id.clone())
    })
}

/// Recomputes the visible list of a recording with the current
/// `questionCount` (after a change of the setting, say). `NotFound` for an
/// unknown recording.
pub fn recompute_visible(connection: &Connection, recording_id: &str) -> CommandResult<()> {
    recompute_visible_at(connection, recording_id, now_ms()).map(|_| ())
}

/// [`recompute_visible`] at `now` (the fast loop's host clock); whether the
/// visible list changed: a question that was visible too long gave its
/// place (question-volume design.md, decision 3).
pub fn recompute_visible_at(
    connection: &Connection,
    recording_id: &str,
    now: i64,
) -> CommandResult<bool> {
    recording_row(connection, recording_id)?;
    let rules = list_rules(connection)?;
    in_savepoint(connection, || {
        recompute(connection, recording_id, rules, now)
    })
}

/// The recordings with open questions, whose visible lists depend on
/// `questionCount`.
pub fn recordings_with_open_questions(connection: &Connection) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT DISTINCT recording_id FROM questions WHERE status = 'open' ORDER BY recording_id",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// What the visible list needs of a question.
struct Slot {
    id: String,
    topic_id: Option<String>,
    open: bool,
    pinned: bool,
    shown_at: Option<i64>,
    requeued_at: Option<i64>,
    priority: i32,
    created_at: i64,
}

/// Decision 7: every pinned open question (of any topic; never cut, so
/// there may be more of them than `count`), then the open questions of the
/// current topic already visible in their `shown_at` order, then free
/// places up to `count` go to the waiting ones: first those never shown, by
/// priority, then oldest first; then those that gave their place, by when.
/// A question that leaves (answered, hidden, asked, of another topic, no
/// room) loses its `shown_at`; one that comes gets a `shown_at` after every
/// other, so a new question never moves the visible ones.
///
/// Question-volume decision 3: when questions never shown wait and there is
/// no free place for them, the visible ones (not pinned) shown at least
/// `requeue_after_ms` ago give theirs, the longest shown first, one per
/// waiting question: they go back to the queue (`requeued_at`).
///
/// Whether the visible list changed.
fn recompute(
    connection: &Connection,
    recording_id: &str,
    rules: ListRules,
    now: i64,
) -> CommandResult<bool> {
    let current: Option<String> = recording_row(connection, recording_id)?.current_topic_id;
    let slots: Vec<Slot> = {
        let mut statement = connection.prepare(
            "SELECT id, topic_id, status, pinned, shown_at, requeued_at, priority, created_at
               FROM questions WHERE recording_id = ?1",
        )?;
        let rows = statement.query_map([recording_id], |row| {
            Ok(Slot {
                id: row.get(0)?,
                topic_id: row.get(1)?,
                open: row.get::<_, String>(2)? == QuestionStatus::Open.as_str(),
                pinned: row.get(3)?,
                shown_at: row.get(4)?,
                requeued_at: row.get(5)?,
                priority: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let of_current = |slot: &Slot| current.is_some() && slot.topic_id == current;

    let mut pinned: Vec<&Slot> = slots.iter().filter(|s| s.open && s.pinned).collect();
    pinned.sort_by_key(|s| (s.shown_at.is_none(), s.shown_at, s.created_at, s.id.clone()));
    let mut kept: Vec<&Slot> = slots
        .iter()
        .filter(|s| s.open && !s.pinned && s.shown_at.is_some() && of_current(s))
        .collect();
    kept.sort_by_key(|s| (s.shown_at, s.id.clone()));
    let mut waiting: Vec<&Slot> = slots
        .iter()
        .filter(|s| s.open && !s.pinned && s.shown_at.is_none() && of_current(s))
        .collect();
    waiting.sort_by(|a, b| {
        a.requeued_at
            .is_some()
            .cmp(&b.requeued_at.is_some())
            .then(a.requeued_at.cmp(&b.requeued_at))
            .then(b.priority.cmp(&a.priority))
            .then(a.created_at.cmp(&b.created_at))
            .then(a.id.cmp(&b.id))
    });
    let room = rules.count.saturating_sub(pinned.len());

    // Questions never shown that find no free place.
    let never_shown = waiting.iter().filter(|s| s.requeued_at.is_none()).count();
    let short = never_shown.saturating_sub(room.saturating_sub(kept.len()));
    let stale: Vec<&str> = kept
        .iter()
        .filter(|s| {
            s.shown_at
                .is_some_and(|at| now - at >= rules.requeue_after_ms)
        })
        .take(short)
        .map(|s| s.id.as_str())
        .collect();
    kept.retain(|s| !stale.contains(&s.id.as_str()));

    let order: Vec<&Slot> = pinned
        .into_iter()
        .chain(kept.into_iter().chain(waiting).take(room))
        .collect();
    let visible: HashSet<&str> = order.iter().map(|slot| slot.id.as_str()).collect();

    let show = |id: &str, shown_at: Option<i64>| -> CommandResult<()> {
        connection.execute(
            "UPDATE questions SET shown_at = ?2 WHERE id = ?1",
            params![id, shown_at],
        )?;
        Ok(())
    };
    let mut changed = false;
    // The ones that come get a `shown_at` after every other, in the order
    // they were picked.
    let latest = slots.iter().filter_map(|slot| slot.shown_at).max();
    let first = latest.map_or(now, |latest| now.max(latest + 1));
    let coming = order.iter().filter(|slot| slot.shown_at.is_none());
    for (shown_at, slot) in (first..).zip(coming) {
        show(&slot.id, Some(shown_at))?;
        changed = true;
    }
    for slot in &slots {
        if slot.shown_at.is_some() && !visible.contains(slot.id.as_str()) {
            show(&slot.id, None)?;
            changed = true;
        }
    }
    for id in &stale {
        connection.execute(
            "UPDATE questions SET requeued_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
    }
    Ok(changed)
}

/* Agent calls */

/// The last known share of the subscription limit (settings-real design.md,
/// decision 7).
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// 0–1, as the CLI reported it.
    // Always finite, so a plain `number` rather than specta's `number | null`.
    #[specta(type = u32)]
    pub utilization: f64,
    /// When the call that reported it was recorded, ms since the Unix epoch.
    pub measured_at: i64,
}

/// The share of the newest agent call that reported one; `None` without
/// any.
pub fn latest_usage(connection: &Connection) -> CommandResult<Option<AgentUsage>> {
    Ok(connection
        .query_row(
            "SELECT utilization, created_at FROM agent_calls
              WHERE utilization IS NOT NULL
              ORDER BY created_at DESC, started_at DESC, id DESC LIMIT 1",
            [],
            |row| {
                Ok(AgentUsage {
                    utilization: row.get(0)?,
                    measured_at: row.get(1)?,
                })
            },
        )
        .optional()?)
}

/// Records an agent call and returns its id (UUID v7). `NotFound` for an
/// unknown recording, `Invalid` when `rejected` is not a JSON array or the
/// outcome is missing.
#[cfg(test)]
pub fn insert_agent_call(connection: &Connection, call: &AgentCallInput) -> CommandResult<String> {
    insert_agent_call_at(connection, call, now_ms())
}

/// [`insert_agent_call`] with `created_at` = `now` (Unix ms): the fast
/// loop's host clock.
pub fn insert_agent_call_at(
    connection: &Connection,
    call: &AgentCallInput,
    now: i64,
) -> CommandResult<String> {
    recording_row(connection, &call.recording_id)?;
    let outcome = call
        .outcome
        .ok_or_else(|| CommandError::invalid("Нет результата вызова агента"))?;
    let rejected = match &call.rejected {
        Value::Null => Value::Array(Vec::new()),
        Value::Array(_) => call.rejected.clone(),
        _ => {
            return Err(CommandError::invalid(
                "Отклонённые операции — не массив JSON",
            ));
        }
    };
    let id = new_id();
    connection.execute(
        "INSERT INTO agent_calls
           (id, recording_id, started_at, duration_ms, outcome, input_tokens, output_tokens,
            cache_read, cache_write, cost_usd, utilization, rejected, error, created_at, kind)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            id,
            call.recording_id,
            call.started_at,
            call.duration_ms.max(0),
            outcome.as_str(),
            call.input_tokens,
            call.output_tokens,
            call.cache_read,
            call.cache_write,
            call.cost_usd,
            call.utilization,
            Json(rejected),
            call.error,
            now,
            call.kind.as_str()
        ],
    )?;
    Ok(id)
}

/// The agent calls of a recording, oldest first (the tests, `grill-eval`).
#[cfg(any(test, feature = "eval"))]
pub fn agent_calls(connection: &Connection, recording_id: &str) -> CommandResult<Vec<AgentCall>> {
    let mut statement = connection.prepare(
        "SELECT id, recording_id, started_at, duration_ms, outcome, input_tokens, output_tokens,
                cache_read, cache_write, cost_usd, utilization, rejected, error, created_at, kind
           FROM agent_calls WHERE recording_id = ?1 ORDER BY started_at, id",
    )?;
    let rows = statement.query_map([recording_id], |row| {
        let outcome: String = row.get(4)?;
        let Json(rejected) = row.get(11)?;
        Ok(AgentCall {
            id: row.get(0)?,
            recording_id: row.get(1)?,
            started_at: row.get(2)?,
            duration_ms: row.get(3)?,
            outcome: AgentCallOutcome::parse(&outcome)?,
            input_tokens: row.get(5)?,
            output_tokens: row.get(6)?,
            cache_read: row.get(7)?,
            cache_write: row.get(8)?,
            cost_usd: row.get(9)?,
            utilization: row.get(10)?,
            rejected,
            error: row.get(12)?,
            created_at: row.get(13)?,
            kind: AgentCallKind::parse(&row.get::<_, String>(14)?)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::storage::{
        open_in_memory,
        recordings::{RecordingFiles, RecordingLinks},
        settings::SettingsMap,
    };

    fn recording(connection: &Connection) -> String {
        recordings::create(connection, &RecordingLinks::default(), 0, |id| {
            RecordingFiles {
                me: format!("recordings/{id}/me.opus"),
                others: format!("recordings/{id}/others.opus"),
            }
        })
        .unwrap()
    }

    fn set_count(connection: &Connection, count: &str) {
        let patch = SettingsMap::from([(settings::QUESTION_COUNT.to_owned(), json!(count))]);
        settings::put(connection, &patch).unwrap();
    }

    fn evidence(quote: &str) -> Vec<Evidence> {
        vec![Evidence {
            source: EvidenceSource::Segment,
            id: "S1".to_owned(),
            quote: quote.to_owned(),
        }]
    }

    fn topic(title: &str) -> ValidatedOp {
        ValidatedOp::CreateTopic {
            title: title.to_owned(),
        }
    }

    fn field(lens: CardLens) -> ValidatedOp {
        ValidatedOp::SetCardField {
            field: lens,
            value: format!("{}: значение", lens.as_str()),
            evidence: evidence("значение"),
        }
    }

    fn ask(text: &str, priority: i32) -> ValidatedOp {
        ValidatedOp::AddQuestion(NewQuestion {
            text: text.to_owned(),
            description: format!("{text} — зачем"),
            card_field: CardLens::Goal,
            gap_type: GapType::Empty,
            priority,
            evidence: evidence("цитата"),
        })
    }

    fn apply(connection: &Connection, recording_id: &str, ops: Vec<ValidatedOp>) -> AppliedPatch {
        apply_patch(connection, recording_id, &ValidatedPatch { ops }).unwrap()
    }

    /// A recording with a current topic whose card has `goal`.
    fn started(connection: &Connection) -> String {
        let id = recording(connection);
        apply(
            connection,
            &id,
            vec![topic("Очередь"), field(CardLens::Goal)],
        );
        id
    }

    /// Texts of the visible questions, in order.
    fn visible(connection: &Connection, recording_id: &str) -> Vec<String> {
        get(connection, recording_id)
            .unwrap()
            .visible()
            .into_iter()
            .map(|question| question.text.clone())
            .collect()
    }

    fn id_of(connection: &Connection, recording_id: &str, text: &str) -> String {
        get(connection, recording_id)
            .unwrap()
            .questions
            .into_iter()
            .find(|question| question.text == text)
            .unwrap()
            .id
    }

    #[test]
    fn applies_a_patch_and_reads_the_whole_state() {
        let connection = open_in_memory().unwrap();
        let id = recording(&connection);
        let empty = get(&connection, &id).unwrap();
        assert!(empty.topics.is_empty() && empty.questions.is_empty());
        assert_eq!((empty.current_topic_id, empty.final_check), (None, None));

        let applied = apply(
            &connection,
            &id,
            vec![
                topic("Приём звонков"),
                field(CardLens::Goal),
                ask("Кто отвечает?", 3),
            ],
        );
        let state = get(&connection, &id).unwrap();
        assert_eq!(state.topics.len(), 1);
        assert_eq!(applied.topic_ids, vec![state.topics[0].id.clone()]);
        assert_eq!(state.current_topic_id, Some(state.topics[0].id.clone()));
        let card = state.current_card().unwrap();
        assert_eq!(card.title, "Приём звонков");
        assert_eq!(card.fields.len(), 1);
        assert_eq!(card.fields[0].field, CardLens::Goal);
        assert_eq!(card.fields[0].evidence, evidence("значение"));

        let question = &state.questions[0];
        assert_eq!(applied.question_ids, vec![question.id.clone()]);
        assert_eq!(question.status, QuestionStatus::Open);
        assert_eq!(question.topic_id, Some(state.topics[0].id.clone()));
        assert_eq!(question.card_id, Some(card.id.clone()));
        assert_eq!(question.card_field, Some(CardLens::Goal));
        assert_eq!(question.description, "Кто отвечает? — зачем");
        assert_eq!(question.evidence, evidence("цитата"));
        assert_eq!((question.visible, question.rank), (true, Some(0)));
        assert!(question.shown_at.is_some());

        // The same field again replaces its value; a new one goes after it.
        apply(
            &connection,
            &id,
            vec![
                ValidatedOp::SetCardField {
                    field: CardLens::Goal,
                    value: "Новое".to_owned(),
                    evidence: evidence("новое"),
                },
                field(CardLens::Users),
            ],
        );
        let state = get(&connection, &id).unwrap();
        let fields = &state.current_card().unwrap().fields;
        assert_eq!(
            fields
                .iter()
                .map(|f| (f.field, f.value.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (CardLens::Goal, "Новое"),
                (CardLens::Users, "users: значение")
            ]
        );
        assert_eq!(state.cards.len(), 1, "one card per topic");
    }

    #[test]
    fn an_empty_patch_changes_nothing() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let before = get(&connection, &id).unwrap();
        let applied = apply(&connection, &id, Vec::new());
        assert_eq!(applied, AppliedPatch::default());
        assert_eq!(get(&connection, &id).unwrap(), before);
    }

    #[test]
    fn a_step_that_does_not_fit_rolls_the_whole_patch_back() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let before = get(&connection, &id).unwrap();
        for bad in [
            ValidatedOp::SwitchTopic {
                topic_id: "nope".to_owned(),
            },
            ValidatedOp::MarkAnswered {
                question_id: "nope".to_owned(),
                evidence: evidence("x"),
            },
            // An assumption is about a value, and the card has no `acceptance`.
            ValidatedOp::AddQuestion(NewQuestion {
                card_field: CardLens::Acceptance,
                gap_type: GapType::Assumption,
                ..match ask("Вопрос", 1) {
                    ValidatedOp::AddQuestion(new) => new,
                    _ => unreachable!(),
                }
            }),
        ] {
            let patch = ValidatedPatch {
                ops: vec![topic("Новая"), field(CardLens::Goal), ask("Первый", 2), bad],
            };
            let error = apply_patch(&connection, &id, &patch).unwrap_err();
            assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
            assert_eq!(get(&connection, &id).unwrap(), before);
        }
        // Without a current topic there is nothing to attach to.
        let fresh = recording(&connection);
        let error = apply_patch(
            &connection,
            &fresh,
            &ValidatedPatch {
                ops: vec![field(CardLens::Goal)],
            },
        )
        .unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }));
        let error = apply_patch(&connection, "nope", &ValidatedPatch::default()).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }));
    }

    /// The first question of a topic is about a field nobody has filled:
    /// the patch keeps its topic, and a topic without a card gets one.
    #[test]
    fn a_question_about_an_empty_field_is_saved() {
        let about = |text: &str, lens: CardLens| match ask(text, 2) {
            ValidatedOp::AddQuestion(new) => ValidatedOp::AddQuestion(NewQuestion {
                card_field: lens,
                ..new
            }),
            _ => unreachable!(),
        };
        let connection = open_in_memory().unwrap();
        let id = recording(&connection);
        apply(
            &connection,
            &id,
            vec![
                topic("Брони"),
                field(CardLens::Goal),
                about("Кто подтверждает бронь?", CardLens::Users),
                about("Как понять, что готово?", CardLens::Acceptance),
            ],
        );
        let state = get(&connection, &id).unwrap();
        assert_eq!(state.topics.len(), 1);
        let card = state.current_card().unwrap();
        assert_eq!(card.fields.len(), 1, "the asked fields stay empty");
        assert_eq!(visible(&connection, &id).len(), 2);
        assert!(
            state
                .questions
                .iter()
                .all(|question| question.card_id.as_deref() == Some(card.id.as_str()))
        );

        let bare = recording(&connection);
        apply(
            &connection,
            &bare,
            vec![
                topic("Табло"),
                about("Где стоит табло?", CardLens::Constraints),
            ],
        );
        let state = get(&connection, &bare).unwrap();
        let card = state.current_card().unwrap();
        assert_eq!((card.title.as_str(), card.fields.len()), ("Табло", 0));
        assert_eq!(visible(&connection, &bare), vec!["Где стоит табло?"]);
    }

    /// `call-questions`, «Новый вопрос»: the visible ones keep their order.
    #[test]
    fn a_new_question_never_moves_the_visible_ones() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(&connection, &id, vec![ask("Низкий", 1)]);
        apply(&connection, &id, vec![ask("Высокий", 3)]);
        assert_eq!(visible(&connection, &id), vec!["Низкий", "Высокий"]);
        apply(&connection, &id, vec![ask("Средний", 2)]);
        assert_eq!(
            visible(&connection, &id),
            vec!["Низкий", "Высокий", "Средний"]
        );
        // The list is full: the next waits, however important.
        apply(&connection, &id, vec![ask("Срочный", 3)]);
        assert_eq!(
            visible(&connection, &id),
            vec!["Низкий", "Высокий", "Средний"]
        );
    }

    const MIN: i64 = 60_000;

    fn apply_at(connection: &Connection, recording_id: &str, ops: Vec<ValidatedOp>, now: i64) {
        apply_patch_at(connection, recording_id, &ValidatedPatch { ops }, now).unwrap();
    }

    fn requeued_at(connection: &Connection, question_id: &str) -> Option<i64> {
        connection
            .query_row(
                "SELECT requeued_at FROM questions WHERE id = ?1",
                [question_id],
                |row| row.get(0),
            )
            .unwrap()
    }

    /// «Старый вопрос уступает место»: three visible, one shown 9 minutes
    /// ago, a new one comes: the old one goes back to the queue, the other
    /// two keep their order.
    #[test]
    fn an_old_question_gives_its_place_to_a_new_one() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let t0 = now_ms();
        apply_at(&connection, &id, vec![ask("Старый", 2)], t0);
        apply_at(
            &connection,
            &id,
            vec![ask("Второй", 2), ask("Третий", 2)],
            t0 + 5 * MIN,
        );
        apply_at(&connection, &id, vec![ask("Новый", 1)], t0 + 9 * MIN);
        assert_eq!(visible(&connection, &id), vec!["Второй", "Третий", "Новый"]);
        let old = id_of(&connection, &id, "Старый");
        let state = get(&connection, &id).unwrap();
        let question = state.questions.iter().find(|q| q.id == old).unwrap();
        assert_eq!(question.status, QuestionStatus::Open);
        assert_eq!(question.shown_at, None);
        assert_eq!(requeued_at(&connection, &old), Some(t0 + 9 * MIN));
    }

    /// «Ждать некому»: a question visible 15 minutes keeps its place when
    /// nothing never shown waits.
    #[test]
    fn nothing_waiting_keeps_the_old_question() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let t0 = now_ms();
        apply_at(
            &connection,
            &id,
            vec![ask("Первый", 2), ask("Второй", 2), ask("Третий", 2)],
            t0,
        );
        assert!(!recompute_visible_at(&connection, &id, t0 + 15 * MIN).unwrap());
        assert_eq!(
            visible(&connection, &id),
            vec!["Первый", "Второй", "Третий"]
        );
        // Not visible long enough yet: the new one waits.
        apply_at(&connection, &id, vec![ask("Новый", 3)], t0 + 7 * MIN);
        assert_eq!(
            visible(&connection, &id),
            vec!["Первый", "Второй", "Третий"]
        );
        // The pass after the threshold lets it in, without a patch.
        assert!(recompute_visible_at(&connection, &id, t0 + 8 * MIN).unwrap());
        assert_eq!(visible(&connection, &id), vec!["Второй", "Третий", "Новый"]);
    }

    /// A pinned question never gives its place; a returned question doesn't
    /// pass a new one of lower priority.
    #[test]
    fn pinned_stay_and_returned_wait_behind_new_ones() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let t0 = now_ms();
        apply_at(&connection, &id, vec![ask("Закреплён", 2)], t0);
        let pinned = id_of(&connection, &id, "Закреплён");
        act(&connection, &pinned, QuestionAction::Pin).unwrap();
        apply_at(&connection, &id, vec![ask("Старый", 3)], t0);
        apply_at(&connection, &id, vec![ask("Свежий", 2)], t0 + 5 * MIN);
        apply_at(&connection, &id, vec![ask("Новый", 2)], t0 + 9 * MIN);
        let state = get(&connection, &id).unwrap();
        let shown: Vec<&str> = state
            .questions
            .iter()
            .filter(|q| q.visible)
            .map(|q| q.text.as_str())
            .collect();
        assert!(shown.contains(&"Закреплён"), "{shown:?}");
        assert!(!shown.contains(&"Старый"), "{shown:?}");

        // A new one of lower priority waits; a place frees: it goes first.
        apply_at(&connection, &id, vec![ask("Низкий", 1)], t0 + 9 * MIN);
        let fresh = id_of(&connection, &id, "Свежий");
        act(&connection, &fresh, QuestionAction::Hide).unwrap();
        let state = get(&connection, &id).unwrap();
        let shown: Vec<&str> = state
            .questions
            .iter()
            .filter(|q| q.visible)
            .map(|q| q.text.as_str())
            .collect();
        assert!(shown.contains(&"Низкий"), "{shown:?}");
        assert!(!shown.contains(&"Старый"), "{shown:?}");
    }

    #[test]
    fn the_requeue_minutes_come_from_the_settings() {
        let setting = |value: Value| {
            settings::question_requeue_ms(&SettingsMap::from([(
                settings::QUESTION_REQUEUE_MINUTES.to_owned(),
                value,
            )]))
        };
        assert_eq!(setting(json!(5)), 5 * MIN);
        assert_eq!(setting(json!("12")), 12 * MIN);
        assert_eq!(setting(json!(0)), 8 * MIN);
        assert_eq!(setting(json!("скоро")), 8 * MIN);
        assert_eq!(settings::question_requeue_ms(&SettingsMap::new()), 8 * MIN);
    }

    /// «Лимит видимых»: 5 open with `questionCount` 3 → the 3 most important.
    #[test]
    fn the_limit_shows_the_most_important_first() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(
            &connection,
            &id,
            vec![
                ask("п1", 1),
                ask("п3а", 3),
                ask("п2", 2),
                ask("п3б", 3),
                ask("п1б", 1),
            ],
        );
        assert_eq!(visible(&connection, &id), vec!["п3а", "п3б", "п2"]);
        let state = get(&connection, &id).unwrap();
        assert_eq!(state.questions.iter().filter(|q| q.visible).count(), 3);

        set_count(&connection, "5");
        recompute_visible(&connection, &id).unwrap();
        assert_eq!(
            visible(&connection, &id),
            vec!["п3а", "п3б", "п2", "п1", "п1б"]
        );
        // A lower setting shows fewer at once, in the same order.
        set_count(&connection, "1");
        assert_eq!(visible(&connection, &id), vec!["п3а"]);
        recompute_visible(&connection, &id).unwrap();
        assert_eq!(visible(&connection, &id), vec!["п3а"]);
    }

    /// «Вопрос отвечен»: it leaves, the waiting one takes its place at the end.
    #[test]
    fn an_answered_question_frees_its_place() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(
            &connection,
            &id,
            vec![ask("А", 3), ask("Б", 2), ask("В", 2), ask("Г", 1)],
        );
        assert_eq!(visible(&connection, &id), vec!["А", "Б", "В"]);
        let answered = id_of(&connection, &id, "А");
        apply(
            &connection,
            &id,
            vec![ValidatedOp::MarkAnswered {
                question_id: answered.clone(),
                evidence: evidence("ответ"),
            }],
        );
        assert_eq!(visible(&connection, &id), vec!["Б", "В", "Г"]);
        let state = get(&connection, &id).unwrap();
        let question = state.questions.iter().find(|q| q.id == answered).unwrap();
        assert_eq!(question.status, QuestionStatus::Answered);
        assert_eq!(question.answer_evidence, Some(evidence("ответ")));
        assert_eq!((question.visible, question.shown_at), (false, None));

        // Answering again (or what is not open) does not fit.
        let error = apply_patch(
            &connection,
            &id,
            &ValidatedPatch {
                ops: vec![ValidatedOp::MarkAnswered {
                    question_id: answered,
                    evidence: evidence("ответ"),
                }],
            },
        )
        .unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }));
    }

    /// «Задал», then the client answers: an asked question can be marked
    /// answered; a hidden one can't.
    #[test]
    fn an_asked_question_can_be_answered() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(&connection, &id, vec![ask("А", 3), ask("Б", 2)]);
        let asked = id_of(&connection, &id, "А");
        let hidden = id_of(&connection, &id, "Б");
        act(&connection, &asked, QuestionAction::Asked).unwrap();
        act(&connection, &hidden, QuestionAction::Hide).unwrap();
        apply(
            &connection,
            &id,
            vec![ValidatedOp::MarkAnswered {
                question_id: asked.clone(),
                evidence: evidence("ответ"),
            }],
        );
        let state = get(&connection, &id).unwrap();
        let question = state.questions.iter().find(|q| q.id == asked).unwrap();
        assert_eq!(question.status, QuestionStatus::Answered);
        assert_eq!(question.answer_evidence, Some(evidence("ответ")));

        let error = apply_patch(
            &connection,
            &id,
            &ValidatedPatch {
                ops: vec![ValidatedOp::MarkAnswered {
                    question_id: hidden,
                    evidence: evidence("ответ"),
                }],
            },
        )
        .unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }));
    }

    /// «Закрепить»: new, more important questions don't push it out.
    #[test]
    fn a_pinned_question_stays_visible() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        set_count(&connection, "1");
        apply(&connection, &id, vec![ask("Мой", 1)]);
        let pinned = id_of(&connection, &id, "Мой");
        assert_eq!(act(&connection, &pinned, QuestionAction::Pin).unwrap(), id);
        apply(&connection, &id, vec![ask("Важнее", 3)]);
        assert_eq!(visible(&connection, &id), vec!["Мой"]);
        assert!(get(&connection, &id).unwrap().questions[0].pinned);

        // The pin goes first and survives a topic change.
        set_count(&connection, "3");
        apply(
            &connection,
            &id,
            vec![topic("Другая"), field(CardLens::Goal)],
        );
        apply(&connection, &id, vec![ask("Новой темы", 2)]);
        assert_eq!(visible(&connection, &id), vec!["Мой", "Новой темы"]);

        // With room for one, the pin of the other topic takes it: the new
        // topic's question waits, and the list says so to every window.
        set_count(&connection, "1");
        recompute_visible(&connection, &id).unwrap();
        assert_eq!(visible(&connection, &id), vec!["Мой"]);

        act(&connection, &pinned, QuestionAction::Unpin).unwrap();
        assert_eq!(visible(&connection, &id), vec!["Новой темы"]);
        // Only an open question can be pinned.
        act(&connection, &pinned, QuestionAction::Hide).unwrap();
        let error = act(&connection, &pinned, QuestionAction::Pin).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }));
    }

    /// «Закреплённый вопрос MUST NOT уходить из списка»: more pins than
    /// `questionCount` are all visible, the others wait.
    #[test]
    fn pins_are_never_cut_by_the_question_count() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(
            &connection,
            &id,
            vec![ask("А", 3), ask("Б", 2), ask("В", 1)],
        );
        for text in ["А", "Б"] {
            act(
                &connection,
                &id_of(&connection, &id, text),
                QuestionAction::Pin,
            )
            .unwrap();
        }
        set_count(&connection, "1");
        recompute_visible(&connection, &id).unwrap();
        assert_eq!(visible(&connection, &id), vec!["А", "Б"]);
        apply(&connection, &id, vec![ask("Г", 3)]);
        assert_eq!(visible(&connection, &id), vec!["А", "Б"]);
        // A lowered setting before the recompute cuts the others, not pins.
        set_count(&connection, "3");
        recompute_visible(&connection, &id).unwrap();
        assert_eq!(visible(&connection, &id), vec!["А", "Б", "Г"]);
        set_count(&connection, "1");
        assert_eq!(visible(&connection, &id), vec!["А", "Б"]);
    }

    /// «Скрыть» / «Задал» take a question out, «Вернуть» brings it back.
    #[test]
    fn hide_asked_and_restore() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(
            &connection,
            &id,
            vec![ask("А", 3), ask("Б", 2), ask("В", 1)],
        );
        let a = id_of(&connection, &id, "А");
        let b = id_of(&connection, &id, "Б");
        act(&connection, &a, QuestionAction::Hide).unwrap();
        act(&connection, &b, QuestionAction::Asked).unwrap();
        assert_eq!(visible(&connection, &id), vec!["В"]);
        let state = get(&connection, &id).unwrap();
        let status = |id: &str| state.questions.iter().find(|q| q.id == id).unwrap().status;
        assert_eq!(
            (status(&a), status(&b)),
            (QuestionStatus::Hidden, QuestionStatus::Asked)
        );
        // Repeating an action changes nothing.
        let before = get(&connection, &id).unwrap();
        act(&connection, &a, QuestionAction::Hide).unwrap();
        assert_eq!(get(&connection, &id).unwrap(), before);

        act(&connection, &a, QuestionAction::Restore).unwrap();
        assert_eq!(visible(&connection, &id), vec!["В", "А"]);
        act(&connection, &b, QuestionAction::Restore).unwrap();
        assert_eq!(visible(&connection, &id), vec!["В", "А", "Б"]);

        let error = act(&connection, "nope", QuestionAction::Pin).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }));
    }

    #[test]
    fn an_answered_question_cannot_be_hidden_or_restored() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(&connection, &id, vec![ask("А", 3)]);
        let a = id_of(&connection, &id, "А");
        apply(
            &connection,
            &id,
            vec![ValidatedOp::MarkAnswered {
                question_id: a.clone(),
                evidence: evidence("ответ"),
            }],
        );
        for action in [
            QuestionAction::Hide,
            QuestionAction::Asked,
            QuestionAction::Restore,
        ] {
            let error = act(&connection, &a, action).unwrap_err();
            assert!(matches!(error, CommandError::Invalid { .. }), "{action:?}");
        }
    }

    /// «Смена темы»: the list is the new topic's; the old questions stay
    /// open in their topic and come back with it.
    #[test]
    fn switching_topics_switches_the_list() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let first = get(&connection, &id).unwrap().topics[0].id.clone();
        apply(&connection, &id, vec![ask("Первой", 2)]);
        apply(
            &connection,
            &id,
            vec![topic("Вторая"), field(CardLens::Goal), ask("Второй", 2)],
        );
        assert_eq!(visible(&connection, &id), vec!["Второй"]);
        let state = get(&connection, &id).unwrap();
        assert_eq!(state.topics.len(), 2);
        assert_eq!(state.topics[1].position, 1);
        assert_eq!(state.current_topic_id, Some(state.topics[1].id.clone()));
        assert!(
            state
                .questions
                .iter()
                .all(|q| q.status == QuestionStatus::Open)
        );

        apply(
            &connection,
            &id,
            vec![ValidatedOp::SwitchTopic { topic_id: first }],
        );
        assert_eq!(visible(&connection, &id), vec!["Первой"]);
    }

    /// «Разговор идёт к концу»: the top `questionCount` open questions of all
    /// topics by priority.
    #[test]
    fn the_final_check_takes_the_top_of_all_topics() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        apply(&connection, &id, vec![ask("Т1 п1", 1), ask("Т1 п3", 3)]);
        apply(
            &connection,
            &id,
            vec![
                topic("Вторая"),
                field(CardLens::Goal),
                ask("Т2 п2", 2),
                ask("Т2 п3", 3),
                ask("Т2 п1", 1),
            ],
        );
        let hidden = id_of(&connection, &id, "Т2 п3");
        act(&connection, &hidden, QuestionAction::Hide).unwrap();
        assert_eq!(get(&connection, &id).unwrap().final_check, None);

        apply(&connection, &id, vec![ValidatedOp::StartFinalCheck]);
        let state = get(&connection, &id).unwrap();
        let check = state.final_check.clone().unwrap();
        let texts: Vec<&str> = check
            .question_ids
            .iter()
            .map(|qid| {
                state
                    .questions
                    .iter()
                    .find(|q| &q.id == qid)
                    .unwrap()
                    .text
                    .as_str()
            })
            .collect();
        assert_eq!(texts, vec!["Т1 п3", "Т2 п2", "Т1 п1"]);

        // Starting it again keeps the first start.
        apply(&connection, &id, vec![ValidatedOp::StartFinalCheck]);
        let again = get(&connection, &id).unwrap().final_check.unwrap();
        assert_eq!(again.started_at, check.started_at);
    }

    #[test]
    fn records_agent_calls() {
        let connection = open_in_memory().unwrap();
        let id = recording(&connection);
        let call = AgentCallInput {
            kind: AgentCallKind::FastLoop,
            recording_id: id.clone(),
            started_at: 1_000,
            duration_ms: 12_800,
            outcome: Some(AgentCallOutcome::Ok),
            input_tokens: Some(5_800),
            output_tokens: Some(1_334),
            cache_read: Some(4_000),
            cache_write: Some(1_000),
            cost_usd: Some(0.034),
            utilization: Some(0.82),
            rejected: json!([{ "op": 0, "reason": "quoteNotFound" }]),
            error: None,
        };
        let first = insert_agent_call(&connection, &call).unwrap();
        let failed = AgentCallInput {
            started_at: 2_000,
            outcome: Some(AgentCallOutcome::RateLimited),
            rejected: Value::Null,
            error: Some("limit".to_owned()),
            ..AgentCallInput {
                recording_id: id.clone(),
                ..AgentCallInput::default()
            }
        };
        insert_agent_call(&connection, &failed).unwrap();
        let calls = agent_calls(&connection, &id).unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, first);
        assert_eq!(calls[0].outcome, AgentCallOutcome::Ok);
        assert_eq!(calls[0].utilization, Some(0.82));
        assert_eq!(calls[0].rejected, call.rejected);
        assert_eq!(calls[1].rejected, json!([]));
        assert_eq!(calls[1].error.as_deref(), Some("limit"));

        let bad = AgentCallInput {
            rejected: json!({ "not": "an array" }),
            ..call.clone()
        };
        let error = insert_agent_call(&connection, &bad).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }));
        let unknown = AgentCallInput {
            recording_id: "nope".to_owned(),
            ..call
        };
        let error = insert_agent_call(&connection, &unknown).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }));
    }

    /// `app-settings`, «Лимит»: the newest call that reported a share.
    #[test]
    fn the_latest_usage_is_the_newest_call_with_a_share() {
        let connection = open_in_memory().unwrap();
        assert_eq!(latest_usage(&connection).unwrap(), None, "no calls");
        let id = recording(&connection);
        let call = |utilization: Option<f64>| AgentCallInput {
            recording_id: id.clone(),
            outcome: Some(AgentCallOutcome::Ok),
            utilization,
            ..AgentCallInput::default()
        };
        insert_agent_call_at(&connection, &call(None), 1_000).unwrap();
        assert_eq!(latest_usage(&connection).unwrap(), None, "no share yet");
        insert_agent_call_at(&connection, &call(Some(0.4)), 2_000).unwrap();
        insert_agent_call_at(&connection, &call(Some(0.82)), 3_000).unwrap();
        // A newer call that didn't report one keeps the last known share.
        insert_agent_call_at(&connection, &call(None), 4_000).unwrap();
        assert_eq!(
            latest_usage(&connection).unwrap(),
            Some(AgentUsage {
                utilization: 0.82,
                measured_at: 3_000
            })
        );
    }

    #[test]
    fn deleting_the_recording_deletes_its_call_state() {
        let connection = open_in_memory().unwrap();
        let id = started(&connection);
        let other = started(&connection);
        apply(&connection, &id, vec![ask("А", 1), ask("Б", 2)]);
        apply(&connection, &other, vec![ask("В", 1)]);
        insert_agent_call(
            &connection,
            &AgentCallInput {
                recording_id: id.clone(),
                outcome: Some(AgentCallOutcome::Empty),
                ..AgentCallInput::default()
            },
        )
        .unwrap();
        recordings::delete(&connection, &id).unwrap();
        let count = |table: &str| -> i64 {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!(
            (
                count("topics"),
                count("task_cards"),
                count("questions"),
                count("agent_calls")
            ),
            (1, 1, 1, 0)
        );
        assert_eq!(get(&connection, &other).unwrap().questions.len(), 1);
    }
}
