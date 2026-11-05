//! What the pages after a call read about it (post-call design.md,
//! decisions 7 and 11): its task cards, its recordings with their
//! transcript, and its questions with their moments.
//!
//! Evidence of the fast loop names live segments; after the second pass a
//! read returns the refined ones. [`moment`] finds any pass's segment of
//! the call by its id and points at the phrase of the shown pass at the
//! same time, so a question or a card of the call still opens the right
//! place. A summary built from the live pass before the refined one landed
//! is read the same way ([`shown`]).

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
    summaries::{
        self, CallEvidence, CardFact, CardPatch, FactSource, FactStatus, NextQuestion,
        SegmentMoment, SummaryCard, SummaryCardField, SummaryContent,
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

/// A segment of the call, any pass, and whether the client said it.
fn segment_of(
    connection: &Connection,
    call_id: &str,
    segment_id: &str,
) -> CommandResult<Option<(CallMoment, bool)>> {
    let found: Option<(String, String, i64, i64)> = connection
        .query_row(
            "SELECT s.recording_id, s.channel, s.start_ms, s.end_ms
               FROM transcript_segments AS s JOIN recordings AS r ON r.id = s.recording_id
              WHERE s.id = ?1 AND r.call_id = ?2",
            params![segment_id, call_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((recording_id, channel, start_ms, end_ms)) = found else {
        return Ok(None);
    };
    let by_client = channel == "others";
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
    let moment = CallMoment {
        recording_id,
        segment_id: shown.unwrap_or_else(|| segment_id.to_owned()),
        start_ms,
    };
    Ok(Some((moment, by_client)))
}

/// The moment of a segment of the call, any pass. `None` for an unknown id
/// or a segment of another call.
pub fn moment(
    connection: &Connection,
    call_id: &str,
    segment_id: &str,
) -> CommandResult<Option<CallMoment>> {
    Ok(segment_of(connection, call_id, segment_id)?.map(|(moment, _)| moment))
}

/// The moment of the first quote of a segment that is still there.
fn first_moment(
    connection: &Connection,
    call_id: &str,
    evidence: &[Evidence],
) -> CommandResult<Option<CallMoment>> {
    for quote in evidence {
        if quote.source == EvidenceSource::Segment
            && let Some(found) = moment(connection, call_id, &quote.id)?
        {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// A summary's evidence and ranges point at the phrases of the shown pass
/// (a summary built from the live pass, read after the refined one landed).
/// What the call no longer has stays as saved.
pub fn shown(
    connection: &Connection,
    call_id: &str,
    content: &mut SummaryContent,
) -> CommandResult<()> {
    let evidence = content
        .topics
        .iter_mut()
        .flat_map(|topic| topic.points.iter_mut())
        .flat_map(|point| point.evidence.iter_mut())
        .chain(
            content
                .cards
                .iter_mut()
                .flat_map(|card| card.fields.iter_mut())
                .flat_map(|field| field.facts.iter_mut())
                .flat_map(|fact| fact.evidence.iter_mut()),
        );
    for quote in evidence {
        if let Some(found) = moment(connection, call_id, &quote.segment_id)? {
            quote.segment_id = found.segment_id;
        }
    }
    let ranges = content
        .topics
        .iter_mut()
        .flat_map(|topic| [&mut topic.from, &mut topic.to]);
    for range in ranges {
        let SegmentMoment { segment_id, .. } = range;
        if let Some(found) = moment(connection, call_id, segment_id)? {
            *segment_id = found.segment_id;
        }
    }
    Ok(())
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
    if let Some(mut content) =
        summaries::get(connection, call_id)?.and_then(|summary| summary.content)
    {
        shown(connection, call_id, &mut content)?;
        return Ok(CallCards {
            source: CallCardsSource::Summary,
            cards: content.cards,
            next: content.next,
        });
    }
    let cards = live_cards(connection, call_id)?
        .iter()
        .map(|card| live_card(connection, call_id, card))
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
fn live_card(
    connection: &Connection,
    call_id: &str,
    card: &TaskCard,
) -> CommandResult<SummaryCard> {
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
            Some(field) => vec![live_fact(connection, call_id, lens, field, &questions)?],
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

/// The source is «сказал клиент» only with a phrase of «Остальные» (its
/// quotes are the evidence), else «из документов проекта» with a project
/// item, else «вывод агента»: the manager's own words are no source.
fn live_fact(
    connection: &Connection,
    call_id: &str,
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
    let mut evidence = Vec::new();
    for quote in &field.evidence {
        if quote.source != EvidenceSource::Segment {
            continue;
        }
        if let Some((found, true)) = segment_of(connection, call_id, &quote.id)? {
            evidence.push(CallEvidence {
                recording_id: found.recording_id,
                segment_id: found.segment_id,
                start_ms: found.start_ms,
                quote: quote.quote.clone(),
            });
        }
    }
    let from_project = field
        .evidence
        .iter()
        .any(|quote| quote.source == EvidenceSource::Project);
    let source = if !evidence.is_empty() {
        FactSource::Client
    } else if from_project {
        FactSource::Project
    } else {
        FactSource::Agent
    };
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
        .map(summaries::card_title)
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
        card: live_card(connection, call_id, &card)?,
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
            let moment = first_moment(connection, call_id, &question.evidence)?;
            let answer = match &question.answer_evidence {
                Some(evidence) => first_moment(connection, call_id, evidence)?,
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

/* The history (`call-history`, «Список звонков») */

/// What a row of the history shows of a call, read in one query for every
/// call (`calls_overview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallOverview {
    pub call_id: String,
    pub project_id: Option<String>,
    /// The call's title, else its summary's, else the summary's first
    /// topic, else the fast loop's first topic; empty without any (the
    /// history names the call after its project then).
    pub title: String,
    /// Proposals waiting for review: the same count as the sidebar, the
    /// summary and the review page.
    pub pending_proposals: u32,
    /// Questions of its recordings not closed: open, and asked without an
    /// answer.
    pub open_questions: u32,
    /// The audio of every recording was deleted («аудио удалено»); `false`
    /// for a call without recordings.
    pub audio_deleted: bool,
}

/// Every call, or the calls of `project_id`, newest first (as
/// `calls_list`), with what the history shows of each.
pub fn overview(
    connection: &Connection,
    project_id: Option<&str>,
) -> CommandResult<Vec<CallOverview>> {
    let mut statement = connection.prepare(
        "SELECT c.id, c.project_id, c.title,
                (SELECT s.title FROM call_summaries s WHERE s.call_id = c.id),
                (SELECT json_extract(s.content, '$.topics[0].title')
                   FROM call_summaries s WHERE s.call_id = c.id AND s.content IS NOT NULL),
                (SELECT t.title FROM topics t JOIN recordings r ON r.id = t.recording_id
                  WHERE r.call_id = c.id ORDER BY r.started_at, r.id, t.position LIMIT 1),
                (SELECT count(*) FROM call_proposals p
                  WHERE p.call_id = c.id AND p.decision = 'pending'),
                (SELECT count(*) FROM questions q JOIN recordings r ON r.id = q.recording_id
                  WHERE r.call_id = c.id AND q.status IN ('open', 'asked')),
                (SELECT count(*) FROM recordings r WHERE r.call_id = c.id),
                (SELECT count(*) FROM recordings r
                  WHERE r.call_id = c.id AND r.audio_deleted_at IS NOT NULL)
           FROM calls c
          WHERE ?1 IS NULL OR c.project_id = ?1
          ORDER BY coalesce(c.started_at, c.created_at) DESC, c.id DESC",
    )?;
    let rows = statement.query_map([project_id], |row| {
        let titles: [Option<String>; 4] = [row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?];
        let recordings: u32 = row.get(8)?;
        let deleted: u32 = row.get(9)?;
        Ok(CallOverview {
            call_id: row.get(0)?,
            project_id: row.get(1)?,
            title: titles
                .into_iter()
                .flatten()
                .map(|title| title.trim().to_owned())
                .find(|title| !title.is_empty())
                .unwrap_or_default(),
            pending_proposals: row.get(6)?,
            open_questions: row.get(7)?,
            audio_deleted: recordings > 0 && deleted == recordings,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
pub mod testing;
#[cfg(test)]
mod tests;
