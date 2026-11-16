//! What the windows learn about the recording (audio-capture design.md,
//! decision 14; `specs/call-recording`, "Состояние и уровни записи").

use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::{
    error::CaptureFailure,
    speech::status::{TranscriptionState, TranscriptionStatus},
    vad::worker::SegmentationStatus,
};

/// How a channel of the running recording captures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ChannelState {
    Ok,
    /// The OS denies the access: the channel's file is silence.
    NoAccess,
    /// There is no device to capture from; retried every 500 ms.
    NoDevice,
    /// The device broke or changed; the default one is being opened again
    /// and the file gets silence meanwhile.
    Reconnecting,
    /// System audio gives only zeros for seconds while another app plays
    /// and the OS doesn't tell whether the access is there (macOS).
    SilentUnknownAccess,
}

impl ChannelState {
    /// The state of a channel whose device failed to open for `reason`.
    pub const fn after_failure(reason: Option<CaptureFailure>) -> Self {
        match reason {
            Some(CaptureFailure::NoAccess) => Self::NoAccess,
            Some(CaptureFailure::NoDevice) => Self::NoDevice,
            Some(CaptureFailure::Busy) | None => Self::Reconnecting,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingChannels {
    /// The chosen input, else the default one ("Я").
    pub me: ChannelState,
    /// What the other apps play ("Остальные").
    pub others: ChannelState,
}

/// The recording now. Without `id` nothing is recorded (the channels are
/// `ok` and segmentation `ok` then).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// When the recording started, milliseconds since the Unix epoch.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    pub channels: RecordingChannels,
    /// Whether phrases come out of both channels.
    pub segmentation: SegmentationStatus,
    /// Whether the phrases are recognized (`ok` and no model while idle).
    pub transcription: TranscriptionStatus,
}

impl RecordingStatus {
    pub const fn idle() -> Self {
        Self {
            id: None,
            started_at: None,
            channels: RecordingChannels {
                me: ChannelState::Ok,
                others: ChannelState::Ok,
            },
            segmentation: SegmentationStatus::Ok,
            transcription: TranscriptionStatus::idle(),
        }
    }

    /// Sets the transcription of the running recording; without
    /// segmentation it stays `segmentationUnavailable` (no phrases come).
    pub fn set_transcription(&mut self, status: TranscriptionStatus) {
        self.transcription = status;
        if self.segmentation == SegmentationStatus::Unavailable {
            self.transcription.state = TranscriptionState::SegmentationUnavailable;
        }
    }
}

/// Sent to every window on every change of [`RecordingStatus`]: start,
/// stop, a channel's state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct RecordingChanged(pub RecordingStatus);

/// The level of both channels (0–1, the meters' dBFS scale), ~10 times a
/// second to every window while recording. "Я" is after AEC.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct RecordingLevels {
    // Always finite, so a plain `number` rather than specta's `number | null`.
    #[specta(type = u32)]
    pub me: f32,
    #[specta(type = u32)]
    pub others: f32,
}

/// Below this a level counts as silence (as the onboarding's check).
pub const SILENT_LEVEL: f32 = 0.02;

/// "Тишина при неизвестном доступе" (`specs/call-recording`, "Доступ при
/// старте"): system audio only gave silence for `after` while another app
/// played. Any sound or the end of playback starts over. The audio-check
/// screens use the same rule (`watchSilence`).
#[derive(Debug, Clone, Copy)]
pub struct SilenceWatch {
    after: Duration,
    since: Option<Duration>,
}

impl SilenceWatch {
    pub const fn new(after: Duration) -> Self {
        Self { after, since: None }
    }

    /// One look at `now` (any monotonic time): whether something plays and
    /// the loudest level since the last look. Returns whether the silence
    /// is suspicious.
    pub fn observe(&mut self, now: Duration, playing: bool, peak: f32) -> bool {
        if !playing || peak > SILENT_LEVEL {
            self.since = None;
            return false;
        }
        let since = *self.since.get_or_insert(now);
        now.saturating_sub(since) >= self.after
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_and_events_serialize_in_camel_case() {
        let status = RecordingStatus {
            id: Some("r1".to_owned()),
            started_at: Some(1_000),
            channels: RecordingChannels {
                me: ChannelState::Reconnecting,
                others: ChannelState::SilentUnknownAccess,
            },
            segmentation: SegmentationStatus::Unavailable,
            transcription: TranscriptionStatus::new(
                TranscriptionState::SegmentationUnavailable,
                Some(crate::speech::models::ModelId::Turbo),
            ),
        };
        assert_eq!(
            serde_json::to_value(RecordingChanged(status)).unwrap(),
            serde_json::json!({
                "id": "r1",
                "startedAt": 1_000,
                "channels": { "me": "reconnecting", "others": "silentUnknownAccess" },
                "segmentation": "unavailable",
                "transcription": { "state": "segmentationUnavailable", "model": "turbo" },
            })
        );
        assert_eq!(
            serde_json::to_value(RecordingStatus::idle()).unwrap(),
            serde_json::json!({
                "channels": { "me": "ok", "others": "ok" },
                "segmentation": "ok",
                "transcription": { "state": "ok" },
            })
        );
        assert_eq!(
            serde_json::to_value(RecordingLevels {
                me: 0.5,
                others: 0.0
            })
            .unwrap(),
            serde_json::json!({ "me": 0.5, "others": 0.0 })
        );
        for (state, text) in [
            (ChannelState::Ok, "ok"),
            (ChannelState::NoAccess, "noAccess"),
            (ChannelState::NoDevice, "noDevice"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), text);
        }
    }

    #[test]
    fn a_failed_open_maps_to_a_state() {
        assert_eq!(
            ChannelState::after_failure(Some(CaptureFailure::NoAccess)),
            ChannelState::NoAccess
        );
        assert_eq!(
            ChannelState::after_failure(Some(CaptureFailure::NoDevice)),
            ChannelState::NoDevice
        );
        assert_eq!(
            ChannelState::after_failure(Some(CaptureFailure::Busy)),
            ChannelState::Reconnecting
        );
        assert_eq!(
            ChannelState::after_failure(None),
            ChannelState::Reconnecting
        );
    }

    #[test]
    fn silence_while_playing_is_suspicious_after_a_while() {
        let second = Duration::from_secs(1);
        let mut watch = SilenceWatch::new(3 * second);
        assert!(!watch.observe(Duration::ZERO, true, 0.0));
        assert!(!watch.observe(2 * second, true, 0.01));
        assert!(watch.observe(3 * second, true, 0.0));
        assert!(watch.observe(4 * second, true, 0.0), "stays");

        // Sound starts over.
        assert!(!watch.observe(5 * second, true, 0.3));
        assert!(!watch.observe(7 * second, true, 0.0));
        assert!(watch.observe(10 * second, true, 0.0));

        // Nothing plays: silence is just silence.
        assert!(!watch.observe(11 * second, false, 0.0));
        assert!(!watch.observe(20 * second, false, 0.0));
        assert!(!watch.observe(21 * second, true, 0.0));
        assert!(!watch.observe(23 * second, true, 0.0));
        assert!(watch.observe(24 * second, true, 0.0));
    }
}
