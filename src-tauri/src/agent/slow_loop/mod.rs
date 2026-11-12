//! The slow loop of the agent while recording (`specs/agent-slow-loop`,
//! design.md decisions 1–4): in the background it searches the project's
//! sources for what the conversation touched and keeps the findings the
//! agent picked, without holding up the fast loop.
//!
//! - [`search`]: the in-memory BM25 index of the project's sources.

pub mod search;
