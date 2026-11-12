//! The slow loop of the agent while recording (`specs/agent-slow-loop`,
//! design.md decisions 1–4): in the background it searches the project's
//! sources for what the conversation touched and keeps the findings the
//! agent picked, without holding up the fast loop.
//!
//! - [`search`]: the in-memory BM25 index of the project's sources;
//! - [`assembly`]: the prompt file and the message of a call;
//! - [`validate`]: the reply and the checks of its findings;
//! - [`scheduler`]: when a call runs, one task per recording;
//! - [`app`]: the slow loop in the app.

pub mod app;
pub mod assembly;
/// End to end with a fake `claude` script.
#[cfg(all(test, unix))]
mod e2e_tests;
pub mod scheduler;
pub mod search;
pub mod validate;
