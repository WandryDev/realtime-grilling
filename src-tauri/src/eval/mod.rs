//! `grill-eval`: recorded calls replayed through the fast loop, to measure a
//! change of the prompt or of the loop before and after
//! (`specs/question-replay`, question-quality design.md decisions 1–5).
//!
//! - [`cli`]: the subcommands and their arguments, the only way in;
//! - `corpus`: the corpus of one call, a JSON file in `.grill-eval/corpus/`;
//! - `export`: a recording of the app's database into a corpus (the
//!   database is opened read-only);
//! - `replay`: a corpus through the real `FastLoop` on an in-memory
//!   database and tokio's paused clock;
//! - `report`: the raw results of a replay, `report.json`;
//! - `judge`: the LLM judge's labels of a run, `judge.json`;
//! - `metrics`: the metrics of a run and `report.md`;
//! - `compare`: two runs of one corpus side by side, `compare.md`;
//! - `brief`: a corpus's brief rebuilt with the current brief prompt.
//!
//! Everything else of the crate stays private: this module reaches it from
//! inside.

mod brief;
pub mod cli;
mod compare;
mod corpus;
mod export;
mod judge;
mod metrics;
mod replay;
mod report;
#[cfg(test)]
mod testing;
