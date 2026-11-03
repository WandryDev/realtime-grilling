//! How the app lives in the OS: windows, tray, autostart, global shortcuts,
//! single instance (design.md, decisions 1–6).

pub mod shortcuts;
pub mod tray;
pub mod windows;

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{App, AppHandle, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

use crate::storage::{
    Storage,
    settings::{self, SettingsMap},
};
use shortcuts::ShortcutError;

/// Passed by the login item; the app then starts in the tray, no window.
pub const AUTOSTART_ARG: &str = "--autostart";

/// Set by "Выйти" in the tray: the only way the app exits on its own.
#[derive(Default)]
pub struct QuitRequested(AtomicBool);

impl QuitRequested {
    pub fn quit<R: Runtime>(app: &AppHandle<R>) {
        app.state::<Self>().0.store(true, Ordering::SeqCst);
        app.exit(0);
    }

    /// Starts the app again: macOS applies the system audio access only to
    /// a new process.
    pub fn restart<R: Runtime>(app: &AppHandle<R>) -> ! {
        app.state::<Self>().0.store(true, Ordering::SeqCst);
        app.restart()
    }
}

/// Whether onboarding is done and the storage works: which window "open the
/// app" shows, without a database read on the main thread.
#[derive(Default)]
struct Entry {
    onboarding_completed: AtomicBool,
    storage_failed: AtomicBool,
}

pub fn remember_onboarding<R: Runtime>(app: &AppHandle<R>, completed: bool) {
    app.state::<Entry>()
        .onboarding_completed
        .store(completed, Ordering::SeqCst);
}

/// Shows onboarding until it is done, then the main window. With a broken
/// database the main window shows the storage error.
pub fn show_entry<R: Runtime>(app: &AppHandle<R>) {
    let entry = app.state::<Entry>();
    let completed = entry.onboarding_completed.load(Ordering::SeqCst)
        || entry.storage_failed.load(Ordering::SeqCst);
    windows::show(app, windows::entry_label(completed));
}

/// Opens the database, applies the stored settings and shows the first window.
pub fn setup<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    let storage = match app.path().app_data_dir() {
        Ok(dir) => Storage::open_in(&dir),
        Err(error) => Storage::unavailable(format!("Не найдена папка данных приложения: {error}")),
    };
    if let Some(error) = storage.error() {
        eprintln!("grill: storage unavailable: {error}");
    }
    let stored = storage.read_now(settings::get).ok();
    let storage_failed = stored.is_none();
    let settings = stored.unwrap_or_else(settings::defaults);

    app.manage(storage);
    app.manage(QuitRequested::default());
    app.manage(shortcuts::Registered::default());
    app.manage(SettingsLock::default());
    app.manage(crate::audio::levels_for_app(app.handle()));
    app.manage(crate::agent::AgentSessions::default());
    app.manage(Entry {
        onboarding_completed: AtomicBool::new(settings::flag(
            &settings,
            settings::ONBOARDING_COMPLETED,
        )),
        storage_failed: AtomicBool::new(storage_failed),
    });

    tray::create(app)?;
    hide_on_close(app.handle());
    apply_stored(app.handle(), &settings);

    if !std::env::args().any(|arg| arg == AUTOSTART_ARG) {
        show_entry(app.handle());
    }
    let recorder = crate::recording::manager_for_app(app.handle());
    app.manage(recorder.clone());
    // Runs for the app's whole life; needs no microphone access. No start
    // widget while recording.
    let watch = crate::audio::mic_watch::start_for_app(app.handle());
    watch.set_recording_probe(move || recorder.is_recording());
    app.manage(watch);
    Ok(())
}

/// Applies stored settings to the OS: overlay protection, global shortcuts
/// and, in a release build, autostart. Blocks on the main thread for the
/// shortcuts, so off the main thread it must run in a blocking task.
fn apply_stored<R: Runtime>(app: &AppHandle<R>, settings: &SettingsMap) {
    windows::protect_overlay(app, settings::flag(settings, settings::HIDE_ON_SHARE));
    let applied = shortcuts::apply(app, &settings::shortcuts(settings));
    for error in applied.errors {
        eprintln!(
            "grill: shortcut {} ({}) not registered: {}",
            error.action,
            error.keys.join(""),
            error.message
        );
    }
    // A debug build would register `target/debug` as the login item.
    #[cfg(not(debug_assertions))]
    sync_autostart(app, settings::flag(settings, settings::LAUNCH_AT_LOGIN));
}

/// The database opened on a retry ("Повторить"): its settings take effect
/// as at a normal start, and onboarding shows if it isn't done yet.
/// Blocks like [`apply_stored`].
pub fn storage_opened<R: Runtime>(app: &AppHandle<R>, settings: &SettingsMap) {
    let completed = settings::flag(settings, settings::ONBOARDING_COMPLETED);
    let entry = app.state::<Entry>();
    entry.storage_failed.store(false, Ordering::SeqCst);
    entry
        .onboarding_completed
        .store(completed, Ordering::SeqCst);
    apply_stored(app, settings);
    if !completed {
        windows::show(app, windows::ONBOARDING);
        windows::hide(app, windows::MAIN);
    }
}

/// Windows are declared once in the config, so closing one only hides it.
/// The app keeps running in the tray. A hidden window stops listening to
/// the level meters.
fn hide_on_close<R: Runtime>(app: &AppHandle<R>) {
    for label in [
        windows::MAIN,
        windows::ONBOARDING,
        windows::WIDGET,
        windows::OVERLAY,
    ] {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let target = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = target.hide();
                crate::audio::forget_window(target.app_handle(), target.label());
            }
            WindowEvent::Destroyed => {
                crate::audio::forget_window(target.app_handle(), target.label());
            }
            _ => {}
        });
    }
}

/// Keeps the app alive when the last window goes away; only "Выйти" exits.
/// On exit closes a running recording and stops the microphone watcher.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::Exit => {
            crate::recording::stop_on_exit(app);
            crate::audio::mic_watch::stop(app);
        }
        RunEvent::ExitRequested { api, .. }
            if !app.state::<QuitRequested>().0.load(Ordering::SeqCst) =>
        {
            api.prevent_exit();
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => show_entry(app),
        _ => {}
    }
}

#[cfg(not(debug_assertions))]
fn sync_autostart<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
    let autostart = app.autolaunch();
    if autostart.is_enabled().ok() != Some(enabled) {
        let result = if enabled {
            autostart.enable()
        } else {
            autostart.disable()
        };
        if let Err(error) = result {
            eprintln!("grill: failed to sync autostart: {error}");
        }
    }
}

/// Serializes `settings_update` (and the other writers of settings that
/// touch the OS): the database write and the OS effects of one update
/// finish before the next starts.
#[derive(Default)]
pub struct SettingsLock(pub tauri::async_runtime::Mutex<()>);

/// What applying a stored settings patch to the OS gave.
pub struct SettingsEffects {
    /// Keys to store again so the database says what the OS has: the
    /// effective shortcuts, the previous `launchAtLogin`. Empty when the OS
    /// took everything.
    pub corrections: SettingsMap,
    pub shortcut_errors: Vec<ShortcutError>,
    pub launch_at_login_error: Option<String>,
}

/// Applies the effects of a settings patch that is already stored. `before`
/// is what was stored before it. Blocks on the main thread (shortcuts), so
/// run it off it.
pub fn apply_settings<R: Runtime>(
    app: &AppHandle<R>,
    patch: &SettingsMap,
    before: &SettingsMap,
) -> SettingsEffects {
    let mut corrections = SettingsMap::new();
    let mut shortcut_errors = Vec::new();
    if patch.contains_key(settings::SHORTCUTS) {
        let requested = settings::shortcuts(patch);
        let applied = shortcuts::apply(app, &requested);
        shortcut_errors = applied.errors;
        if applied.effective != requested
            && let Ok(effective) = serde_json::to_value(applied.effective)
        {
            corrections.insert(settings::SHORTCUTS.to_owned(), effective);
        }
    }

    let mut launch_at_login_error = None;
    if let Some(enabled) = patch
        .get(settings::LAUNCH_AT_LOGIN)
        .and_then(Value::as_bool)
    {
        let autostart = app.autolaunch();
        let result = if enabled {
            autostart.enable()
        } else {
            autostart.disable()
        };
        if let Err(error) = result {
            launch_at_login_error = Some(format!("Не удалось изменить автозапуск: {error}"));
            let previous = before
                .get(settings::LAUNCH_AT_LOGIN)
                .cloned()
                .unwrap_or(Value::Bool(!enabled));
            corrections.insert(settings::LAUNCH_AT_LOGIN.to_owned(), previous);
        }
    }

    if let Some(protected) = patch.get(settings::HIDE_ON_SHARE).and_then(Value::as_bool) {
        windows::protect_overlay(app, protected);
    }
    SettingsEffects {
        corrections,
        shortcut_errors,
        launch_at_login_error,
    }
}
