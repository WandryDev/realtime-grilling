//! Audio capture. The meters for the checks before a call
//! (`specs/audio-check`, design.md decisions 12–14) and the recorder
//! (`crate::recording`, audio-capture decisions 7–9) open the same devices
//! (`sources`) into different sinks (`sink`): an RMS feed or a timestamped
//! ring. `mic_watch`: whether another app uses the microphone
//! (`specs/mic-activity`).

pub mod clock;
pub mod inputs;
pub mod level;
pub mod levels;
#[cfg(target_os = "macos")]
pub mod mac;
pub mod mic_watch;
pub mod sink;
pub mod sources;
#[cfg(windows)]
mod win;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use crate::error::CaptureFailure;

pub use inputs::{AudioInputs, AudioInputsChanged, Inputs, InputsSink};
pub use levels::AudioLevels;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "camelCase")]
pub enum AudioSource {
    /// The chosen input device, else the default one ("Я").
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
pub fn levels_for_app<R: Runtime>(app: &AppHandle<R>, inputs: &Inputs) -> AudioLevels {
    AudioLevels::new(
        sources::DeviceOpener {
            inputs: inputs.clone(),
        },
        levels::WindowSink(app.clone()),
        Some(levels::TICK),
    )
}

/// The inputs' events in the app: `AudioInputsChanged` to every window; a
/// new device to open reopens a running microphone meter.
struct AppInputsSink<R: Runtime>(AppHandle<R>);

impl<R: Runtime> InputsSink for AppInputsSink<R> {
    fn changed(&self, inputs: &AudioInputs) {
        if let Err(error) = AudioInputsChanged(inputs.clone()).emit(&self.0) {
            eprintln!("grill: failed to emit audio-inputs-changed: {error}");
        }
    }

    fn target_changed(&self) {
        let Some(levels) = self.0.try_state::<AudioLevels>() else {
            return;
        };
        levels.restart_in_background(AudioSource::Microphone);
    }
}

/// The computer's microphones and the chosen one (`selected`: the stored
/// `microphone`, `None` for «Как в системе»).
pub fn inputs_for_app<R: Runtime>(app: &AppHandle<R>, selected: Option<String>) -> Inputs {
    Inputs::new(
        inputs::CpalInputs,
        selected,
        AppInputsSink(app.clone()),
        crate::storage::now_ms,
        Some(inputs::POLL),
    )
}

/// Drops the subscriptions of a window that was hidden or closed and tells
/// it (`AudioLevelStopped`). Called on the main thread: the devices are
/// released on another one.
pub fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(levels) = app.try_state::<AudioLevels>() {
        levels.remove_window_in_background(label);
    }
    if let Some(inputs) = app.try_state::<Inputs>() {
        inputs.remove_window(label);
    }
}
