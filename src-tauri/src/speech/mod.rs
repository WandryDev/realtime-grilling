//! Speech recognition (`specs/speech-models`, `specs/speech-recognition`,
//! speech-recognition design.md): the Whisper models the app downloads and
//! keeps in `<app_data>/models/`, the recognizer, its filters and glossary,
//! and the phrases of the hardware check.

pub mod check;
pub mod download;
pub mod filters;
pub mod glossary;
pub mod language;
pub mod models;
pub mod recognizer;
