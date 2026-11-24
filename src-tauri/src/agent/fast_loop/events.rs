//! What the windows learn about the fast loop (design.md, decision 10).
//! Both events go to every window.

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::{agent::limit::LimitHit, storage::call_state::CallState};

/// The call state of a recording changed (a patch was applied, a quick
/// action or `questionCount` changed the list): read `call_state_get`
/// again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct CallStateChanged {
    pub recording_id: String,
}

/// Where the agent of a recording is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AgentLoopState {
    /// Waits for the next phrase of «Остальные».
    Idle,
    /// A call runs.
    Thinking,
    /// The last call failed. `retryAt` (Unix ms): when the next call starts
    /// by itself; `null` when it waits for `agent_retry`.
    Error {
        message: String,
        #[serde(rename = "retryAt")]
        retry_at: Option<i64>,
    },
    /// Claude Code is not signed in: no calls until it is (a status check
    /// in Settings, or `agent_retry`).
    NeedsLogin,
    /// The subscription limit is used up; `resetsAt` (Unix ms) when known.
    /// Calls resume after it.
    RateLimited {
        #[serde(rename = "resetsAt")]
        resets_at: Option<i64>,
    },
    /// A threshold of Grill is reached (agent-limit-guard): no calls until
    /// it lets go or «Продолжить сверх лимита» (`agent_limit_override`).
    GrillLimit { hit: LimitHit },
}

/// The agent's state for a recording, with the last known share of the
/// subscription limit used (0–1).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub recording_id: String,
    pub state: AgentLoopState,
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
}

/// `call_state_get`: the whole state of the recording's call and its
/// agent.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallStateView {
    #[serde(flatten)]
    pub state: CallState,
    pub agent: AgentStatus,
}
