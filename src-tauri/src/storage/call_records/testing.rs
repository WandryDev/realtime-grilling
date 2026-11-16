//! A finished call with recordings, transcript, fast loop state and a
//! summary, for the tests of the post-call reads.

use rusqlite::Connection;

use crate::storage::{
    call_state::{
        self, AppliedPatch, CardLens, Evidence, EvidenceSource, GapType, NewQuestion,
        TaskCardDecision, ValidatedOp, ValidatedPatch,
    },
    calls::{self, CallCreate, CallStatus},
    new_id,
    projects::{self, ProjectCreate},
    recordings::{self, RecordingFiles, RecordingLinks},
    summaries::{
        self, CallEvidence, CardFact, FactSource, FactStatus, NextQuestion, PointStatus,
        ReadySummary, SegmentMoment, SummaryCard, SummaryCardField, SummaryContent, SummaryPoint,
        SummaryTopic, SummaryTranscriptPass,
    },
    transcript::{self, SegmentInput, TranscriptChannel, TranscriptSegment},
};

pub fn project(connection: &Connection, name: &str) -> String {
    let input = ProjectCreate {
        name: name.to_owned(),
        ..ProjectCreate::default()
    };
    projects::create(connection, input).unwrap().0.id
}

/// A finished call of `project` titled `title`, started at `started_at`.
pub fn call(
    connection: &Connection,
    project: Option<&str>,
    title: &str,
    started_at: i64,
) -> String {
    let input = CallCreate {
        project_id: project.map(str::to_owned),
        title: Some(title.to_owned()),
        status: Some(CallStatus::Finished),
        started_at: Some(started_at),
        ended_at: Some(started_at + 3_600_000),
        ..CallCreate::default()
    };
    calls::create(connection, input).unwrap().0.id
}

/// A finished recording of the call from `started_at` for a minute.
pub fn recording(connection: &Connection, call_id: &str, started_at: i64) -> String {
    let id = recordings::create(
        connection,
        &RecordingLinks::call(call_id),
        started_at,
        |id| RecordingFiles {
            me: format!("recordings/{id}/me.opus"),
            others: format!("recordings/{id}/others.opus"),
        },
    )
    .unwrap();
    recordings::finish(connection, &id, started_at + 60_000).unwrap();
    id
}

pub fn input(channel: TranscriptChannel, start_ms: i64, text: &str) -> SegmentInput {
    SegmentInput {
        channel,
        start_ms,
        end_ms: start_ms + 2_000,
        text: text.to_owned(),
    }
}

pub fn live(
    connection: &Connection,
    recording_id: &str,
    channel: TranscriptChannel,
    start_ms: i64,
    text: &str,
) -> TranscriptSegment {
    transcript::append_live(connection, recording_id, input(channel, start_ms, text))
        .unwrap()
        .0
}

pub fn refined(
    connection: &Connection,
    recording_id: &str,
    segments: Vec<SegmentInput>,
) -> Vec<TranscriptSegment> {
    transcript::replace_refined(connection, recording_id, segments)
        .unwrap()
        .0
}

pub fn quote(segment: &TranscriptSegment) -> Evidence {
    Evidence {
        source: EvidenceSource::Segment,
        id: segment.id.clone(),
        quote: segment.text.clone(),
    }
}

/// A topic `title` with `goal` (rests on `evidence`) and an open question
/// on `lens` with `gap`.
pub fn topic(
    connection: &Connection,
    recording_id: &str,
    title: &str,
    goal: &str,
    evidence: Vec<Evidence>,
    lens: CardLens,
    gap: GapType,
) -> AppliedPatch {
    let patch = ValidatedPatch {
        ops: vec![
            ValidatedOp::CreateTopic {
                title: title.to_owned(),
            },
            ValidatedOp::SetCardField {
                field: CardLens::Goal,
                value: goal.to_owned(),
                evidence: evidence.clone(),
            },
            ValidatedOp::AddQuestion(NewQuestion {
                text: format!("Что с «{title}»?"),
                description: String::new(),
                card_field: lens,
                gap_type: gap,
                priority: 2,
                evidence,
            }),
        ],
    };
    call_state::apply_patch(connection, recording_id, &patch).unwrap()
}

pub fn call_evidence(segment: &TranscriptSegment) -> CallEvidence {
    CallEvidence {
        recording_id: segment.recording_id.clone(),
        segment_id: segment.id.clone(),
        start_ms: segment.start_ms,
        quote: segment.text.clone(),
    }
}

fn segment_moment(segment: &TranscriptSegment) -> SegmentMoment {
    SegmentMoment {
        recording_id: segment.recording_id.clone(),
        segment_id: segment.id.clone(),
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
    }
}

/// Saves a ready summary of one topic: a point and a card fact resting on
/// `segment`. Returns the card id.
pub fn summary(
    connection: &Connection,
    call_id: &str,
    tldr: &str,
    point: &str,
    fact: &str,
    segment: &TranscriptSegment,
) -> String {
    let topic_id = new_id();
    let card_id = new_id();
    let content = SummaryContent {
        topics: vec![SummaryTopic {
            id: topic_id.clone(),
            topic_ids: Vec::new(),
            title: "Касса".to_owned(),
            from: segment_moment(segment),
            to: segment_moment(segment),
            points: vec![SummaryPoint {
                text: point.to_owned(),
                status: PointStatus::Fact,
                evidence: vec![call_evidence(segment)],
            }],
        }],
        cards: vec![SummaryCard {
            id: card_id.clone(),
            topic_id,
            title: "Касса".to_owned(),
            decision: TaskCardDecision::Pending,
            fields: vec![SummaryCardField {
                field: CardLens::Goal,
                facts: vec![CardFact {
                    text: fact.to_owned(),
                    status: FactStatus::Confirmed,
                    source: FactSource::Client,
                    evidence: vec![call_evidence(segment)],
                }],
            }],
        }],
        next: vec![NextQuestion {
            text: "Кто считает кассу?".to_owned(),
            topic_id: None,
            field: Some(CardLens::Users),
            gap: GapType::Empty,
        }],
    };
    let ready = ReadySummary {
        title: "Итоги".to_owned(),
        tldr: tldr.to_owned(),
        transcript_pass: SummaryTranscriptPass::Refined,
        content,
    };
    summaries::save_ready(connection, call_id, &ready).unwrap();
    card_id
}
