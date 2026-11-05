//! The `transcript` stage (design.md, decision 2): wait for the second pass
//! of every recording of the call, then read the transcript the summary is
//! built from.
//!
//! A recording is settled when its pass is over (`refined`, `failed`,
//! `skipped`) or its audio is deleted (no pass runs without it). The wait
//! ends when every recording is settled, or after [`REFINE_SILENCE`]
//! without news of the pass about any recording of the call: no model, an
//! older recording first, a long file decoding. The recordings still
//! waiting then go with their live transcript.
//!
//! [`REFINE_SILENCE`]: super::REFINE_SILENCE

use std::{collections::HashSet, future::Future, time::Duration};

use rusqlite::Connection;
use tokio::{sync::broadcast, time::Instant};

use crate::{
    error::CommandResult,
    speech::events::TranscriptRefine,
    storage::{
        calls,
        recordings::{self, Recording, TranscriptState},
        summaries::SummaryTranscriptPass,
        transcript::{self, TranscriptPass, TranscriptSegment},
    },
};

/// Whether nothing more is to come from the second pass of `recording`.
pub fn settled(recording: &Recording) -> bool {
    recording.audio_deleted_at.is_some()
        || !matches!(
            recording.transcript_state,
            TranscriptState::Live | TranscriptState::Refining
        )
}

/// The recordings of a call, in the order they started. `NotFound` for an
/// unknown call.
pub fn recordings_of(connection: &Connection, call_id: &str) -> CommandResult<Vec<Recording>> {
    calls::project_of(connection, call_id)?;
    let mut statement = connection
        .prepare("SELECT id FROM recordings WHERE call_id = ?1 ORDER BY started_at, id")?;
    let ids = statement
        .query_map([call_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.iter()
        .map(|id| recordings::get(connection, id))
        .collect()
}

/// How the wait ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waited {
    /// Every recording is settled.
    Settled,
    /// No news for the silence: the rest goes live.
    Silence,
}

/// Waits until `read` gives only settled recordings, or `silence` passes
/// without news in `news` about one of them. `read` is called first and
/// again after each news of the call's recordings; subscribe to `news`
/// before calling, so nothing sent meanwhile is missed.
pub async fn wait_for_passes<F, Fut>(
    mut read: F,
    news: &mut broadcast::Receiver<TranscriptRefine>,
    silence: Duration,
) -> CommandResult<Waited>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = CommandResult<Vec<Recording>>>,
{
    let mut last_news = Instant::now();
    let mut open = true;
    loop {
        let recordings = read().await?;
        if recordings.iter().all(settled) {
            return Ok(Waited::Settled);
        }
        let ours: HashSet<String> = recordings
            .into_iter()
            .map(|recording| recording.id)
            .collect();
        // Until news of one of them, or the silence.
        loop {
            let deadline = last_news + silence;
            if !open {
                tokio::time::sleep_until(deadline).await;
                return Ok(Waited::Silence);
            }
            tokio::select! {
                () = tokio::time::sleep_until(deadline) => return Ok(Waited::Silence),
                received = news.recv() => match received {
                    Ok(event) if ours.contains(&event.recording_id) => {
                        last_news = Instant::now();
                        break;
                    }
                    Ok(_) => {}
                    // Missed some: look again, the silence goes on.
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => open = false,
                },
            }
        }
    }
}

/// A recording with the segments the summary is built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingTranscript {
    pub recording: Recording,
    /// The refined pass if it has one, else the live pass; time order.
    pub segments: Vec<TranscriptSegment>,
}

impl RecordingTranscript {
    fn refined(&self) -> bool {
        self.segments
            .first()
            .is_some_and(|segment| segment.pass == TranscriptPass::Refined)
    }
}

/// The transcript of a call for its summary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallTranscript {
    /// Every recording of the call, in the order they started.
    pub recordings: Vec<RecordingTranscript>,
    /// Over the recordings that have segments.
    pub pass: SummaryTranscriptPass,
}

impl CallTranscript {
    pub fn segment_count(&self) -> usize {
        self.recordings
            .iter()
            .map(|recording| recording.segments.len())
            .sum()
    }
}

/// Reads the call's transcript now: per recording the refined pass where it
/// is stored, else the live one (also for a pass still running).
pub fn read(connection: &Connection, call_id: &str) -> CommandResult<CallTranscript> {
    let recordings = recordings_of(connection, call_id)?
        .into_iter()
        .map(|recording| {
            let segments = transcript::for_recording(connection, &recording.id)?;
            Ok(RecordingTranscript {
                recording,
                segments,
            })
        })
        .collect::<CommandResult<Vec<_>>>()?;
    let spoken = || {
        recordings
            .iter()
            .filter(|recording| !recording.segments.is_empty())
    };
    let refined = spoken().filter(|recording| recording.refined()).count();
    let pass = if refined == 0 {
        SummaryTranscriptPass::Live
    } else if refined == spoken().count() {
        SummaryTranscriptPass::Refined
    } else {
        SummaryTranscriptPass::Mixed
    };
    Ok(CallTranscript { recordings, pass })
}
