//! What the windows learn about the transcript (speech-recognition
//! design.md decisions 10 and 12). Every event goes to every window; times
//! are milliseconds from the start of the recording.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime};
use tauri_specta::Event;

use crate::storage::transcript::{TranscriptChannel, TranscriptPass};

/// A phrase went to recognition: "расшифровываю" in its place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPending {
    pub recording_id: String,
    pub channel: TranscriptChannel,
    pub start_ms: u64,
}

/// A phrase is recognized and stored; replaces its `TranscriptPending`
/// (same channel and `startMs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPhrase {
    pub recording_id: String,
    /// The stored segment.
    pub id: String,
    pub channel: TranscriptChannel,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub pass: TranscriptPass,
}

/// The phrase had no text after the filters (or recognition failed): its
/// `TranscriptPending` goes away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDropped {
    pub recording_id: String,
    pub channel: TranscriptChannel,
    pub start_ms: u64,
}

/// The live queue holds more than 10 s of audio: sent every 5 s while it
/// does; `seconds: 0` once it no longer does.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptLag {
    pub recording_id: String,
    pub seconds: u32,
}

/// The live pass gave up on a phrase (over 60 s behind); its
/// `TranscriptPending` becomes "пропущено", the second pass fills it in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSkipped {
    pub recording_id: String,
    pub channel: TranscriptChannel,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RefineState {
    Refining,
    /// The refined transcript is stored: `transcript_for_recording` returns it.
    Done,
    /// The live transcript stays.
    Failed,
}

/// The second pass over a recording: at most once a second while it runs,
/// then `done` or `failed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptRefine {
    pub recording_id: String,
    /// 0–100: the share of the recording's speech processed.
    pub progress: u8,
    pub state: RefineState,
}

/// Any of the transcript events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TranscriptEvent {
    Pending(TranscriptPending),
    Phrase(TranscriptPhrase),
    Dropped(TranscriptDropped),
    Lag(TranscriptLag),
    Skipped(TranscriptSkipped),
    Refine(TranscriptRefine),
}

impl TranscriptEvent {
    /// To every window.
    pub fn emit<R: Runtime>(&self, app: &AppHandle<R>) {
        let result = match self {
            Self::Pending(event) => event.emit(app),
            Self::Phrase(event) => event.emit(app),
            Self::Dropped(event) => event.emit(app),
            Self::Lag(event) => event.emit(app),
            Self::Skipped(event) => event.emit(app),
            Self::Refine(event) => event.emit(app),
        };
        if let Err(error) = result {
            eprintln!("grill: failed to emit a transcript event: {error}");
        }
    }
}
