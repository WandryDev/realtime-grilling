//! Speech recognition (`specs/speech-models`, `specs/speech-recognition`,
//! speech-recognition design.md): the Whisper models the app downloads and
//! keeps in `<app_data>/models/`, the recognizer, its filters and glossary,
//! the live pass over the recorder's phrases, the second pass after a
//! recording, the hardware check and the mic check.

pub mod benchmark;
pub mod check;
pub mod context;
pub mod download;
pub mod events;
pub mod filters;
pub mod glossary;
pub mod host;
pub mod language;
pub mod live;
pub mod mic_check;
pub mod models;
pub mod recognizer;
pub mod refiner;
pub mod service;
pub mod status;
#[cfg(test)]
pub mod testing;
