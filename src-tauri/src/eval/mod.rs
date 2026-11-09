//! `grill-eval`: recorded calls replayed through the fast loop, to measure a
//! change of the prompt or of the loop before and after
//! (`specs/question-replay`, question-quality design.md decisions 1–3).
//!
//! - [`cli`]: the subcommands and their arguments, the only way in;
//! - `corpus`: the corpus of one call, a JSON file in `.grill-eval/corpus/`;
//! - `export`: a recording of the app's database into a corpus (the
//!   database is opened read-only);
//! - `replay`: a corpus through the real `FastLoop` on an in-memory
//!   database and tokio's paused clock;
//! - `report`: the raw results of a replay, `report.json`.
//!
//! Everything else of the crate stays private: this module reaches it from
//! inside.

pub mod cli;
mod corpus;
mod export;
mod replay;
mod report;
