use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{calls, new_id, now_ms};
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
                2,
                rusqlite::types::Type::Text,
                format!("unknown channel {other}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub id: String,
    pub call_id: String,
    pub channel: TranscriptChannel,
    /// Offset from the start of the recording.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SegmentInput {
    pub channel: TranscriptChannel,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

fn from_row(row: &Row) -> rusqlite::Result<TranscriptSegment> {
    let channel: String = row.get(2)?;
    Ok(TranscriptSegment {
        id: row.get(0)?,
        call_id: row.get(1)?,
        channel: TranscriptChannel::parse(&channel)?,
        start_ms: row.get(3)?,
        end_ms: row.get(4)?,
        text: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

/// Segments of both channels in time order.
pub fn list(connection: &Connection, call_id: &str) -> CommandResult<Vec<TranscriptSegment>> {
    calls::project_of(connection, call_id)?;
    let mut statement = connection.prepare(
        "SELECT id, call_id, channel, start_ms, end_ms, text, created_at, updated_at
           FROM transcript_segments WHERE call_id = ?1 ORDER BY start_ms, end_ms, id",
    )?;
    let rows = statement.query_map([call_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Adds a batch of segments in one transaction with one `transcript` event.
/// An empty batch changes nothing and sends nothing.
pub fn append(
    connection: &Connection,
    call_id: &str,
    segments: Vec<SegmentInput>,
) -> CommandResult<(Vec<TranscriptSegment>, Vec<DataChanged>)> {
    let project_id = calls::project_of(connection, call_id)?;
    for segment in &segments {
        if segment.start_ms < 0 || segment.end_ms < segment.start_ms {
            return Err(CommandError::invalid(format!(
                "Неверное время сегмента: {}–{} мс",
                segment.start_ms, segment.end_ms
            )));
        }
    }
    if segments.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let now = now_ms();
    let mut statement = connection.prepare(
        "INSERT INTO transcript_segments
           (id, call_id, channel, start_ms, end_ms, text, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
    )?;
    let mut added = Vec::with_capacity(segments.len());
    for segment in segments {
        let id = new_id();
        statement.execute(params![
            id,
            call_id,
            segment.channel.as_str(),
            segment.start_ms,
            segment.end_ms,
            segment.text,
            now
        ])?;
        added.push(TranscriptSegment {
            id,
            call_id: call_id.to_owned(),
            channel: segment.channel,
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: segment.text,
            created_at: now,
            updated_at: now,
        });
    }
    let event = DataChanged::new(
        Entity::Transcript,
        call_id,
        Some(&project_id),
        Change::Created,
    );
    Ok((added, vec![event]))
}
