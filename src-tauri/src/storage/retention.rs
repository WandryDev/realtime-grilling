//! The retention periods of «Приватность» (settings-real design.md,
//! decision 5): the audio of a call older than `audioRetention` goes as with
//! «Удалить запись» (the transcript and the summary stay), the transcript of
//! a call older than `transcriptRetention` goes too (the summary, cards and
//! questions stay; `transcript_deleted_at` says so).
//!
//! A recording's age is its call's end, for a recording without a call its
//! own end. A recording being written, or of a call that is not finished, is
//! never touched. [`purge_at`] is the database part, in one transaction;
//! [`run`] adds the files and the event, and runs 30 s after the start and
//! then once a day ([`schedule`]).

use std::{collections::BTreeSet, sync::Arc, time::Duration};

use rusqlite::{Connection, params};

use super::{Storage, now_ms, recordings, settings};
use crate::{
    error::CommandResult,
    events::{Change, DataChanged, Entity, EventSink},
    recording::store::RecordingStore,
};

/// The first pass after the app started: the windows open first.
pub const FIRST_AFTER: Duration = Duration::from_secs(30);
/// Then once a day.
pub const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// What a pass deleted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Purged {
    /// Recordings whose audio was marked deleted: their files go next.
    pub audio: Vec<String>,
    /// Recordings whose transcript was deleted.
    pub transcripts: Vec<String>,
}

impl Purged {
    pub const fn is_empty(&self) -> bool {
        self.audio.is_empty() && self.transcripts.is_empty()
    }
}

/// When a recording ended for the retention: its call's end once the call
/// is finished; its own end without a call; never while it is written.
const AGE: &str = "CASE
       WHEN r.status = 'recording' THEN NULL
       WHEN r.call_id IS NULL THEN r.ended_at
       ELSE (SELECT c.ended_at FROM calls c WHERE c.id = r.call_id AND c.status = 'finished')
     END";

/// Recordings older than `cutoff` that still have `column` empty.
fn older_than(connection: &Connection, column: &str, cutoff: i64) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(&format!(
        "SELECT r.id FROM recordings r
          WHERE r.{column} IS NULL AND ({AGE}) < ?1
          ORDER BY r.id"
    ))?;
    let rows = statement.query_map([cutoff], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The recordings a pass at `now` would take the audio of (to stop their
/// second pass first).
pub fn audio_due(connection: &Connection, now: i64) -> CommandResult<Vec<String>> {
    let settings = settings::get(connection)?;
    match settings::audio_retention_days(&settings) {
        Some(days) => older_than(connection, "audio_deleted_at", now - days * DAY_MS),
        None => Ok(Vec::new()),
    }
}

/// The database part of a pass at `now` by the stored retention periods:
/// marks the audio deleted (as «Удалить запись») and deletes the
/// transcripts that are due. One `DataChanged` per call it touched (a call's
/// pages re-read on their own call's event; a recording without a call
/// sends its own id), `projectId` `null` so every window re-reads its
/// calls too. Run it in one transaction; delete the audio files after the
/// commit.
pub fn purge_at(connection: &Connection, now: i64) -> CommandResult<(Purged, Vec<DataChanged>)> {
    let settings = settings::get(connection)?;
    let mut purged = Purged::default();
    if let Some(days) = settings::audio_retention_days(&settings) {
        for id in older_than(connection, "audio_deleted_at", now - days * DAY_MS)? {
            recordings::mark_audio_deleted(connection, &id, now)?;
            purged.audio.push(id);
        }
    }
    if let Some(days) = settings::transcript_retention_days(&settings) {
        for id in older_than(connection, "transcript_deleted_at", now - days * DAY_MS)? {
            connection.execute(
                "DELETE FROM transcript_segments WHERE recording_id = ?1",
                [&id],
            )?;
            // No second pass will write it again.
            connection.execute(
                "UPDATE recordings
                    SET transcript_deleted_at = ?2, updated_at = ?3,
                        transcript_state = CASE WHEN transcript_state IN ('live', 'refining')
                                                THEN 'failed' ELSE transcript_state END
                  WHERE id = ?1",
                params![id, now, now_ms()],
            )?;
            purged.transcripts.push(id);
        }
    }
    let mut touched = BTreeSet::new();
    for id in purged.audio.iter().chain(&purged.transcripts) {
        let call: Option<String> = connection.query_row(
            "SELECT call_id FROM recordings WHERE id = ?1",
            [id],
            |row| row.get(0),
        )?;
        touched.insert(call.unwrap_or_else(|| id.clone()));
    }
    let events = touched
        .iter()
        .map(|id| DataChanged::new(Entity::Call, id, None, Change::Updated))
        .collect();
    Ok((purged, events))
}

/// What a pass needs besides the database.
pub struct PassHost<'a> {
    pub store: Option<Arc<dyn RecordingStore>>,
    /// Stops the second pass of a recording (the app's refiner).
    pub stop_refining: &'a (dyn Fn(&str) + Send + Sync),
    /// Drops a recording's decoded audio (the player's cache).
    pub forget_audio: &'a (dyn Fn(&str) + Send + Sync),
}

/// One pass at `now`: the second passes of the audio due stop, the
/// database is purged (its event goes out after the commit), then the audio
/// files are deleted. A file that can't be removed is logged; the sweep at
/// the next start removes it.
pub async fn run(
    storage: &Storage,
    sink: &impl EventSink,
    host: &PassHost<'_>,
    now: i64,
) -> CommandResult<Purged> {
    for id in storage.read(move |db| audio_due(db, now)).await? {
        (host.stop_refining)(&id);
    }
    let purged = storage.write(sink, move |db| purge_at(db, now)).await?;
    for id in &purged.audio {
        if let Some(store) = host.store.clone() {
            let id = id.clone();
            let removed = tauri::async_runtime::spawn_blocking(move || store.delete(&id)).await;
            if let Ok(Err(error)) | Err(error) = removed.map_err(std::io::Error::other) {
                eprintln!("grill: retention could not remove the files of a recording: {error}");
            }
        }
        (host.forget_audio)(id);
    }
    for id in &purged.transcripts {
        (host.stop_refining)(id);
    }
    Ok(purged)
}

#[cfg(test)]
mod tests;
