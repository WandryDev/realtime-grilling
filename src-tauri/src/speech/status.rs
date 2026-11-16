//! Whether the live pass of the running recording recognizes
//! (speech-recognition design.md decision 10): `RecordingStatus.transcription`.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::models::ModelId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptionState {
    Ok,
    /// The selected model is not installed: recording goes on without text.
    NoModel,
    /// The selected model is installed but whisper.cpp did not load it.
    ModelFailed,
    /// No phrases come out of segmentation, so there is nothing to recognize.
    SegmentationUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionStatus {
    pub state: TranscriptionState,
    /// The model the live pass runs (or failed to run) with.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelId>,
}

impl TranscriptionStatus {
    /// Nothing is recorded, or nothing is known yet.
    pub const fn idle() -> Self {
        Self {
            state: TranscriptionState::Ok,
            model: None,
        }
    }

    pub const fn new(state: TranscriptionState, model: Option<ModelId>) -> Self {
        Self { state, model }
    }
}
