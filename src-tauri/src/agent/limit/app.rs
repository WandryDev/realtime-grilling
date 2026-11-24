//! The share of the limit in the app: its state, its event to the windows,
//! the polls of `/usage` (design.md, decision 2) and the summaries that
//! waited for a threshold (decision 7).

use std::{path::PathBuf, sync::Arc};

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::{
    Clock, LimitThresholds, POLL_EVERY, Refresh, SubscriptionLimit, SubscriptionLimitChanged,
};
use crate::{
    agent::{self, discover::SearchEnv},
    storage::{Storage, settings::SettingsMap},
};

/// The app's share of the limit with the stored thresholds: every change
/// goes to every window, and the reset timer runs.
pub fn for_app<R: Runtime>(app: &AppHandle<R>, stored: &SettingsMap) -> SubscriptionLimit {
    let limit = SubscriptionLimit::new(Clock::system(), LimitThresholds::of(stored));
    let handle = app.clone();
    limit.on_change(Arc::new(move |view| {
        let event = SubscriptionLimitChanged {
            limit: view.clone(),
        };
        if let Err(error) = event.emit(&handle) {
            eprintln!("grill: failed to emit subscription-limit-changed: {error}");
        }
    }));
    tauri::async_runtime::spawn(limit.clone().watch_resets());
    limit
}

/// The polls of the app's life: at the start, then every [`POLL_EVERY`]
/// (a tokio timer, still while the machine sleeps).
pub fn schedule_polls<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            refresh(&app).await;
            tokio::time::sleep(POLL_EVERY).await;
        }
    });
}

/// Polls `/usage` now (joining a poll that runs), once the agent is ready.
pub async fn refresh<R: Runtime>(app: &AppHandle<R>) -> Refresh {
    let Some(limit) = app.try_state::<SubscriptionLimit>() else {
        return Refresh::NotReady;
    };
    let limit = limit.inner().clone();
    limit.refresh(|| ready(app)).await
}

/// A poll in the background: the start widget was shown.
pub fn refresh_soon<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        refresh(&app).await;
    });
}

/// The CLI and the folder it runs in (the app's data dir, as for the
/// status check) when the agent's status is `ready`.
async fn ready<R: Runtime>(app: &AppHandle<R>) -> Option<(PathBuf, PathBuf)> {
    let storage = app.try_state::<Storage>()?;
    let cwd = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let cli = agent::ready_cli(&storage, app, &SearchEnv::from_process(), &cwd)
        .await
        .ok()?;
    Some((cli, cwd))
}

/// The app's share of the limit; a fresh one (no measures, nothing
/// stops) before the setup managed it.
pub fn of<R: Runtime>(app: &AppHandle<R>) -> SubscriptionLimit {
    app.try_state::<SubscriptionLimit>()
        .map(|limit| limit.inner().clone())
        .unwrap_or_default()
}
