//! What the pages after a call read about it (post-call design.md,
//! decisions 7 and 11): its task cards, its recordings with their
//! transcript, and its questions with their moments.
//!
//! Evidence of the fast loop names live segments; after the second pass a
//! read returns the refined ones. [`moment`] finds any pass's segment by
//! its id and points at the phrase of the shown pass at the same time, so a
//! question or a card of the call still opens the right place.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use specta::Type;

use super::{
    call_state::{
        CARD_COLUMNS, CardLens, Evidence, EvidenceSource, GapType, QUESTION_COLUMNS, Question,
        QuestionStatus, TaskCard, card_from_row, question_from_row,
    },
    calls, now_ms,
    recordings::{self, TranscriptState},
    required,
    summaries::{
        self, CallEvidence, CardFact, CardPatch, FactSource, FactStatus, NextQuestion, SummaryCard,
        SummaryCardField,
    },
    transcript::{self, SHOWN_PASS, TranscriptPass, TranscriptSegment},
};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

/* Moments */

/// A phrase of the call: where to scroll the transcript and seek the player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallMoment {
    pub recording_id: String,
    /// The phrase of the shown pass (`call_transcript`) at that time, on
    /// the same channel; the segment itself when the shown pass has none.
    pub segment_id: String,
    /// From the start of the recording: when the phrase named was said.
    pub start_ms: i64,
}

/// The moment of a segment of any pass. `None` for an unknown id.
pub fn moment(connection: &Connection, segment_id: &str) -> CommandResult<Option<CallMoment>> {
    let found: Option<(String, String, i64, i64)> = connection
        .query_row(
            "SELECT recording_id, channel, start_ms, end_ms FROM transcript_segments WHERE id = ?1",
            [segment_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((recording_id, channel, start_ms, end_ms)) = found else {
        return Ok(None);
    };
    let shown: Option<String> = connection
        .query_row(
            &format!(
                "SELECT s.id FROM transcript_segments AS s
                  WHERE s.recording_id = ?1 AND s.channel = ?2 AND {SHOWN_PASS}
                  ORDER BY max(0, min(s.end_ms, ?4) - max(s.start_ms, ?3)) DESC,
                           abs(s.start_ms - ?3), s.id
                  LIMIT 1"
            ),
            params![recording_id, channel, start_ms, end_ms],
            |row| row.get(0),
        )
        .optional()?;
    Ok(Some(CallMoment {
        recording_id,
        segment_id: shown.unwrap_or_else(|| segment_id.to_owned()),
        start_ms,
    }))
}

/// The moment of the first quote of a segment that is still there.
fn first_moment(
    connection: &Connection,
    evidence: &[Evidence],
) -> CommandResult<Option<CallMoment>> {
    for quote in evidence {
        if quote.source == EvidenceSource::Segment
            && let Some(found) = moment(connection, &quote.id)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/* Task cards (decision 7) */

/// Where the cards of a call come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CallCardsSource {
    /// The saved summary's cards (one per topic, facts with sources).
    Summary,
    /// No summary saved yet: the fast loop's cards of every recording.
    Live,
}

/// The task cards page of a call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallCards {
    pub source: CallCardsSource,
    /// In topic order (`live`: recording after recording). A `live` card
    /// has one fact per lens with a value, none for an empty lens; its
    /// `topicId` is the fast loop's topic.
    pub cards: Vec<SummaryCard>,
    /// The summary's questions for the next call; empty when `live`.
    pub next: Vec<NextQuestion>,
}

/// The cards of a call: the saved summary's when there is one (also while
/// a rebuild runs or after it failed: the summary page shows that summary
/// too), else the fast loop's of every recording. `NotFound` for an
/// unknown call.
pub fn cards(connection: &Connection, call_id: &str) -> CommandResult<CallCards> {
    if let Some(content) = summaries::get(connection, call_id)?.and_then(|summary| summary.content)
    {
        return Ok(CallCards {
            source: CallCardsSource::Summary,
            cards: content.cards,
            next: content.next,
        });
    }
    let cards = live_cards(connection, call_id)?
        .iter()
        .map(|card| live_card(connection, card))
        .collect::<CommandResult<_>>()?;
    Ok(CallCards {
        source: CallCardsSource::Live,
        cards,
        next: Vec::new(),
    })
}

const OF_CALL: &str = "recording_id IN (SELECT id FROM recordings WHERE call_id = ?1)";
const BY_RECORDING: &str = "(SELECT started_at FROM recordings r WHERE r.id = recording_id),
       recording_id";

fn live_cards(connection: &Connection, call_id: &str) -> CommandResult<Vec<TaskCard>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {CARD_COLUMNS} FROM task_cards WHERE {OF_CALL}
          ORDER BY {BY_RECORDING},
                   (SELECT position FROM topics t WHERE t.id = topic_id), id"
    ))?;
    let rows = statement.query_map([call_id], card_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A fast loop card as the cards page shows it: its value per lens is the
/// fact; the state comes from the card's open and asked questions on that
/// lens (a contradiction, else an assumption, else confirmed).
fn live_card(connection: &Connection, card: &TaskCard) -> CommandResult<SummaryCard> {
    let mut statement = connection.prepare(&format!(
        "SELECT {QUESTION_COLUMNS} FROM questions
          WHERE card_id = ?1 AND status IN ('open', 'asked')"
    ))?;
    let questions: Vec<Question> = statement
        .query_map([&card.id], question_from_row)?
        .collect::<Result<_, _>>()?;
    let title = if card.title.trim().is_empty() {
        connection
            .query_row(
                "SELECT title FROM topics WHERE id = ?1",
                [&card.topic_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_default()
    } else {
        card.title.clone()
    };
    let mut fields = Vec::new();
    for lens in CardLens::ALL {
        let value = card
            .fields
            .iter()
            .find(|field| field.field == lens && !field.value.trim().is_empty());
        let facts = match value {
            Some(field) => vec![live_fact(connection, lens, field, &questions)?],
            None => Vec::new(),
        };
        fields.push(SummaryCardField { field: lens, facts });
    }
    Ok(SummaryCard {
        id: card.id.clone(),
        topic_id: card.topic_id.clone(),
        title,
        decision: card.decision,
        fields,
    })
}

fn live_fact(
    connection: &Connection,
    lens: CardLens,
    field: &super::call_state::CardField,
    questions: &[Question],
) -> CommandResult<CardFact> {
    let gaps: Vec<GapType> = questions
        .iter()
        .filter(|question| question.card_field == Some(lens))
        .map(|question| question.gap_type)
        .collect();
    let status = if gaps.contains(&GapType::Contradiction) {
        FactStatus::Contradiction
    } else if gaps.contains(&GapType::Assumption) {
        FactStatus::Assumption
    } else {
        FactStatus::Confirmed
    };
    let source = match field.evidence.first().map(|quote| quote.source) {
        Some(EvidenceSource::Segment) => FactSource::Client,
        Some(EvidenceSource::Project) => FactSource::Project,
        None => FactSource::Agent,
    };
    let mut evidence = Vec::new();
    for quote in &field.evidence {
        if quote.source != EvidenceSource::Segment {
            continue;
        }
        if let Some(found) = moment(connection, &quote.id)? {
            evidence.push(CallEvidence {
                recording_id: found.recording_id,
                segment_id: found.segment_id,
                start_ms: found.start_ms,
                quote: quote.quote.clone(),
            });
        }
    }
    Ok(CardFact {
        text: field.value.clone(),
        status,
        source,
        evidence,
    })
}

/// A card changed by [`update_card`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdatedCard {
    pub card: SummaryCard,
    /// The recording of a fast loop card (its windows get
    /// `CallStateChanged`); `None` for a summary card.
    pub recording_id: Option<String>,
}

/// `call_card_update` (decision 7): a card of the saved summary, or a fast
/// loop card of one of the call's recordings (`task_cards.decision` /
/// `title`). Absent fields stay. `NotFound` for an unknown call or a card
/// of neither, `Invalid` for a blank title. Sends `call` / `updated`.
pub fn update_card(
    connection: &Connection,
    call_id: &str,
    card_id: &str,
    patch: &CardPatch,
) -> CommandResult<(UpdatedCard, Vec<DataChanged>)> {
    let project_id = calls::project_of(connection, call_id)?;
    let in_summary = summaries::get(connection, call_id)?
        .and_then(|summary| summary.content)
        .is_some_and(|content| content.cards.iter().any(|card| card.id == card_id));
    if in_summary {
        let (card, events) = summaries::update_card(connection, call_id, card_id, patch)?;
        let updated = UpdatedCard {
            card,
            recording_id: None,
        };
        return Ok((updated, events));
    }
    connection
        .query_row(
            &format!("SELECT 1 FROM task_cards WHERE id = ?2 AND {OF_CALL}"),
            params![call_id, card_id],
            |_| Ok(()),
        )
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Карточки {card_id} нет у звонка")))?;
    let title = patch
        .title
        .as_deref()
        .map(|title| required(title, "Название карточки не может быть пустым"))
        .transpose()?;
    connection.execute(
        "UPDATE task_cards
            SET title = coalesce(?2, title), decision = coalesce(?3, decision),
                updated_at = MAX(?4, updated_at + 1)
          WHERE id = ?1",
        params![
            card_id,
            title,
            patch.decision.map(|decision| decision.as_str()),
            now_ms()
        ],
    )?;
    let card = connection.query_row(
        &format!("SELECT {CARD_COLUMNS} FROM task_cards WHERE id = ?1"),
        [card_id],
        card_from_row,
    )?;
    let updated = UpdatedCard {
        card: live_card(connection, &card)?,
        recording_id: Some(card.recording_id),
    };
    let event = DataChanged::new(
        Entity::Call,
        call_id,
        project_id.as_deref(),
        Change::Updated,
    );
    Ok((updated, vec![event]))
}

/* Transcript (decision 11) */

/// A recording of a call with its transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallRecording {
    pub id: String,
    /// Milliseconds since the Unix epoch: a phrase's wall-clock time is
    /// `startedAt + startMs`.
    pub started_at: i64,
    /// `null` while it is being written.
    pub ended_at: Option<i64>,
    /// `endedAt − startedAt`; `null` while it is being written.
    pub duration_ms: Option<i64>,
    /// "Удалить запись" removed its files: no player.
    pub audio_deleted: bool,
    /// Where the second pass is.
    pub transcript_state: TranscriptState,
    /// The pass of `segments`: refined once the second pass stored it.
    pub pass: TranscriptPass,
    /// Sizes of the channel files in bytes; `null` without the file.
    pub me_bytes: Option<u64>,
    pub others_bytes: Option<u64>,
    /// The shown pass, both channels in time order.
    pub segments: Vec<TranscriptSegment>,
}

/// The recordings of a call in the order they started, each with its
/// transcript (the refined pass if it has one). `dataDir`: what the files'
/// paths are relative to (`None`: no sizes). `NotFound` for an unknown call.
pub fn transcript(
    connection: &Connection,
    data_dir: Option<&Path>,
    call_id: &str,
) -> CommandResult<Vec<CallRecording>> {
    let size = |file: &str| -> Option<u64> {
        let path = data_dir?.join(file);
        path.metadata().ok().map(|meta| meta.len())
    };
    recordings::for_call(connection, call_id)?
        .into_iter()
        .map(|recording| {
            let segments = transcript::for_recording(connection, &recording.id)?;
            let pass = if segments
                .iter()
                .any(|segment| segment.pass == TranscriptPass::Refined)
            {
                TranscriptPass::Refined
            } else {
                TranscriptPass::Live
            };
            let audio_deleted = recording.audio_deleted_at.is_some();
            let files = (!audio_deleted).then_some(&recording.files);
            Ok(CallRecording {
                duration_ms: recording.ended_at.map(|end| end - recording.started_at),
                me_bytes: files.and_then(|files| size(&files.me)),
                others_bytes: files.and_then(|files| size(&files.others)),
                id: recording.id,
                started_at: recording.started_at,
                ended_at: recording.ended_at,
                audio_deleted,
                transcript_state: recording.transcript_state,
                pass,
                segments,
            })
        })
        .collect()
}

/* Questions (decision 11) */

/// A question of the call with the moments it rests on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallQuestion {
    pub id: String,
    pub recording_id: String,
    pub topic_id: Option<String>,
    pub card_id: Option<String>,
    pub text: String,
    pub description: String,
    pub card_field: Option<CardLens>,
    pub gap_type: GapType,
    pub priority: i32,
    pub status: QuestionStatus,
    pub evidence: Vec<Evidence>,
    pub answer_evidence: Option<Vec<Evidence>>,
    /// The phrase the question rests on; `null` when it rests on the
    /// project only.
    pub moment: Option<CallMoment>,
    /// The client's answer, once answered.
    pub answer: Option<CallMoment>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Every question of the call's recordings (hidden ones too), recording
/// after recording, oldest first. `NotFound` for an unknown call.
pub fn questions(connection: &Connection, call_id: &str) -> CommandResult<Vec<CallQuestion>> {
    calls::project_of(connection, call_id)?;
    let mut statement = connection.prepare(&format!(
        "SELECT {QUESTION_COLUMNS} FROM questions WHERE {OF_CALL}
          ORDER BY {BY_RECORDING}, created_at, id"
    ))?;
    let rows: Vec<Question> = statement
        .query_map([call_id], question_from_row)?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|question| {
            let moment = first_moment(connection, &question.evidence)?;
            let answer = match &question.answer_evidence {
                Some(evidence) => first_moment(connection, evidence)?,
                None => None,
            };
            Ok(CallQuestion {
                id: question.id,
                recording_id: question.recording_id,
                topic_id: question.topic_id,
                card_id: question.card_id,
                text: question.text,
                description: question.description,
                card_field: question.card_field,
                gap_type: question.gap_type,
                priority: question.priority,
                status: question.status,
                evidence: question.evidence,
                answer_evidence: question.answer_evidence,
                moment,
                answer,
                created_at: question.created_at,
                updated_at: question.updated_at,
            })
        })
        .collect()
}

#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;
