//! The queue of the events for the team's analytics (call-analytics
//! design.md, decision 5; spec `analytics-delivery`). Every change is put
//! here in the transaction of the change itself: a change that rolled back
//! sends nothing, a change that committed is not lost. The sender
//! (`analytics::Sender`) posts the queue and removes what the server took.
//!
//! The queue is on only on a connection [`enable_on`] marked (a build with
//! the server's address): elsewhere — the tests, a debug build, `grill-eval`
//! — every function here does nothing. Calls and recordings created before
//! `analytics_meta.enabled_since` are never sent; the projects always are.

use std::sync::{Arc, OnceLock};

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde_json::Value;
use tokio::sync::Notify;

use super::{json::Json, new_id, now_ms};
use crate::{
    analytics::contract::{
        self, AgentCallEvent, AgentCallOpEvent, CallEvent, CardEvent, Envelope, Event,
        FindingEvent, FindingStepEvent, ProjectEvent, PromptPartEvent, PromptPartRef,
        QuestionEvent, QuestionStepEvent, RecordingEvent, RefinedSegment, RefinedTranscriptEvent,
        SegmentEvent, TopicEvent,
    },
    error::{CommandError, CommandResult},
};

/// Wakes the sender: something was queued (maybe not committed yet; the
/// sender waits a moment before it reads).
pub fn notifier() -> Arc<Notify> {
    static NOTIFY: OnceLock<Arc<Notify>> = OnceLock::new();
    Arc::clone(NOTIFY.get_or_init(|| Arc::new(Notify::new())))
}

/// Turns the queue on for `connection` and queues every project as it is
/// now: a project made before the analytics started (or before this build)
/// was never sent at its creation, and without it its calls land in «Без
/// проекта». The server takes a project's snapshot again without harm.
pub fn enable_on(connection: &Connection) -> CommandResult<()> {
    connection.execute_batch("CREATE TEMP TABLE IF NOT EXISTS analytics_on (on_since INTEGER)")?;
    let ids = connection
        .prepare("SELECT id FROM projects ORDER BY created_at, id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let at = now_ms();
    for id in ids {
        project(connection, &id, at)?;
    }
    Ok(())
}

/// Whether the queue is on for `connection`.
pub fn is_enabled(connection: &Connection) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'analytics_on'",
            [],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

/// When this database started sending.
fn enabled_since(connection: &Connection) -> CommandResult<i64> {
    Ok(connection
        .query_row(
            "SELECT enabled_since FROM analytics_meta WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(i64::MAX))
}

/// Whether the entities of recording `recording_id` are sent: it was
/// created since the analytics started.
fn recording_sent(connection: &Connection, recording_id: &str) -> CommandResult<bool> {
    let created: Option<i64> = connection
        .query_row(
            "SELECT created_at FROM recordings WHERE id = ?1",
            [recording_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(created.is_some_and(|created| created >= enabled_since(connection).unwrap_or(i64::MAX)))
}

/// Whether call `call_id` is sent.
fn call_sent(connection: &Connection, call_id: &str) -> CommandResult<bool> {
    let created: Option<i64> = connection
        .query_row(
            "SELECT created_at FROM calls WHERE id = ?1",
            [call_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(created.is_some_and(|created| created >= enabled_since(connection).unwrap_or(i64::MAX)))
}

/// Puts `event` at `at` into the queue (does nothing when the queue is off).
pub fn enqueue(connection: &Connection, event: Event, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let envelope = Envelope {
        id: new_id(),
        v: contract::VERSION,
        at,
        event,
    };
    let body = serde_json::to_string(&envelope)?;
    connection
        .prepare_cached(
            "INSERT INTO analytics_outbox (id, kind, v, at, body, bytes, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?
        .execute(params![
            envelope.id,
            envelope.event.kind(),
            envelope.v,
            at,
            body,
            i64::try_from(body.len()).unwrap_or(i64::MAX),
            now_ms()
        ])?;
    notifier().notify_one();
    Ok(())
}

fn parse<T: serde::de::DeserializeOwned>(text: &str) -> rusqlite::Result<T> {
    serde_json::from_value(Value::from(text)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

/* The snapshots */

/// A project at its creation and at a rename (always sent).
pub fn project(connection: &Connection, project_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let name: String = connection.query_row(
        "SELECT name FROM projects WHERE id = ?1",
        [project_id],
        |row| row.get(0),
    )?;
    enqueue(
        connection,
        Event::Project(ProjectEvent {
            local_id: project_id.to_owned(),
            name,
        }),
        at,
    )
}

/// A call as it is now.
pub fn call(connection: &Connection, call_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) || !call_sent(connection, call_id)? {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, project_id, title, status, started_at, ended_at FROM calls WHERE id = ?1",
        [call_id],
        |row| {
            Ok(CallEvent {
                id: row.get(0)?,
                project_local_id: row.get(1)?,
                title: row.get(2)?,
                status: parse(&row.get::<_, String>(3)?)?,
                started_at: row.get(4)?,
                ended_at: row.get(5)?,
            })
        },
    )?;
    enqueue(connection, Event::Call(event), at)
}

/// A recording as it is now.
pub fn recording(connection: &Connection, recording_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) || !recording_sent(connection, recording_id)? {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, call_id, status, started_at, ended_at FROM recordings WHERE id = ?1",
        [recording_id],
        |row| {
            Ok(RecordingEvent {
                id: row.get(0)?,
                call_id: row.get(1)?,
                status: parse(&row.get::<_, String>(2)?)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
            })
        },
    )?;
    enqueue(connection, Event::Recording(event), at)
}

/// A phrase of the live pass.
pub fn segment(connection: &Connection, segment_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, recording_id, channel, start_ms, end_ms, text
           FROM transcript_segments WHERE id = ?1",
        [segment_id],
        |row| {
            Ok(SegmentEvent {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                channel: parse(&row.get::<_, String>(2)?)?,
                start_ms: row.get(3)?,
                end_ms: row.get(4)?,
                text: row.get(5)?,
            })
        },
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    enqueue(connection, Event::Segment(event), at)
}

/// The refined transcript of a recording, whole.
pub fn refined_transcript(
    connection: &Connection,
    recording_id: &str,
    at: i64,
) -> CommandResult<()> {
    if !is_enabled(connection) || !recording_sent(connection, recording_id)? {
        return Ok(());
    }
    let segments = connection
        .prepare(
            "SELECT id, channel, start_ms, end_ms, text FROM transcript_segments
              WHERE recording_id = ?1 AND pass = 'refined' ORDER BY start_ms, id",
        )?
        .query_map([recording_id], |row| {
            Ok(RefinedSegment {
                id: row.get(0)?,
                channel: parse(&row.get::<_, String>(1)?)?,
                start_ms: row.get(2)?,
                end_ms: row.get(3)?,
                text: row.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    enqueue(
        connection,
        Event::RefinedTranscript(RefinedTranscriptEvent {
            recording_id: recording_id.to_owned(),
            segments,
        }),
        at,
    )
}

/// A topic as it is now.
pub fn topic(connection: &Connection, topic_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, recording_id, title, created_at FROM topics WHERE id = ?1",
        [topic_id],
        |row| {
            Ok(TopicEvent {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    enqueue(connection, Event::Topic(event), at)
}

/// The card of topic `topic_id` as it is now.
pub fn card(connection: &Connection, topic_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, topic_id, recording_id, fields FROM task_cards WHERE topic_id = ?1",
        [topic_id],
        |row| {
            let Json(fields) = row.get(3)?;
            Ok(CardEvent {
                id: row.get(0)?,
                topic_id: row.get(1)?,
                recording_id: row.get(2)?,
                fields,
            })
        },
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    enqueue(connection, Event::Card(event), at)
}

fn question_row(row: &Row<'_>) -> rusqlite::Result<QuestionEvent> {
    let Json(evidence) = row.get(7)?;
    let answer_evidence: Option<Json> = row.get(8)?;
    Ok(QuestionEvent {
        id: row.get(0)?,
        recording_id: row.get(1)?,
        topic_id: row.get(2)?,
        text: row.get(3)?,
        description: row.get(4)?,
        card_field: row.get(5)?,
        gap_type: row.get(6)?,
        evidence,
        answer_evidence: answer_evidence.map(|Json(value)| value),
        status: parse(&row.get::<_, String>(9)?)?,
        pinned: row.get(10)?,
        shown_at: row.get(11)?,
        created_at: row.get(12)?,
        priority: row.get(13)?,
    })
}

/// A question as it is now.
pub fn question(connection: &Connection, question_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, recording_id, topic_id, text, description, card_field, gap_type, evidence,
                answer_evidence, status, pinned, shown_at, created_at, priority
           FROM questions WHERE id = ?1",
        [question_id],
        question_row,
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    enqueue(connection, Event::Question(event), at)
}

/// A step of a question (`question_events` row `event_id`) and the question
/// after it.
pub fn question_step(connection: &Connection, event_id: &str) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, question_id, recording_id, kind, agent_call_id, at
           FROM question_events WHERE id = ?1",
        [event_id],
        |row| {
            Ok(QuestionStepEvent {
                id: row.get(0)?,
                question_id: row.get(1)?,
                recording_id: row.get(2)?,
                step: parse(&row.get::<_, String>(3)?)?,
                agent_call_id: row.get(4)?,
                at: row.get(5)?,
            })
        },
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    let (question_id, at) = (event.question_id.clone(), event.at);
    enqueue(connection, Event::QuestionStep(event), at)?;
    question(connection, &question_id, at)
}

/// A finding of the slow loop as it is now.
pub fn finding(connection: &Connection, finding_id: &str, at: i64) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT id, recording_id, source_kind, source_name, source_url, chunk_key, quote, note,
                question_id, agent_call_id, created_at, hidden_at, evicted_at
           FROM context_findings WHERE id = ?1",
        [finding_id],
        |row| {
            Ok(FindingEvent {
                id: row.get(0)?,
                recording_id: row.get(1)?,
                source_kind: parse(&row.get::<_, String>(2)?)?,
                source_name: row.get(3)?,
                source_url: row.get(4)?,
                chunk_key: row.get(5)?,
                quote: row.get(6)?,
                note: row.get(7)?,
                question_id: row.get(8)?,
                agent_call_id: row.get(9)?,
                created_at: row.get(10)?,
                hidden_at: row.get(11)?,
                evicted_at: row.get(12)?,
            })
        },
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    enqueue(connection, Event::Finding(event), at)
}

/// A step of a finding (`finding_events` row `event_id`) and the finding
/// after it.
pub fn finding_step(connection: &Connection, event_id: &str) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let event = connection.query_row(
        "SELECT e.id, e.finding_id, f.recording_id, e.kind, e.at
           FROM finding_events e JOIN context_findings f ON f.id = e.finding_id
          WHERE e.id = ?1",
        [event_id],
        |row| {
            Ok(FindingStepEvent {
                id: row.get(0)?,
                finding_id: row.get(1)?,
                recording_id: row.get(2)?,
                step: parse(&row.get::<_, String>(3)?)?,
                at: row.get(4)?,
            })
        },
    )?;
    if !recording_sent(connection, &event.recording_id)? {
        return Ok(());
    }
    let (finding_id, at) = (event.finding_id.clone(), event.at);
    enqueue(connection, Event::FindingStep(event), at)?;
    finding(connection, &finding_id, at)
}

/// Whether an agent call's owner is sent.
fn agent_call_sent(connection: &Connection, call: &AgentCallEvent) -> CommandResult<bool> {
    if let Some(recording_id) = &call.recording_id {
        return recording_sent(connection, recording_id);
    }
    if let Some(call_id) = &call.call_id {
        return call_sent(connection, call_id);
    }
    // A project's brief: the projects are always sent.
    Ok(true)
}

/// An agent call with its prompt, its operations and the texts of its
/// prompt stored for the first time (`new_parts`, their hashes: each text
/// goes once).
pub fn agent_call(
    connection: &Connection,
    call_id: &str,
    new_parts: &[String],
) -> CommandResult<()> {
    if !is_enabled(connection) {
        return Ok(());
    }
    let mut event = connection.query_row(
        "SELECT id, kind, recording_id, call_id, project_id, started_at, duration_ms, outcome,
                input_tokens, output_tokens, cache_read, cache_write, cost_usd, utilization,
                error, model, effort, trigger_reason, trigger_segment_id, window_segments,
                findings_in_prompt, queries, raw_reply, reply
           FROM agent_calls WHERE id = ?1",
        [call_id],
        |row| {
            let list = |index: usize| -> rusqlite::Result<Option<Vec<String>>> {
                let value: Option<Json> = row.get(index)?;
                Ok(value.and_then(|Json(value)| serde_json::from_value(value).ok()))
            };
            let json = |index: usize| -> rusqlite::Result<Option<Value>> {
                Ok(row.get::<_, Option<Json>>(index)?.map(|Json(value)| value))
            };
            let trigger: Option<String> = row.get(17)?;
            Ok(AgentCallEvent {
                id: row.get(0)?,
                kind: parse(&row.get::<_, String>(1)?)?,
                recording_id: row.get(2)?,
                call_id: row.get(3)?,
                project_local_id: row.get(4)?,
                started_at: row.get(5)?,
                duration_ms: row.get(6)?,
                outcome: parse(&row.get::<_, String>(7)?)?,
                input_tokens: row.get(8)?,
                output_tokens: row.get(9)?,
                cache_read: row.get(10)?,
                cache_write: row.get(11)?,
                cost_usd: row.get(12)?,
                utilization: row.get(13)?,
                error: row.get(14)?,
                model: row.get(15)?,
                effort: row.get(16)?,
                trigger: trigger.map(|trigger| parse(&trigger)).transpose()?,
                trigger_segment_id: row.get(18)?,
                window_segments: list(19)?,
                findings_in_prompt: list(20)?,
                queries: json(21)?,
                raw_reply: row.get(22)?,
                reply: json(23)?,
                parts: Vec::new(),
                candidates: Vec::new(),
            })
        },
    )?;
    if !agent_call_sent(connection, &event)? {
        return Ok(());
    }
    event.parts = connection
        .prepare("SELECT label, hash FROM agent_call_parts WHERE agent_call_id = ?1 ORDER BY ord")?
        .query_map([call_id], |row| {
            Ok(PromptPartRef {
                label: row.get(0)?,
                hash: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    event.candidates = connection
        .prepare(
            "SELECT label, rank, chunk_key, source_kind, source_name, source_url, heading_path,
                    coalesce(text, '')
               FROM slow_loop_candidates WHERE agent_call_id = ?1 ORDER BY rank",
        )?
        .query_map([call_id], |row| {
            Ok(contract::Candidate {
                label: row.get(0)?,
                rank: row.get(1)?,
                chunk_key: row.get(2)?,
                source_kind: parse(&row.get::<_, String>(3)?)?,
                source_name: row.get(4)?,
                source_url: row.get(5)?,
                heading_path: row.get(6)?,
                text: row.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    let at = event.started_at;
    for hash in new_parts {
        let text: Option<String> = connection.query_row(
            "SELECT text FROM prompt_parts WHERE hash = ?1",
            [hash],
            |row| row.get(0),
        )?;
        let text = text.ok_or_else(|| CommandError::invalid("Текст части промпта уже стёрт"))?;
        enqueue(
            connection,
            Event::PromptPart(PromptPartEvent {
                hash: hash.clone(),
                text,
            }),
            at,
        )?;
    }
    let ops: Vec<AgentCallOpEvent> = connection
        .prepare(
            "SELECT agent_call_id, idx, op, body, applied, reason, subject_kind, subject_id
               FROM agent_call_ops WHERE agent_call_id = ?1 ORDER BY idx",
        )?
        .query_map([call_id], |row| {
            let Json(body) = row.get(3)?;
            let reason: Option<Json> = row.get(5)?;
            let subject_kind: Option<String> = row.get(6)?;
            Ok(AgentCallOpEvent {
                agent_call_id: row.get(0)?,
                idx: row.get(1)?,
                op: row.get(2)?,
                body,
                applied: row.get(4)?,
                reason: reason.map(|Json(value)| value),
                subject_kind: subject_kind.map(|kind| parse(&kind)).transpose()?,
                subject_id: row.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    enqueue(connection, Event::AgentCall(Box::new(event)), at)?;
    for op in ops {
        enqueue(connection, Event::AgentCallOp(op), at)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
