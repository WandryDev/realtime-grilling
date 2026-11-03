//! The recorder in the app: real devices, the app's windows, its storage.

use std::{
    sync::{Arc, Mutex, PoisonError, mpsc},
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::{
    manager::{CaptureDevices, Config, DbWork, RecordingHost, RecordingManager},
    status::{RecordingChanged, RecordingLevels, RecordingStatus},
    store::RecordingStore,
};
use crate::{
    audio::{AudioSource, levels::Opened, sink::RingSink, sources},
    error::{CommandError, CommandResult},
    permissions::{self, PermissionKind, PermissionStatus},
    storage::Storage,
    vad,
};

/// The default input and the system audio of this computer.
struct AppDevices;

impl CaptureDevices for AppDevices {
    fn permission(&self, kind: PermissionKind) -> PermissionStatus {
        permissions::status(kind)
    }

    fn open(&self, source: AudioSource, sink: RingSink) -> CommandResult<Opened> {
        match source {
            AudioSource::Microphone => sources::open_microphone(sink),
            AudioSource::System => sources::open_system(sink),
        }
    }

    fn default_input(&self) -> Option<String> {
        sources::default_input_id()
    }
}

/// How long the visible windows are trusted before asking again: asking
/// goes through the main thread.
const VISIBILITY_TTL: Duration = Duration::from_millis(500);

struct AppHost<R: Runtime> {
    app: AppHandle<R>,
    visible: Mutex<Option<(Instant, Vec<String>)>>,
}

impl<R: Runtime> AppHost<R> {
    fn visible_windows(&self) -> Vec<String> {
        let mut cached = self.visible.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((at, labels)) = cached.as_ref()
            && at.elapsed() < VISIBILITY_TTL
        {
            return labels.clone();
        }
        let labels: Vec<String> = self
            .app
            .webview_windows()
            .into_iter()
            .filter(|(_, window)| window.is_visible().unwrap_or(false))
            .map(|(label, _)| label)
            .collect();
        *cached = Some((Instant::now(), labels.clone()));
        labels
    }
}

impl<R: Runtime> RecordingHost for AppHost<R> {
    fn changed(&self, status: &RecordingStatus) {
        if let Err(error) = RecordingChanged(status.clone()).emit(&self.app) {
            eprintln!("grill: failed to emit recording-changed: {error}");
        }
    }

    fn levels(&self, levels: &RecordingLevels) {
        for label in self.visible_windows() {
            if let Err(error) = levels.emit_to(&self.app, &label) {
                eprintln!("grill: failed to emit recording-levels to {label}: {error}");
            }
        }
    }

    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        let storage = self
            .app
            .try_state::<Storage>()
            .ok_or_else(|| CommandError::storage("Хранилище ещё не открыто"))?;
        storage.read_now(|connection| work(connection))
    }

    fn store(&self) -> Option<Arc<dyn RecordingStore>> {
        let storage = self.app.try_state::<Storage>()?;
        let store: Arc<dyn RecordingStore> = storage.recording_store()?;
        Some(store)
    }
}

/// The recorder of the app: real devices, bundled VAD model, phrases to
/// the default sink (stderr in debug builds) until recognition exists.
pub fn manager_for_app<R: Runtime>(app: &AppHandle<R>) -> RecordingManager {
    RecordingManager::new(
        AppDevices,
        AppHost {
            app: app.clone(),
            visible: Mutex::new(None),
        },
        Config::new(vad::bundled_model_path(app), vad::worker::default_sink()),
    )
}

/// How long exit waits for the files to close. Emitting to a window may
/// need the main thread, which is busy exiting: past this the app exits
/// and the next start marks the recording interrupted.
const EXIT_WAIT: Duration = Duration::from_secs(3);

/// Stops a running recording on app exit, so its files end with EOS.
pub fn stop_on_exit<R: Runtime>(app: &AppHandle<R>) {
    let Some(manager) = app.try_state::<RecordingManager>() else {
        return;
    };
    if !manager.is_recording() {
        return;
    }
    let manager = manager.inner().clone();
    let (done, stopped) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("grill-recording-exit".to_owned())
        .spawn(move || {
            manager.stop_running();
            let _ = done.send(());
        });
    match spawned {
        Ok(_) => {
            if stopped.recv_timeout(EXIT_WAIT).is_err() {
                eprintln!("grill: the recording did not close in time on exit");
            }
        }
        Err(error) => eprintln!("grill: could not stop the recording on exit: {error}"),
    }
}
