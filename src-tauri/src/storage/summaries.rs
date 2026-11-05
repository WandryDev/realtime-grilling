//! The summary of a call after it (post-call design.md, decisions 5–7).
//!
//! One row per call in `call_summaries`. Its `state` is the last build:
//! `building`, `ready` or `failed` with an `error`. The title, TL;DR,
//! transcript pass, [`SummaryContent`] and `builtAt` are the last summary
//! saved `ready`, and a build that starts ([`start_building`]) or fails
//! ([`save_failed`]) keeps them: a rebuild never deletes the previous summary
//! before the new one is saved (`call-summary`, "Ошибка сборки"). So
//! `state: failed` with `content` is "the rebuild failed, here is the
//! previous summary"; without `content`, no summary was ever saved.
//!
//! A finished call without a row reads as `failed` / [`INTERRUPTED`]: a
//! crash or a quit closed it (`calls::finish_stale`) before its build wrote
//! anything, or it was recorded before summaries existed. A `building` row
//! left by a crash becomes the same at the next start
//! ([`interrupt_building`]).
//!
//! [`save_build`] saves what a build produced in one transaction: the
//! summary, the pending proposals ([`proposals::replace_pending`]) and the
//! answered questions ([`reconcile_questions`]).

use std::collections::{BTreeSet, HashSet};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{
    call_state::{self, CardLens, Evidence, GapType, TaskCardDecision, conversion, typed},
    calls::{self, Call, CallStatus},
    json::Json,
    now_ms,
    proposals::{self, NewProposal, Proposal},
    required,
};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

/// The `error` of a build that the app's stop cut short.
pub const INTERRUPTED: &str = "interrupted";

/* Records */

/// Where the last build of a call's summary is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SummaryState {
    Building,
    Ready,
    /// `error` says why; the previous summary, if any, stays.
    Failed,
}

impl SummaryState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Building => "building",
            Self::Ready => "ready",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "building" => Ok(Self::Building),
            "ready" => Ok(Self::Ready),
            "failed" => Ok(Self::Failed),
            other => Err(conversion(format!("unknown summary state {other}"))),
        }
    }
}

/// Which transcript a summary was built from (decision 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SummaryTranscriptPass {
    /// Every recording's second pass.
    Refined,
    /// Only the live transcript ("по живой расшифровке").
    Live,
    /// Refined for some recordings, live for the others.
    Mixed,
}

impl SummaryTranscriptPass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Refined => "refined",
            Self::Live => "live",
            Self::Mixed => "mixed",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "refined" => Ok(Self::Refined),
            "live" => Ok(Self::Live),
            "mixed" => Ok(Self::Mixed),
            other => Err(conversion(format!("unknown transcript pass {other}"))),
        }
    }
}

/// A quote of the client the code found in the transcript, with where it
/// is, so the windows need not look the time up by the segment id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallEvidence {
    pub recording_id: String,
    /// A segment of the pass the summary was built from.
    pub segment_id: String,
    /// From the start of the recording.
    pub start_ms: i64,
    pub quote: String,
}

/// A segment a topic starts or ends at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SegmentMoment {
    pub recording_id: String,
    pub segment_id: String,
    /// From the start of the recording.
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PointStatus {
    Fact,
    Assumption,
    Contradiction,
}

/// A point of a topic, with the phrase it rests on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryPoint {
    pub text: String,
    pub status: PointStatus,
    pub evidence: Vec<CallEvidence>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryTopic {
    /// UUID v7, issued when the summary is saved.
    pub id: String,
    /// The fast loop's topics (`topics.id`) it continues; empty for a topic
    /// the summary found itself.
    pub topic_ids: Vec<String>,
    pub title: String,
    pub from: SegmentMoment,
    pub to: SegmentMoment,
    pub points: Vec<SummaryPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FactStatus {
    Confirmed,
    Assumption,
    Contradiction,
    Empty,
}

/// Where a fact comes from (`call-task-cards`, "Состояние и источник факта").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FactSource {
    /// "сказал клиент": `evidence` holds the quotes.
    Client,
    /// "из документов проекта".
    Project,
    /// "вывод агента", without a quote.
    Agent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CardFact {
    pub text: String,
    pub status: FactStatus,
    pub source: FactSource,
    pub evidence: Vec<CallEvidence>,
}

/// A lens of a card with one or more facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryCardField {
    pub field: CardLens,
    pub facts: Vec<CardFact>,
}

/// The task card of a summary topic. The manager's decision and title live
/// here ([`update_card`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryCard {
    /// UUID v7, issued when the summary is saved.
    pub id: String,
    /// The [`SummaryTopic`] it is the card of.
    pub topic_id: String,
    pub title: String,
    pub decision: TaskCardDecision,
    pub fields: Vec<SummaryCardField>,
}

/// A question to ask on the next call, from a gap of a card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NextQuestion {
    pub text: String,
    /// A [`SummaryTopic`].
    pub topic_id: Option<String>,
    pub field: Option<CardLens>,
    pub gap: GapType,
}

/// What `call_summaries.content` holds.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryContent {
    /// In the order of the call.
    pub topics: Vec<SummaryTopic>,
    /// In topic order.
    pub cards: Vec<SummaryCard>,
    /// Up to five.
    pub next: Vec<NextQuestion>,
}

/// The summary of a call. See the module docs for what a failed or
/// building one keeps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallSummary {
    pub call_id: String,
    pub state: SummaryState,
    /// Why the last build failed; set only when `failed`
    /// (`"interrupted"`: the app stopped during it).
    pub error: Option<String>,
    /// Of the saved summary; `null` without one.
    pub transcript_pass: Option<SummaryTranscriptPass>,
    /// Of the saved summary; empty without one.
    pub title: String,
    pub tldr: String,
    /// The saved summary; `null` until one is saved.
    pub content: Option<SummaryContent>,
    /// When the saved summary was built; `null` without one.
    pub built_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/* Inputs */

/// A summary that passed the checks of the build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadySummary {
    pub title: String,
    pub tldr: String,
    pub transcript_pass: SummaryTranscriptPass,
    /// Topic and card ids are UUID v7 (`storage::new_id`); card ids must be
    /// unique.
    pub content: SummaryContent,
}

/// An open or asked question the client answered, with the checked quote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnsweredQuestion {
    pub question_id: String,
    /// Not empty.
    pub evidence: Vec<Evidence>,
}

/// Everything a build saves at its end (decision 2, stage `saving`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryBuild {
    pub summary: ReadySummary,
    /// Replace the call's pending proposals; empty for a call without a
    /// project. `None` keeps them: the proposals' call failed, and a failed
    /// call does not take the previous build's proposals away.
    pub proposals: Option<Vec<NewProposal>>,
    pub answered: Vec<AnsweredQuestion>,
}

/// What [`save_build`] wrote.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedBuild {
    pub summary: CallSummary,
    /// Every proposal of the call: the kept decided ones and the new
    /// pending ones.
    pub proposals: Vec<Proposal>,
    pub answered: Reconciled,
}

/// What [`reconcile_questions`] changed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Reconciled {
    /// The questions that became `answered`.
    pub question_ids: Vec<String>,
    /// Their recordings (for `CallStateChanged`), sorted.
    pub recording_ids: Vec<String>,
}

/// `call_card_update` (decision 7): absent fields stay as they are.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CardPatch {
    #[specta(optional)]
    pub decision: Option<TaskCardDecision>,
    #[specta(optional)]
    pub title: Option<String>,
}

/* Reading */

const SELECT: &str = "SELECT call_id, state, error, transcript_pass, title, tldr, content,
       built_at, created_at, updated_at
  FROM call_summaries";

fn from_row(row: &Row) -> rusqlite::Result<CallSummary> {
    let state: String = row.get(1)?;
    let pass: Option<String> = row.get(3)?;
    let content: Option<Json> = row.get(6)?;
    Ok(CallSummary {
        call_id: row.get(0)?,
        state: SummaryState::parse(&state)?,
        error: row.get(2)?,
        transcript_pass: pass
            .as_deref()
            .map(SummaryTranscriptPass::parse)
            .transpose()?,
        title: row.get(4)?,
        tldr: row.get(5)?,
        content: content.map(|Json(value)| typed(value, 6)).transpose()?,
        built_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn stored(connection: &Connection, call_id: &str) -> CommandResult<Option<CallSummary>> {
    Ok(connection
        .query_row(&format!("{SELECT} WHERE call_id = ?1"), [call_id], from_row)
        .optional()?)
}

/// What a finished call without a summary row reads as.
fn interrupted(call: &Call) -> CallSummary {
    CallSummary {
        call_id: call.id.clone(),
        state: SummaryState::Failed,
        error: Some(INTERRUPTED.to_owned()),
        transcript_pass: None,
        title: String::new(),
        tldr: String::new(),
        content: None,
        built_at: None,
        created_at: call.updated_at,
        updated_at: call.updated_at,
    }
}

/// The summary of a call. `None` while the call is `live` or `finishing`
/// before its build wrote anything; a `finished` call without a row reads
/// as `failed` / [`INTERRUPTED`]. `NotFound` for an unknown call.
pub fn get(connection: &Connection, call_id: &str) -> CommandResult<Option<CallSummary>> {
    if let Some(summary) = stored(connection, call_id)? {
        return Ok(Some(summary));
    }
    let call = calls::get(connection, call_id)?;
    Ok((call.status == CallStatus::Finished).then(|| interrupted(&call)))
}

/* Writing */

fn changed(connection: &Connection, call_id: &str) -> CommandResult<DataChanged> {
    let project_id = calls::project_of(connection, call_id)?;
    Ok(DataChanged::new(
        Entity::Call,
        call_id,
        project_id.as_deref(),
        Change::Updated,
    ))
}

fn saved(connection: &Connection, call_id: &str) -> CommandResult<CallSummary> {
    stored(connection, call_id)?
        .ok_or_else(|| CommandError::not_found(format!("Итогов звонка {call_id} нет")))
}

/// A build starts: the state becomes `building`, the error goes, a saved
/// summary stays. `NotFound` for an unknown call. Sends `call` / `updated`.
pub fn start_building(
    connection: &Connection,
    call_id: &str,
) -> CommandResult<(CallSummary, Vec<DataChanged>)> {
    let event = changed(connection, call_id)?;
    connection.execute(
        "INSERT INTO call_summaries (call_id, state, created_at, updated_at)
         VALUES (?1, 'building', ?2, ?2)
         ON CONFLICT (call_id) DO UPDATE
            SET state = 'building', error = NULL, updated_at = MAX(?2, updated_at + 1)",
        params![call_id, now_ms()],
    )?;
    Ok((saved(connection, call_id)?, vec![event]))
}

/// A build failed (or was stopped): the state becomes `failed` with the
/// reason, a saved summary stays. `NotFound` for an unknown call, `Invalid`
/// for a blank reason. Sends `call` / `updated`.
pub fn save_failed(
    connection: &Connection,
    call_id: &str,
    error: &str,
) -> CommandResult<(CallSummary, Vec<DataChanged>)> {
    let error = required(error, "Нет причины, по которой итоги не собрались")?;
    let event = changed(connection, call_id)?;
    connection.execute(
        "INSERT INTO call_summaries (call_id, state, error, created_at, updated_at)
         VALUES (?1, 'failed', ?2, ?3, ?3)
         ON CONFLICT (call_id) DO UPDATE
            SET state = 'failed', error = excluded.error, updated_at = MAX(?3, updated_at + 1)",
        params![call_id, error, now_ms()],
    )?;
    Ok((saved(connection, call_id)?, vec![event]))
}

/// Saves a summary `ready`, replacing the previous one, and names the call
/// after it if the call has no title yet. `NotFound` for an unknown call,
/// `Invalid` for a card without an id or two cards with the same one. Sends
/// `call` / `updated`.
pub fn save_ready(
    connection: &Connection,
    call_id: &str,
    summary: &ReadySummary,
) -> CommandResult<(CallSummary, Vec<DataChanged>)> {
    let event = changed(connection, call_id)?;
    let mut ids = HashSet::new();
    for card in &summary.content.cards {
        if card.id.trim().is_empty() || !ids.insert(card.id.as_str()) {
            return Err(CommandError::invalid(format!(
                "У карточки итогов нет id или он повторяется: «{}»",
                card.id
            )));
        }
    }
    let now = now_ms();
    connection.execute(
        "INSERT INTO call_summaries
           (call_id, state, error, transcript_pass, title, tldr, content, built_at,
            created_at, updated_at)
         VALUES (?1, 'ready', NULL, ?2, ?3, ?4, ?5, ?6, ?6, ?6)
         ON CONFLICT (call_id) DO UPDATE
            SET state = 'ready', error = NULL, transcript_pass = excluded.transcript_pass,
                title = excluded.title, tldr = excluded.tldr, content = excluded.content,
                built_at = excluded.built_at, updated_at = MAX(?6, updated_at + 1)",
        params![
            call_id,
            summary.transcript_pass.as_str(),
            summary.title.trim(),
            summary.tldr.trim(),
            Json(serde_json::to_value(&summary.content)?),
            now
        ],
    )?;
    connection.execute(
        "UPDATE calls SET title = ?2, updated_at = MAX(?3, updated_at + 1)
          WHERE id = ?1 AND trim(title) = '' AND ?2 <> ''",
        params![call_id, summary.title.trim(), now],
    )?;
    Ok((saved(connection, call_id)?, vec![event]))
}

/// Decision 6: each open or asked question of the call becomes `answered`
/// with its quote (and leaves the visible list); an answered, hidden or
/// unknown question, or one of another call, stays as it is. Runs inside
/// the caller's transaction. `NotFound` for an unknown call, `Invalid` (and
/// nothing changed) for an answer without a quote.
pub fn reconcile_questions(
    connection: &Connection,
    call_id: &str,
    answered: &[AnsweredQuestion],
) -> CommandResult<Reconciled> {
    calls::project_of(connection, call_id)?;
    if let Some(bare) = answered.iter().find(|answer| answer.evidence.is_empty()) {
        return Err(CommandError::invalid(format!(
            "Ответ на вопрос {} без цитаты",
            bare.question_id
        )));
    }
    call_state::in_savepoint(connection, || {
        let mut reconciled = Reconciled::default();
        let mut recordings = BTreeSet::new();
        for answer in answered {
            let recording: Option<String> = connection
                .query_row(
                    "UPDATE questions
                        SET status = 'answered', answer_evidence = ?3, pinned = 0,
                            shown_at = NULL, updated_at = MAX(?4, updated_at + 1)
                      WHERE id = ?1 AND call_id = ?2 AND status IN ('open', 'asked')
                  RETURNING recording_id",
                    params![
                        answer.question_id,
                        call_id,
                        Json(serde_json::to_value(&answer.evidence)?),
                        now_ms()
                    ],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(recording) = recording {
                reconciled.question_ids.push(answer.question_id.clone());
                recordings.insert(recording);
            }
        }
        for recording in &recordings {
            call_state::recompute_visible(connection, recording)?;
        }
        reconciled.recording_ids = recordings.into_iter().collect();
        Ok(reconciled)
    })
}

/// The `saving` stage (decisions 2, 5, 6): in one transaction saves the
/// summary `ready` (and the call's title if empty), replaces the call's
/// pending proposals (the accepted and rejected ones stay; all of them
/// stay without new ones) and marks the answered questions. On an error nothing is changed: the previous
/// summary and proposals stay. Sends `call` / `updated`.
pub fn save_build(
    connection: &Connection,
    call_id: &str,
    build: &SummaryBuild,
) -> CommandResult<(SavedBuild, Vec<DataChanged>)> {
    call_state::in_savepoint(connection, || {
        let (summary, events) = save_ready(connection, call_id, &build.summary)?;
        let proposals = match &build.proposals {
            Some(new) => proposals::replace_pending(connection, call_id, new)?,
            None => proposals::list(connection, call_id)?,
        };
        let answered = reconcile_questions(connection, call_id, &build.answered)?;
        let saved = SavedBuild {
            summary,
            proposals,
            answered,
        };
        Ok((saved, events))
    })
}

/// At start, before any build runs: every `building` summary was left by a
/// crash or a quit and becomes `failed` / [`INTERRUPTED`], keeping a saved
/// summary. Returns the calls it changed.
pub fn interrupt_building(connection: &Connection, now: i64) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "UPDATE call_summaries
            SET state = 'failed', error = ?1, updated_at = MAX(?2, updated_at + 1)
          WHERE state = 'building'
      RETURNING call_id",
    )?;
    let rows = statement.query_map(params![INTERRUPTED, now], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Sets the decision and/or the title of a card of the saved summary
/// (decision 7). `NotFound` for an unknown call or a card the saved summary
/// does not have, `Invalid` for a blank title. Sends `call` / `updated`.
pub fn update_card(
    connection: &Connection,
    call_id: &str,
    card_id: &str,
    patch: &CardPatch,
) -> CommandResult<(SummaryCard, Vec<DataChanged>)> {
    let event = changed(connection, call_id)?;
    let unknown = || CommandError::not_found(format!("Карточки {card_id} нет в итогах звонка"));
    let mut content = stored(connection, call_id)?
        .and_then(|summary| summary.content)
        .ok_or_else(unknown)?;
    let card = content
        .cards
        .iter_mut()
        .find(|card| card.id == card_id)
        .ok_or_else(unknown)?;
    if let Some(title) = &patch.title {
        card.title = required(title, "Название карточки не может быть пустым")?;
    }
    if let Some(decision) = patch.decision {
        card.decision = decision;
    }
    let card = card.clone();
    connection.execute(
        "UPDATE call_summaries SET content = ?2, updated_at = MAX(?3, updated_at + 1)
          WHERE call_id = ?1",
        params![call_id, Json(serde_json::to_value(&content)?), now_ms()],
    )?;
    Ok((card, vec![event]))
}

#[cfg(test)]
mod tests;
