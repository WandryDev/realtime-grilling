//! The recorder in the app: real devices, the app's windows, its storage.

use std::{
    sync::{Arc, mpsc},
    time::Duration,
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::{
    manager::{CaptureDevices, Config, DbWork, RecordingHost, RecordingManager},
    status::{RecordingChanged, RecordingLevels, RecordingStatus},
    store::RecordingStore,
};
use crate::{
    audio::{AudioSource, Inputs, levels::Opened, sink::RingSink, sources},
    error::{CommandError, CommandResult},
    permissions::{self, PermissionKind, PermissionStatus},
    speech::{
        self,
        live::{LiveConfig, TranscriptSink},
        recognizer::Recognizer,
    },
    storage::Storage,
    vad,
};

/// The chosen (else the default) input and the system audio of this
/// computer.
struct AppDevices {
    inputs: Inputs,
}

impl CaptureDevices for AppDevices {
    fn permission(&self, kind: PermissionKind) -> PermissionStatus {
        permissions::status(kind)
    }

    fn open(&self, source: AudioSource, sink: RingSink) -> CommandResult<Opened> {
        match source {
            AudioSource::Microphone => sources::open_microphone(&self.inputs.target(), sink),
            AudioSource::System => sources::open_system(sink),
        }
    }

    fn microphone_input(&self) -> Option<String> {
        self.inputs.target().name
    }
}

/// The recorder's host in the app. The recorder thread calls it every
/// 100 ms, so nothing here waits for the main thread: emitting only queues
/// a script for each webview, while asking a window (`is_visible`) would
/// block on the main thread, which a quitting app holds in `RunEvent::Exit`
/// waiting for this very thread (`stop_on_exit`).
struct AppHost<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> RecordingHost for AppHost<R> {
    fn changed(&self, status: &RecordingStatus) {
        if let Err(error) = RecordingChanged(status.clone()).emit(&self.app) {
            eprintln!("grill: failed to emit recording-changed: {error}");
        }
    }

    /// To every window: only the webviews listening (a recording
    /// indicator on screen) run anything.
    fn levels(&self, levels: &RecordingLevels) {
        if let Err(error) = levels.emit(&self.app) {
            eprintln!("grill: failed to emit recording-levels: {error}");
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
/// the live pass on `recognizer`.
pub fn manager_for_app<R: Runtime>(
    app: &AppHandle<R>,
    recognizer: Recognizer,
    inputs: &Inputs,
) -> RecordingManager {
    let phrases = TranscriptSink::new(
        speech::service::app_host(app),
        recognizer,
        LiveConfig::default(),
    );
    RecordingManager::new(
        AppDevices {
            inputs: inputs.clone(),
        },
        AppHost { app: app.clone() },
        Config::new(vad::bundled_model_path(app), Arc::new(phrases)),
    )
}

/// How long exit waits for the files to close. Nothing on the way needs the
/// main thread (busy exiting); past this the app exits anyway and the next
/// start marks the recording interrupted.
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
