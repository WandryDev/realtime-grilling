//! The fast loop of the agent while recording (`specs/agent-fast-loop`,
//! design.md decisions 2–8).
//!
//! - [`patch`]: the JSON Schema for the CLI and the serde types of the reply;
//! - [`evidence`]: normalization and the fuzzy quote match;
//! - [`similarity`]: whether a new question repeats a known one;
//! - [`validate`]: a parsed patch and its call's context → a
//!   [`ValidatedPatch`](crate::storage::call_state::ValidatedPatch) and the
//!   rejected operations with their reasons;
//! - [`assembly`]: the stable prefix and the volatile part of a call;
//! - [`scheduler`]: when a call runs, one scheduler per recording;
//! - [`topic_check`]: the call that asks whether the topic changed;
//! - [`events`]: `CallStateChanged`, `AgentStatus`;
//! - [`app`]: the fast loop in the app (storage, windows, Claude Code).

pub mod app;
pub mod assembly;
/// End to end with a fake `claude` script.
#[cfg(all(test, unix))]
mod e2e_tests;
pub mod events;
pub mod evidence;
pub mod patch;
pub mod scheduler;
pub mod similarity;
#[cfg(test)]
pub mod testing;
pub mod topic_check;
pub mod validate;
