//! Live input level for the checks before a call (`specs/audio-check`,
//! design.md decisions 12–14). Nothing is recorded or leaves the machine:
//! samples only feed a meter. `mic_watch`: whether another app uses the
//! microphone (`specs/mic-activity`).

pub mod level;
pub mod levels;
#[cfg(target_os = "macos")]
pub mod mac;
pub mod mic_watch;
mod sources;
#[cfg(windows)]
mod win;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::error::CaptureFailure;

pub use levels::AudioLevels;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum AudioSource {
    /// The default input device ("Я").
    Microphone,
    /// What the other apps play ("Остальные"), without this app.
    System,
}

/// The level of a source, ~10 times a second, to the windows that
/// subscribed with `audio_level_start`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevel {
    pub source: AudioSource,
    /// 0–1; 0 is silence (or below −60 dBFS).
    // Always finite, so a plain `number` rather than specta's `number | null`.
    #[specta(type = u32)]
    pub level: f32,
    /// System audio on macOS: whether some app plays to the default output
    /// (`DeviceIsRunningSomewhere`). Silence while something plays and the
    /// access is `unknown` means the access is missing.
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playing: Option<bool>,
}

/// Rust ended a window's subscription to a source, and the window's level
/// stream ends. Without `reason` the window was hidden or closed: it
/// subscribes again (`audio_level_start`) when it is shown. With `reason`
/// the capture broke after it started (device unplugged, stream lost):
/// `message` says why, for the screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AudioLevelStopped {
    pub source: AudioSource,
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<CaptureFailure>,
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl AudioLevelStopped {
    pub const fn hidden(source: AudioSource) -> Self {
        Self {
            source,
            reason: None,
            message: None,
        }
    }

    pub fn failed(source: AudioSource, failure: level::Failure) -> Self {
        Self {
            source,
            reason: Some(failure.reason),
            message: Some(failure.message),
        }
    }
}

/// The meters of the app: real devices, events to windows by label.
pub fn levels_for_app<R: Runtime>(app: &AppHandle<R>) -> AudioLevels {
    AudioLevels::new(
        sources::DeviceOpener,
        levels::WindowSink(app.clone()),
        Some(levels::TICK),
    )
}

/// Drops the subscriptions of a window that was hidden or closed and tells
/// it (`AudioLevelStopped`). Called on the main thread: the devices are
/// released on another one.
pub fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(levels) = app.try_state::<AudioLevels>() {
        levels.remove_window_in_background(label);
    }
}
