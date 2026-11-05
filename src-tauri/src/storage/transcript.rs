//! Transcript segments of the recordings (speech-recognition design.md,
//! decisions 11 and 13).
//!
//! Only the backend writes them: the live pass appends a segment per phrase
//! while recording, the second pass replaces its own segments at once. A
//! read returns the refined pass of a recording when it has one, else the
//! live pass.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{
    calls, new_id, now_ms,
    recordings::{self, TranscriptState},
};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

/// Whose audio a segment came from. Anything else is rejected while the
/// command arguments are read, and by a CHECK in the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptChannel {
    /// The manager's microphone.
    Me,
    /// System audio: everyone else on the call.
    Others,
}

impl TranscriptChannel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Me => "me",
            Self::Others => "others",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "me" => Ok(Self::Me),
            "others" => Ok(Self::Others),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                COLUMN_CHANNEL,
                rusqlite::types::Type::Text,
                format!("unknown channel {other}").into(),
            )),
        }
    }
}

/// Which recognition pass wrote a segment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptPass {
    /// While recording, phrase by phrase.
    Live,
    /// After the recording, over the whole files.
    Refined,
}

impl TranscriptPass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Refined => "refined",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "live" => Ok(Self::Live),
            "refined" => Ok(Self::Refined),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                COLUMN_PASS,
                rusqlite::types::Type::Text,
                format!("unknown transcript pass {other}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub recording_id: String,
    /// The recording's call when the segment was written.
    pub call_id: Option<String>,
    pub pass: TranscriptPass,
    pub channel: TranscriptChannel,
    /// Offset from the start of the recording.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A recognized phrase to store.
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SegmentInput {
    pub channel: TranscriptChannel,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

const COLUMN_PASS: usize = 3;
const COLUMN_CHANNEL: usize = 4;

pub(super) const COLUMNS: &str =
    "s.id, s.recording_id, s.call_id, s.pass, s.channel, s.start_ms, s.end_ms,
       s.text, s.created_at, s.updated_at";

/// The pass a read returns for the recording `s.recording_id`.
pub(super) const SHOWN_PASS: &str = "s.pass = CASE WHEN EXISTS (
         SELECT 1 FROM transcript_segments AS r
          WHERE r.recording_id = s.recording_id AND r.pass = 'refined'
       ) THEN 'refined' ELSE 'live' END";

pub(super) fn from_row(row: &Row) -> rusqlite::Result<TranscriptSegment> {
    let pass: String = row.get(COLUMN_PASS)?;
    let channel: String = row.get(COLUMN_CHANNEL)?;
    Ok(TranscriptSegment {
        id: row.get(0)?,
        recording_id: row.get(1)?,
        call_id: row.get(2)?,
        pass: TranscriptPass::parse(&pass)?,
        channel: TranscriptChannel::parse(&channel)?,
        start_ms: row.get(5)?,
        end_ms: row.get(6)?,
        text: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// The recording's call and project. `NotFound` for an unknown id.
fn links_of(
    connection: &Connection,
    recording_id: &str,
) -> CommandResult<(Option<String>, Option<String>)> {
    connection
        .query_row(
            "SELECT call_id, project_id FROM recordings WHERE id = ?1",
            [recording_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| recordings::not_found(recording_id))
}

fn check_times(segment: &SegmentInput) -> CommandResult<()> {
    if segment.start_ms < 0 || segment.end_ms < segment.start_ms {
        return Err(CommandError::invalid(format!(
            "Неверное время сегмента: {}–{} мс",
            segment.start_ms, segment.end_ms
        )));
    }
    Ok(())
}

/// One `transcript` event about the recording.
fn changed(recording_id: &str, project_id: Option<&str>, change: Change) -> DataChanged {
    DataChanged::new(Entity::Transcript, recording_id, project_id, change)
}

fn insert(
    connection: &Connection,
    recording_id: &str,
    call_id: Option<&str>,
    pass: TranscriptPass,
    segment: SegmentInput,
    now: i64,
) -> CommandResult<TranscriptSegment> {
    let id = new_id();
    connection.execute(
        "INSERT INTO transcript_segments
           (id, recording_id, call_id, pass, channel, start_ms, end_ms, text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            recording_id,
            call_id,
            pass.as_str(),
            segment.channel.as_str(),
            segment.start_ms,
            segment.end_ms,
            segment.text,
            now
        ],
    )?;
    Ok(TranscriptSegment {
        id,
        recording_id: recording_id.to_owned(),
        call_id: call_id.map(str::to_owned),
        pass,
        channel: segment.channel,
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
        text: segment.text,
        created_at: now,
        updated_at: now,
    })
}

/// Stores a phrase of the live pass (new UUID v7, the recording's call).
/// `NotFound` for an unknown recording, `Invalid` for a bad time.
pub fn append_live(
    connection: &Connection,
    recording_id: &str,
    segment: SegmentInput,
) -> CommandResult<(TranscriptSegment, Vec<DataChanged>)> {
    let (call_id, project_id) = links_of(connection, recording_id)?;
    check_times(&segment)?;
    let added = insert(
        connection,
        recording_id,
        call_id.as_deref(),
        TranscriptPass::Live,
        segment,
        now_ms(),
    )?;
    let event = changed(recording_id, project_id.as_deref(), Change::Created);
    Ok((added, vec![event]))
}

/// Stores the second pass of a recording in one transaction: its previous
/// refined segments go, the live ones stay, and the recording's transcript
/// state becomes `refined`. From then on reads return these segments; with
/// none (nothing recognized) they keep returning the live pass. `NotFound`
/// for an unknown recording,
/// `Invalid` for a bad time; either leaves everything as it was.
///
/// Runs in a savepoint, so it is atomic inside or outside a transaction.
pub fn replace_refined(
    connection: &Connection,
    recording_id: &str,
    segments: Vec<SegmentInput>,
) -> CommandResult<(Vec<TranscriptSegment>, Vec<DataChanged>)> {
    let (call_id, project_id) = links_of(connection, recording_id)?;
    for segment in &segments {
        check_times(segment)?;
    }
    let added = in_savepoint(connection, || {
        connection.execute(
            "DELETE FROM transcript_segments WHERE recording_id = ?1 AND pass = 'refined'",
            [recording_id],
        )?;
        let now = now_ms();
        let added = segments
            .into_iter()
            .map(|segment| {
                insert(
                    connection,
                    recording_id,
                    call_id.as_deref(),
                    TranscriptPass::Refined,
                    segment,
                    now,
                )
            })
            .collect::<CommandResult<Vec<_>>>()?;
        recordings::set_transcript_state(connection, recording_id, TranscriptState::Refined)?;
        Ok(added)
    })?;
    let event = changed(recording_id, project_id.as_deref(), Change::Updated);
    Ok((added, vec![event]))
}

fn in_savepoint<T>(
    connection: &Connection,
    work: impl FnOnce() -> CommandResult<T>,
) -> CommandResult<T> {
    connection.execute_batch("SAVEPOINT replace_refined")?;
    match work() {
        Ok(value) => {
            connection.execute_batch("RELEASE replace_refined")?;
            Ok(value)
        }
        Err(error) => {
            if let Err(rollback) =
                connection.execute_batch("ROLLBACK TO replace_refined; RELEASE replace_refined")
            {
                eprintln!("grill: could not roll back the refined transcript: {rollback}");
            }
            Err(error)
        }
    }
}

/// The transcript of a recording, both channels in time order: the refined
/// pass if it has one, else the live pass. `NotFound` for an unknown
/// recording.
pub fn for_recording(
    connection: &Connection,
    recording_id: &str,
) -> CommandResult<Vec<TranscriptSegment>> {
    links_of(connection, recording_id)?;
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM transcript_segments AS s
          WHERE s.recording_id = ?1 AND {SHOWN_PASS}
          ORDER BY s.start_ms, s.end_ms, s.id"
    ))?;
    let rows = statement.query_map([recording_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The transcripts of a call's recordings (as [`for_recording`]), recording
/// after recording in the order they started. `NotFound` for an unknown
/// call.
pub fn for_call(connection: &Connection, call_id: &str) -> CommandResult<Vec<TranscriptSegment>> {
    calls::project_of(connection, call_id)?;
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS} FROM transcript_segments AS s
           JOIN recordings AS rec ON rec.id = s.recording_id
          WHERE rec.call_id = ?1 AND {SHOWN_PASS}
          ORDER BY rec.started_at, rec.id, s.start_ms, s.end_ms, s.id"
    ))?;
    let rows = statement.query_map([call_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The shown pass of every recording of every call, by call, each in the
/// order of [`for_call`]: the search reads them in one query.
pub fn shown_by_call(
    connection: &Connection,
) -> CommandResult<HashMap<String, Vec<TranscriptSegment>>> {
    let mut statement = connection.prepare(&format!(
        "SELECT {COLUMNS}, rec.call_id FROM transcript_segments AS s
           JOIN recordings AS rec ON rec.id = s.recording_id
          WHERE rec.call_id IS NOT NULL AND {SHOWN_PASS}
          ORDER BY rec.call_id, rec.started_at, rec.id, s.start_ms, s.end_ms, s.id"
    ))?;
    let rows = statement.query_map([], |row| Ok((row.get::<_, String>(10)?, from_row(row)?)))?;
    let mut by_call: HashMap<String, Vec<TranscriptSegment>> = HashMap::new();
    for row in rows {
        let (call_id, segment) = row?;
        by_call.entry(call_id).or_default().push(segment);
    }
    Ok(by_call)
}
