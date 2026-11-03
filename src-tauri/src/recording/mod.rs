//! Call recording (`specs/call-recording`, audio-capture design.md decisions
//! 7–15). [`RecordingManager`] (Tauri state) starts and stops it; while it
//! runs, a supervisor thread keeps the devices open and the recorder thread
//! runs, every 10 ms:
//!
//! ```text
//! capture blocks ─▶ Timeline (mono, 16 kHz, placed by host time) ─▶ 10 ms frames
//!   frames of "Я" ─▶ Aec (render = "Остальные") ─▶ OggOpusWriter (me.opus)
//!   frames of "Остальные" ─────────────────────▶ OggOpusWriter (others.opus)
//! ```
//!
//! Nothing here runs in an audio callback; allocations are fine but kept out
//! of the per-frame paths where it is cheap to do so.

pub mod aec;
mod app;
pub mod manager;
pub mod ogg_opus;
pub mod status;
pub mod store;
pub mod timeline;

pub use app::{manager_for_app, stop_on_exit};
pub use manager::RecordingManager;

/// Sample rate of everything after the timeline.
pub const SAMPLE_RATE: u32 = 16_000;

/// Samples in one 10 ms frame at [`SAMPLE_RATE`].
pub const FRAME: usize = 160;
