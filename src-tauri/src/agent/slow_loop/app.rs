//! The slow loop in the app: next to the fast loop, sharing its storage,
//! its windows, Claude Code and its halt (agent-slow-loop task 3.4).

use std::sync::Arc;

use rusqlite::Connection;
use tauri::{AppHandle, Runtime};

use super::scheduler::{SlowConfig, SlowLoop};
use crate::{
    agent::fast_loop::{
        app::{self as fast_loop_app, AppLoopHost, CliProvider, work_dir},
        events::CallStateView,
        scheduler::FastLoop,
    },
    agent::limit::SubscriptionLimit,
    error::CommandResult,
};

/// The slow loop of the app, on Tauri's runtime, sharing the halt of
/// `fast_loop`, which tells it of every change of the current topic, and
/// stopping at the thresholds of `limit`. The prompt files a crash left
/// behind are removed.
pub fn for_app<R: Runtime>(
    app: &AppHandle<R>,
    fast_loop: &FastLoop,
    limit: &SubscriptionLimit,
) -> SlowLoop {
    let mut config = SlowConfig::new(work_dir(app));
    config.limit = limit.clone();
    let slow_loop = SlowLoop::new(
        Arc::new(AppLoopHost { app: app.clone() }),
        Arc::new(CliProvider { app: app.clone() }),
        tauri::async_runtime::handle().inner().clone(),
        config,
        fast_loop.halt(),
    );
    connect(fast_loop, &slow_loop);
    let removed = slow_loop.sweep_prompts();
    if removed > 0 {
        eprintln!(
            "grill: removed {removed} prompt files of the slow loop left from an earlier run"
        );
    }
    slow_loop
}

/// The fast loop tells the slow one when a recording's topic changed.
pub fn connect(fast_loop: &FastLoop, slow_loop: &SlowLoop) {
    let slow = slow_loop.clone();
    fast_loop.on_topic_changed(Arc::new(move |recording_id: &str| {
        slow.topic_changed(recording_id);
    }));
}

/// What `call_state_get` returns: the fast loop's view with the slow loop's
/// search.
pub fn view(
    connection: &Connection,
    fast_loop: &FastLoop,
    slow_loop: &SlowLoop,
    recording_id: &str,
) -> CommandResult<CallStateView> {
    let mut view = fast_loop_app::view(connection, fast_loop, recording_id)?;
    view.state.context_search = slow_loop.search(recording_id);
    Ok(view)
}
