//! The findings of the slow loop by recording (agent-slow-loop design.md,
//! decisions 4–5): quotes of the project's sources that the agent picked
//! during the call, with a snapshot of their source.
//!
//! At most [`MAX_VISIBLE`] are visible in a recording: a new one evicts the
//! oldest that no question is about or cites; when every visible one is,
//! the new one is not added. The manager hides one with
//! `context_finding_hide`. Hidden and evicted findings stay for the repeat
//! check and the records. Nothing here sends events: the caller sends
//! `CallStateChanged` once the transaction committed.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{
    analytics,
    call_state::in_savepoint,
    journal::{self, FindingEventKind},
    new_id, now_ms,
};
use crate::error::{CommandError, CommandResult};

/// Visible findings of a recording at most.
pub const MAX_VISIBLE: usize = 12;

/// What a finding's source is: a project's file, an Outline document or a
/// ClickUp task.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FindingSourceKind {
    File,
    Outline,
    #[serde(rename = "clickup")]
    ClickUp,
}

impl FindingSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Outline => "outline",
            Self::ClickUp => "clickup",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [Self::File, Self::Outline, Self::ClickUp]
            .into_iter()
            .find(|kind| kind.as_str() == text)
    }

    /// The name people know, for the agent's messages.
    pub fn label(self) -> &'static str {
        match self {
            Self::File => "Файл",
            Self::Outline => "Outline",
            Self::ClickUp => "ClickUp",
        }
    }
}

/// A visible finding, as the windows show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextFinding {
    pub id: String,
    pub source_kind: FindingSourceKind,
    /// The document's, task's or file's name when it was found.
    pub source_name: String,
    /// The document or task in its service; absent for a file.
    #[specta(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// In the source's own spelling.
    pub quote: String,
    /// One line: what it confirms, adds or contradicts.
    pub note: String,
    /// The question it is about, or the first new question that cited it.
    #[specta(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
    /// Milliseconds since the Unix epoch, UTC.
    pub created_at: i64,
}

/// The slow loop's search of a recording while its live pass runs: whether
/// a call runs, and the agent's queries it searches with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextSearch {
    pub running: bool,
    pub queries: Vec<String>,
}

/// How many ready sources of each kind the recording's project has: what
/// the slow loop searches.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextSources {
    pub files: u32,
    pub outline: u32,
    pub clickup: u32,
}

/// A finding to insert.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFinding {
    pub source_id: Option<String>,
    pub source_kind: FindingSourceKind,
    pub source_name: String,
    pub source_url: Option<String>,
    pub chunk_key: String,
    pub quote: String,
    pub note: String,
    pub question_id: Option<String>,
    pub agent_call_id: Option<String>,
}

/// What [`insert_at`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inserted {
    /// Added; `evicted` is the finding it took the place of.
    Added { id: String, evicted: Option<String> },
    /// [`MAX_VISIBLE`] are visible and each is about a question or cited by
    /// one: nothing changed.
    NoRoom,
}

/// A finding of the recording in any state, for the repeat check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownFinding {
    pub id: String,
    pub chunk_key: String,
    pub quote: String,
}

const SELECT: &str = "SELECT id, source_kind, source_name, source_url, quote, note, question_id,
       created_at
  FROM context_findings";

fn from_row(row: &Row) -> rusqlite::Result<ContextFinding> {
    let kind: String = row.get(1)?;
    Ok(ContextFinding {
        id: row.get(0)?,
        source_kind: FindingSourceKind::parse(&kind).ok_or_else(|| {
            super::call_state::conversion(format!("unknown finding source {kind}"))
        })?,
        source_name: row.get(2)?,
        source_url: row.get(3)?,
        quote: row.get(4)?,
        note: row.get(5)?,
        question_id: row.get(6)?,
        created_at: row.get(7)?,
    })
}

/// The visible findings of a recording, the newest first.
pub fn visible(connection: &Connection, recording_id: &str) -> CommandResult<Vec<ContextFinding>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE recording_id = ?1 AND hidden_at IS NULL AND evicted_at IS NULL
          ORDER BY created_at DESC, id DESC"
    ))?;
    let rows = statement.query_map([recording_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every finding of a recording, hidden and evicted ones too, oldest first.
pub fn known(connection: &Connection, recording_id: &str) -> CommandResult<Vec<KnownFinding>> {
    let mut statement = connection.prepare(
        "SELECT id, chunk_key, quote FROM context_findings
          WHERE recording_id = ?1 ORDER BY created_at, id",
    )?;
    let rows = statement.query_map([recording_id], |row| {
        Ok(KnownFinding {
            id: row.get(0)?,
            chunk_key: row.get(1)?,
            quote: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The visible finding of the recording that may give its place: the oldest
/// that is about no question and that no question of the recording cites.
/// A finding of the same call (added at `now`) never gives its place to
/// the next one of that call.
fn evictable(
    connection: &Connection,
    recording_id: &str,
    now: i64,
) -> CommandResult<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT f.id FROM context_findings f
              WHERE f.recording_id = ?1 AND f.hidden_at IS NULL AND f.evicted_at IS NULL
                AND f.question_id IS NULL
                AND f.created_at < ?2
                AND NOT EXISTS (
                  SELECT 1 FROM questions q, json_each(q.evidence) e
                   WHERE q.recording_id = f.recording_id
                     AND json_extract(e.value, '$.source') = 'document'
                     AND json_extract(e.value, '$.id') = f.id)
                AND NOT EXISTS (
                  SELECT 1 FROM questions q, json_each(q.answer_evidence) e
                   WHERE q.recording_id = f.recording_id
                     AND json_extract(e.value, '$.source') = 'document'
                     AND json_extract(e.value, '$.id') = f.id)
              ORDER BY f.created_at, f.id
              LIMIT 1",
            params![recording_id, now],
            |row| row.get(0),
        )
        .optional()?)
}

/// Inserts a finding at `now` (Unix ms): over [`MAX_VISIBLE`] the oldest
/// evictable one gives its place, and without one nothing is added.
pub fn insert_at(
    connection: &Connection,
    recording_id: &str,
    new: &NewFinding,
    now: i64,
) -> CommandResult<Inserted> {
    in_savepoint(connection, || {
        let shown: i64 = connection.query_row(
            "SELECT count(*) FROM context_findings
              WHERE recording_id = ?1 AND hidden_at IS NULL AND evicted_at IS NULL",
            [recording_id],
            |row| row.get(0),
        )?;
        let mut evicted = None;
        if usize::try_from(shown).unwrap_or(usize::MAX) >= MAX_VISIBLE {
            let Some(oldest) = evictable(connection, recording_id, now)? else {
                return Ok(Inserted::NoRoom);
            };
            connection.execute(
                "UPDATE context_findings SET evicted_at = ?2 WHERE id = ?1",
                params![oldest, now],
            )?;
            journal::finding_event(connection, &oldest, FindingEventKind::Evicted, now)?;
            evicted = Some(oldest);
        }
        let id = new_id();
        connection.execute(
            "INSERT INTO context_findings
               (id, recording_id, source_id, source_kind, source_name, source_url, chunk_key,
                quote, note, question_id, agent_call_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                recording_id,
                new.source_id,
                new.source_kind.as_str(),
                new.source_name,
                new.source_url,
                new.chunk_key,
                new.quote,
                new.note,
                new.question_id,
                new.agent_call_id,
                now
            ],
        )?;
        journal::finding_event(connection, &id, FindingEventKind::Shown, now)?;
        Ok(Inserted::Added { id, evicted })
    })
}

/// «Убрать»: the finding is no longer shown nor given to the agent; the
/// questions that cite it stay. Hiding it again changes nothing. `NotFound`
/// when the recording has no such finding.
pub fn hide(
    connection: &Connection,
    recording_id: &str,
    finding_id: &str,
    now: i64,
) -> CommandResult<()> {
    let found: Option<Option<i64>> = connection
        .query_row(
            "SELECT hidden_at FROM context_findings WHERE id = ?1 AND recording_id = ?2",
            params![finding_id, recording_id],
            |row| row.get(0),
        )
        .optional()?;
    match found {
        None => Err(CommandError::not_found(format!(
            "Находка {finding_id} не найдена"
        ))),
        Some(Some(_)) => Ok(()),
        Some(None) => in_savepoint(connection, || {
            connection.execute(
                "UPDATE context_findings SET hidden_at = ?2 WHERE id = ?1",
                params![finding_id, now],
            )?;
            journal::finding_event(connection, finding_id, FindingEventKind::Hidden, now)?;
            Ok(())
        }),
    }
}

/// The call that found it, once the call is recorded.
pub fn attach_call(
    connection: &Connection,
    finding_id: &str,
    agent_call_id: &str,
) -> CommandResult<()> {
    connection.execute(
        "UPDATE context_findings SET agent_call_id = ?2 WHERE id = ?1",
        params![finding_id, agent_call_id],
    )?;
    analytics::finding(connection, finding_id, now_ms())?;
    Ok(())
}

/// A new question cited the finding: it is now about that question, unless
/// it already was about one.
pub fn link_question(
    connection: &Connection,
    recording_id: &str,
    finding_id: &str,
    question_id: &str,
) -> CommandResult<()> {
    let linked = connection.execute(
        "UPDATE context_findings SET question_id = ?3
          WHERE id = ?1 AND recording_id = ?2 AND question_id IS NULL",
        params![finding_id, recording_id, question_id],
    )?;
    if linked > 0 {
        analytics::finding(connection, finding_id, now_ms())?;
    }
    Ok(())
}

/// The ready sources the slow loop searches for the recording's project:
/// files, Outline documents and ClickUp tasks. None without a project.
pub fn source_counts(connection: &Connection, recording_id: &str) -> CommandResult<ContextSources> {
    let mut statement = connection.prepare(
        "SELECT coalesce(s.connector, 'file'), count(*)
           FROM recordings r JOIN project_sources s ON s.project_id = r.project_id
          WHERE r.id = ?1 AND s.status = 'ready'
          GROUP BY coalesce(s.connector, 'file')",
    )?;
    let rows = statement.query_map([recording_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = ContextSources::default();
    for row in rows {
        let (kind, count) = row?;
        let count = u32::try_from(count).unwrap_or(u32::MAX);
        match FindingSourceKind::parse(&kind) {
            Some(FindingSourceKind::File) => counts.files = count,
            Some(FindingSourceKind::Outline) => counts.outline = count,
            Some(FindingSourceKind::ClickUp) => counts.clickup = count,
            // GitHub is not searched.
            None => {}
        }
    }
    Ok(counts)
}

#[cfg(test)]
mod tests;
