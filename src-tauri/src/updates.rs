//! Updates of the app from the GitHub releases (Tauri's updater plugin).
//!
//! The release workflow publishes `latest.json` next to the signed update
//! archives; `plugins.updater` in `tauri.conf.json` points at the latest
//! release's copy and holds the public key every archive is checked with.
//!
//! The app checks a little after the start and then every few hours,
//! downloads a found update in the background and says it is ready
//! (`UpdateStatus`). It is installed only when the user asks («Перезапустить»),
//! never during a call. Debug builds never update themselves.

use std::{
    sync::{Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_specta::Event;

use crate::{
    call::CallManager,
    error::{CommandError, CommandResult},
    recording::RecordingManager,
    shell::QuitRequested,
};

/// Whether this build updates itself: only release builds do. A debug
/// build would replace itself with the published app.
const ENABLED: bool = !cfg!(debug_assertions);

/// The first check waits for the start to settle.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(30);
const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

const PERCENT: u64 = 100;

/// What the updater is doing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateState {
    /// A debug build: it never updates itself.
    Disabled,
    /// No check yet.
    Idle,
    Checking,
    /// The last check found nothing newer.
    UpToDate {
        /// Milliseconds since the Unix epoch.
        #[serde(rename = "checkedAt")]
        checked_at: i64,
    },
    Downloading {
        version: String,
        /// `null` while the server hasn't said the size.
        percent: Option<u8>,
    },
    /// Downloaded and verified: a restart installs it.
    Ready {
        version: String,
        /// The release notes (the CHANGELOG entry), if any.
        notes: Option<String>,
    },
    Installing {
        version: String,
    },
    /// The last check, download or install failed.
    Failed {
        message: String,
    },
}

/// This build's version and what the updater does. Sent to every window on
/// each change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub current: String,
    pub state: UpdateState,
}

/// A downloaded update waiting for «Перезапустить».
struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

struct Inner {
    state: UpdateState,
    pending: Option<Pending>,
    /// A check or download is running.
    busy: bool,
}

/// The app's updater state (managed).
pub struct Updates(Mutex<Inner>);

impl Default for Updates {
    fn default() -> Self {
        Self(Mutex::new(Inner {
            state: if ENABLED {
                UpdateState::Idle
            } else {
                UpdateState::Disabled
            },
            pending: None,
            busy: false,
        }))
    }
}

impl Updates {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn state(&self) -> UpdateState {
        self.lock().state.clone()
    }
}

/// The status now.
pub fn status<R: Runtime>(app: &AppHandle<R>) -> UpdateStatus {
    UpdateStatus {
        current: app.package_info().version.to_string(),
        state: app.state::<Updates>().state(),
    }
}

fn set_state<R: Runtime>(app: &AppHandle<R>, state: UpdateState) {
    app.state::<Updates>().lock().state = state;
    if let Err(error) = status(app).emit(app) {
        eprintln!("grill: failed to send the update status: {error}");
    }
}

/// Starts the background checks (release builds only).
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    if !ENABLED {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        loop {
            check(&app, false).await;
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// Looks for an update and downloads it. A background check (`manual`
/// false) that fails keeps the status it had: being offline is not news. An
/// update already downloaded is not looked for again: the restart applies it.
pub async fn check<R: Runtime>(app: &AppHandle<R>, manual: bool) -> UpdateStatus {
    let updates = app.state::<Updates>();
    let previous = {
        let mut inner = updates.lock();
        let settled = matches!(
            inner.state,
            UpdateState::Disabled | UpdateState::Ready { .. } | UpdateState::Installing { .. }
        );
        if inner.busy || settled {
            drop(inner);
            return status(app);
        }
        inner.busy = true;
        inner.state.clone()
    };
    set_state(app, UpdateState::Checking);
    let outcome = find_and_download(app).await;
    updates.lock().busy = false;
    match outcome {
        Ok(state) => set_state(app, state),
        Err(error) => {
            eprintln!("grill: update check failed: {error}");
            let state = if manual {
                UpdateState::Failed {
                    message: format!("Не получилось проверить обновления: {error}"),
                }
            } else {
                previous
            };
            set_state(app, state);
        }
    }
    status(app)
}

async fn find_and_download<R: Runtime>(
    app: &AppHandle<R>,
) -> tauri_plugin_updater::Result<UpdateState> {
    let exiting = app.clone();
    let updater = app
        .updater_builder()
        // Windows: the installer is started and the app exits right away,
        // without `RunEvent::Exit`: stop the agent's CLI and the recorder here.
        .on_before_exit(move || {
            crate::shell::shutdown(&exiting);
            exiting.cleanup_before_exit();
        })
        .build()?;
    let Some(update) = updater.check().await? else {
        return Ok(UpdateState::UpToDate {
            checked_at: chrono::Utc::now().timestamp_millis(),
        });
    };
    let version = update.version.clone();
    set_state(
        app,
        UpdateState::Downloading {
            version: version.clone(),
            percent: None,
        },
    );
    let mut received = 0_u64;
    let mut shown = None;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                let percent = total.map(|total| percent_of(received, total));
                if percent != shown {
                    shown = percent;
                    set_state(
                        app,
                        UpdateState::Downloading {
                            version: version.clone(),
                            percent,
                        },
                    );
                }
            },
            || {},
        )
        .await?;
    let notes = update.body.clone().filter(|notes| !notes.trim().is_empty());
    app.state::<Updates>().lock().pending = Some(Pending { update, bytes });
    Ok(UpdateState::Ready { version, notes })
}

fn percent_of(received: u64, total: u64) -> u8 {
    if total == 0 {
        return 0;
    }
    u8::try_from((received.saturating_mul(PERCENT) / total).min(PERCENT)).unwrap_or(100)
}

/// «Перезапустить»: installs the downloaded update and starts the new
/// version. Refused (`Invalid`) during a call or without a downloaded
/// update. Returns only on failure: the app restarts.
pub async fn install<R: Runtime>(app: &AppHandle<R>) -> CommandResult<()> {
    // No call starts while the app is being replaced.
    let calls = app.state::<CallManager>();
    let _no_call = calls
        .hold_idle()
        .await
        .map_err(|_| CommandError::invalid(DURING_CALL))?;
    if app.state::<RecordingManager>().is_recording() {
        return Err(CommandError::invalid(DURING_CALL));
    }
    let pending = app.state::<Updates>().lock().pending.take();
    let Some(Pending { update, bytes }) = pending else {
        return Err(CommandError::invalid("Обновление ещё не скачано"));
    };
    let version = update.version.clone();
    set_state(
        app,
        UpdateState::Installing {
            version: version.clone(),
        },
    );
    // Unpacking replaces the app on disk; Windows exits in it.
    let installed = tauri::async_runtime::spawn_blocking(move || {
        update.install(&bytes).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    match installed {
        Ok(()) => QuitRequested::restart(app),
        Err(error) => {
            let message = format!("Не получилось установить версию {version}: {error}");
            set_state(
                app,
                UpdateState::Failed {
                    message: message.clone(),
                },
            );
            Err(CommandError::external(message))
        }
    }
}

const DURING_CALL: &str = "Идёт звонок: Grill обновится, когда вы его завершите";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_is_whole_and_capped() {
        assert_eq!(percent_of(0, 200), 0);
        assert_eq!(percent_of(99, 200), 49);
        assert_eq!(percent_of(200, 200), 100);
        assert_eq!(percent_of(300, 200), 100);
        assert_eq!(percent_of(5, 0), 0);
    }

    #[test]
    fn status_serializes_with_a_status_tag() {
        let json = |state: UpdateState| {
            serde_json::to_value(UpdateStatus {
                current: "0.3.0".into(),
                state,
            })
            .unwrap()
        };
        assert_eq!(
            json(UpdateState::UpToDate { checked_at: 5 }),
            serde_json::json!({ "current": "0.3.0", "state": { "status": "upToDate", "checkedAt": 5 } })
        );
        assert_eq!(
            json(UpdateState::Downloading {
                version: "0.4.0".into(),
                percent: None
            }),
            serde_json::json!({ "current": "0.3.0", "state": { "status": "downloading", "version": "0.4.0", "percent": null } })
        );
    }

    #[test]
    fn a_debug_build_never_updates() {
        assert_eq!(Updates::default().state(), UpdateState::Disabled);
    }
}
