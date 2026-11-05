//! The call in the app: its storage, its windows, the tray and the recorder.

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use super::{
    CallHost, CallManager, CallRecorder, CallSettings, DbWork,
    windows::{self, WindowStep},
};
use crate::{
    audio::mic_watch,
    error::{CommandError, CommandResult},
    events::{CallSession, CallSessionChanged, CallSessionStatus, DataChanged, EventSink},
    recording::RecordingManager,
    shell::tray,
    speech::service::Speech,
    storage::{
        Storage,
        recordings::RecordingLinks,
        settings::{self, SettingsMap},
    },
};

struct AppCallHost<R: Runtime> {
    app: AppHandle<R>,
}

/// The settings a call acts on; their defaults without a database.
fn call_settings(stored: &SettingsMap) -> CallSettings {
    CallSettings {
        compact_overlay: settings::compact_overlay(stored),
        auto_end: settings::auto_end(stored),
    }
}

fn stored_call_settings<R: Runtime>(app: &AppHandle<R>) -> CallSettings {
    let stored = app
        .try_state::<Storage>()
        .and_then(|storage| storage.read_now(settings::get).ok())
        .unwrap_or_else(settings::defaults);
    call_settings(&stored)
}

impl<R: Runtime> CallHost for AppCallHost<R> {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        let storage = self
            .app
            .try_state::<Storage>()
            .ok_or_else(|| CommandError::storage("Хранилище ещё не открыто"))?;
        storage.read_now(|connection| work(connection))
    }

    fn data_changed(&self, event: DataChanged) {
        self.app.data_changed(event);
    }

    fn session_changed(&self, session: &CallSession) {
        let event = CallSessionChanged {
            session: session.clone(),
        };
        if let Err(error) = event.emit(&self.app) {
            eprintln!("grill: failed to emit call-session-changed: {error}");
        }
    }

    fn settings(&self) -> CallSettings {
        stored_call_settings(&self.app)
    }

    fn window(&self, step: WindowStep) {
        windows::apply(&self.app, step);
    }

    fn show_widget(&self, app: &str) {
        mic_watch::show_widget(&self.app, app);
    }

    fn tray(&self, in_call: bool) {
        tray::set_in_call(&self.app, in_call);
    }
}

/// The app's recorder. A start interrupts a running hardware check, as
/// `recording_start` does: the live pass needs the recognizer and the
/// selected model.
struct AppRecorder {
    recorder: RecordingManager,
    speech: Speech,
}

impl CallRecorder for AppRecorder {
    fn start(&self, links: &RecordingLinks) -> CommandResult<String> {
        self.speech.interrupt_check();
        let started = self.recorder.start(links);
        // A check that began while the devices opened.
        self.speech.interrupt_check();
        started
    }

    fn stop(&self, id: &str) -> CommandResult<()> {
        self.recorder.stop(id)
    }
}

/// The call manager of the app, on Tauri's runtime.
pub fn manager_for_app<R: Runtime>(
    app: &AppHandle<R>,
    recorder: RecordingManager,
    speech: Speech,
) -> CallManager {
    CallManager::new(
        AppCallHost { app: app.clone() },
        AppRecorder { recorder, speech },
        tauri::async_runtime::handle().inner().clone(),
    )
}

/// The `toggle-call` shortcut and "Открыть звонок" in the tray: the call in
/// progress (the overlay or the call window, as its start chose), or the
/// start widget without one.
pub fn toggle_call<R: Runtime>(app: &AppHandle<R>) {
    let steps = app.try_state::<CallManager>().map_or_else(
        || windows::toggle_call(CallSessionStatus::Idle, false),
        |calls| calls.toggle_steps(),
    );
    for step in steps {
        windows::apply(app, step);
    }
}

/// "Завершить звонок" in the tray.
pub fn finish_current<R: Runtime>(app: &AppHandle<R>) {
    let Some(calls) = app.try_state::<CallManager>() else {
        return;
    };
    let calls = calls.inner().clone();
    tauri::async_runtime::spawn(async move { calls.finish_current().await });
}
