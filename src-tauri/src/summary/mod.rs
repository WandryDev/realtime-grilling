//! The summary of a call, built by the backend after the call (post-call
//! design.md, decisions 1–6; `specs/call-summary`).
//!
//! [`builds::SummaryBuilds`] (Tauri state) keeps one build per call. A build
//! goes through four [`SummaryStage`]s, each sent to every window as
//! [`SummaryProgress`]:
//!
//! 1. `transcript`: waits for the second pass of every recording of the
//!    call, at most [`REFINE_SILENCE`] without news of it, then reads the
//!    transcript ([`transcript`]);
//! 2. `summary`: agent call A (title, TL;DR, topics with points and cards,
//!    answered questions, questions for the next call);
//! 3. `proposals`: agent call B (updates of the brief and the profiles);
//!    none for a call without a project;
//! 4. `saving`: the checks of decision 4 and one transaction.
//!
//! The windows only show it: a build goes on when they reload or close.

pub mod builds;
pub mod transcript;

use std::time::Duration;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::storage::summaries::{CallSummary, SummaryTranscriptPass};

/// The full name: an alias may move to another model.
pub const MODEL: &str = "claude-sonnet-5-5";
/// As the brief: a summary is built once per call, quality matters more.
pub const EFFORT: &str = "medium";
/// Per agent call (design.md, decision 3).
pub const TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the `transcript` stage waits without news of the second pass
/// before it goes on with the live transcript (`call-summary`, «Второй
/// проход не успел»).
pub const REFINE_SILENCE: Duration = Duration::from_secs(60);
/// The `error` of a summary whose build was stopped («Остановить», or the
/// call went back to live or away).
pub const CANCELLED: &str = "cancelled";

/// A stage of a build, in their order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SummaryStage {
    /// Waiting for the second pass, reading the transcript.
    Transcript,
    /// The agent builds the summary (call A).
    Summary,
    /// The agent proposes updates of the brief and the profiles (call B);
    /// skipped for a call without a project.
    Proposals,
    /// The checks and the transaction.
    Saving,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SummaryStageState {
    Running,
    Done,
    /// At `summary` or `saving` the build ends here and the previous
    /// summary stays; at `proposals` it goes on without new proposals.
    Failed {
        message: String,
    },
    /// Stopped: nothing is saved.
    Cancelled,
}

/// What the stages' descriptions count («N реплик, M тем»), once known.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SummaryCounts {
    /// Segments of the chosen passes, every recording of the call.
    pub segments: u32,
    /// The fast loop's topics until `summary` is done, then the summary's.
    pub topics: u32,
    pub transcript_pass: SummaryTranscriptPass,
    /// New proposals, once `proposals` is done.
    pub proposals: Option<u32>,
}

/// Where a summary build is (design.md, decisions 1 and 2). Sent to every
/// window; each stage goes `running`, then `done` when the next one starts.
/// The build ends with `(saving, done)`, or with `failed` or `cancelled` at
/// the stage it reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SummaryProgress {
    pub call_id: String,
    pub stage: SummaryStage,
    pub state: SummaryStageState,
    /// `null` until the transcript is read.
    pub counts: Option<SummaryCounts>,
}

/// What `summary_get` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallSummaryView {
    /// `null` while the call is live, or finishing before its build wrote
    /// anything; a finished call without a row reads as `failed` /
    /// `interrupted`.
    pub summary: Option<CallSummary>,
    /// The last progress of the build that runs now; `null` when none runs.
    /// A window that opens during a build shows this stage.
    pub building: Option<SummaryProgress>,
}

#[cfg(test)]
mod tests;
