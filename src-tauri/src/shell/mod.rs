//! How the app lives in the OS: windows, tray, autostart, global shortcuts,
//! single instance (design.md, decisions 1–6).

pub mod shortcuts;
pub mod tray;
pub mod windows;

use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tauri::{App, AppHandle, Manager, RunEvent, Runtime, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _;

use crate::{
    speech::{
        models::ModelManager,
        recognizer::Recognizer,
        refiner::{Refiner, RefinerConfig},
        service::{self, Speech},
    },
    storage::{
        Storage, retention,
        settings::{self, SettingsMap},
    },
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

    // The team's analytics (call-analytics design.md, decisions 6–7): only
    // a build with the server's address sends, and nothing of it shows.
    if let (Some(url), Some(dir), None) =
        (crate::analytics::url(), storage.data_dir(), storage.error())
    {
        match crate::analytics::sender::Sender::open(&url, &dir.join(crate::storage::DATABASE_FILE))
        {
            Ok(sender) => {
                let task = tauri::async_runtime::spawn(sender.run());
                app.manage(AnalyticsSender(task));
            }
            Err(error) => eprintln!("grill: the analytics are not sent: {error}"),
        }
    }
    app.manage(storage);
    // Connectors (connectors-outline): their secrets in Keychain / Credential
    // Manager. The connections are checked in the background a few seconds
    // after the start, never holding a window; a network failure is not a
    // revoked key.
    app.manage(crate::connectors::Connectors::for_app());
    let checking = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(crate::connectors::service::VERIFY_AFTER_START).await;
        if let Err(error) = crate::connectors::service::verify_all(&checking).await {
            eprintln!("grill: could not check the connectors: {error}");
        }
    });
    app.manage(QuitRequested::default());
    app.manage(crate::updates::Updates::default());
    crate::updates::start(app.handle());
    app.manage(shortcuts::Registered::default());
    app.manage(SettingsLock::default());
    // The microphones and the chosen one: every capture of «Я» opens it.
    let inputs = crate::audio::inputs_for_app(app.handle(), settings::microphone(&settings));
    app.manage(crate::audio::levels_for_app(app.handle(), &inputs));
    app.manage(inputs.clone());
    app.manage(crate::agent::AgentSessions::default());
    // Which projects have a brief build running (`briefState: building`).
    app.manage(crate::projects::builds::BriefBuilds::default());
    // One recognizer for the app; it runs the selected model once installed.
    let speech = Speech::new(Recognizer::whisper(None));
    let follow = speech.clone();
    let models = ModelManager::for_app(
        app.handle(),
        settings::speech_model(&settings),
        move |path| {
            follow.set_selected_model(path);
        },
    );
    speech.set_selected_model(models.selected_path());
    app.manage(models);
    app.manage(speech.clone());
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
    // The share of the subscription limit, before the loops: they stop at a
    // threshold of Grill (agent-limit-guard). Polled at the start and every
    // 10 minutes.
    let limit = crate::agent::limit::app::for_app(app.handle(), &settings);
    app.manage(limit.clone());
    crate::agent::limit::app::schedule_polls(app.handle());
    // Before the recorder: its live pass starts the agent's schedulers. The
    // slow loop shares the fast loop's halt and hears its topic changes.
    let fast_loop = crate::agent::fast_loop::app::for_app(app.handle(), &limit);
    app.manage(crate::agent::slow_loop::app::for_app(
        app.handle(),
        &fast_loop,
        &limit,
    ));
    app.manage(fast_loop);
    let recorder = crate::recording::manager_for_app(app.handle(), speech.recognizer(), &inputs);
    app.manage(recorder.clone());
    // The calls' summary builds; a finishing call starts one, and so does a
    // threshold of Grill that let go for the summaries that waited for it.
    let summary_builds = crate::summary::builds::SummaryBuilds::default();
    app.manage(summary_builds.clone());
    tauri::async_runtime::spawn(crate::summary::run::build_when_limit_lets_go(
        std::sync::Arc::new(app.handle().clone()),
        summary_builds,
        limit.clone(),
    ));
    // The call in progress records through the recorder; none at start
    // (the storage finished the calls a previous run left).
    let calls = crate::call::manager_for_app(app.handle(), recorder.clone(), speech.clone());
    app.manage(calls.clone());
    // After the recorder: it pauses while recording. Queues what a previous
    // run left unrefined.
    app.manage(Refiner::start(
        service::app_host(app.handle()),
        speech.recognizer(),
        RefinerConfig::default(),
    ));
    // The decoded WAVs and peaks of the player (post-call task 3.4).
    let cache_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    app.manage(crate::records::audio::AudioCache::for_app(&cache_dir));
    // The retention periods: 30 s after the start, then once a day.
    schedule_retention(app.handle());
    // Runs for the app's whole life; needs no microphone access. No start
    // widget (and no new call) during a call or a recording.
    let watch = crate::audio::mic_watch::start_for_app(app.handle());
    watch.set_recording_probe(move || recorder.is_recording() || calls.is_active());
    app.manage(watch);
    Ok(())
}

/// Runs the retention periods (settings-real design.md, decision 5) in the
/// background: [`retention::FIRST_AFTER`] after the start, never holding a
/// window, then every [`retention::EVERY`].
fn schedule_retention<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(retention::FIRST_AFTER).await;
        loop {
            purge_by_retention(&app).await;
            tokio::time::sleep(retention::EVERY).await;
        }
    });
}

async fn purge_by_retention<R: Runtime>(app: &AppHandle<R>) {
    let Some(storage) = app.try_state::<Storage>() else {
        return;
    };
    let refiner = app
        .try_state::<Refiner>()
        .map(|refiner| refiner.inner().clone());
    let cache = app
        .try_state::<crate::records::audio::AudioCache>()
        .map(|cache| cache.inner().clone());
    let stop_refining = move |id: &str| {
        if let Some(refiner) = &refiner {
            refiner.stop(id);
        }
    };
    let forget_audio = move |id: &str| {
        if let Some(cache) = &cache {
            cache.forget(id);
        }
    };
    let host = retention::PassHost {
        store: storage
            .recording_store()
            .map(|store| store as std::sync::Arc<dyn crate::recording::store::RecordingStore>),
        stop_refining: &stop_refining,
        forget_audio: &forget_audio,
    };
    match retention::run(&storage, app, &host, crate::storage::now_ms()).await {
        Ok(purged) if !purged.is_empty() => eprintln!(
            "grill: retention deleted the audio of {} and the transcript of {} recording(s)",
            purged.audio.len(),
            purged.transcripts.len()
        ),
        Ok(_) => {}
        Err(error) => eprintln!("grill: retention pass failed: {error}"),
    }
}

/// Applies stored settings to the OS: the theme, overlay protection, global
/// shortcuts and, in a release build, autostart. Blocks on the main thread for the
/// shortcuts, so off the main thread it must run in a blocking task.
fn apply_stored<R: Runtime>(app: &AppHandle<R>, settings: &SettingsMap) {
    windows::apply_theme(app, settings::theme(settings));
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
                forget_window(target.app_handle(), target.label());
            }
            WindowEvent::Destroyed => {
                forget_window(target.app_handle(), target.label());
            }
            _ => {}
        });
    }
}

/// A closed window stops listening to the meters and cancels its hardware
/// check.
fn forget_window<R: Runtime>(app: &AppHandle<R>, label: &str) {
    crate::audio::forget_window(app, label);
    if let Some(speech) = app.try_state::<Speech>() {
        speech.cancel_check(Some(label), None);
    }
}

/// The task that sends the analytics queue, while the app runs.
struct AnalyticsSender(tauri::async_runtime::JoinHandle<()>);

/// What the app stops on its way out: on `RunEvent::Exit`, and before the
/// Windows update installer ends the process without one.
pub fn shutdown<R: Runtime>(app: &AppHandle<R>) {
    // First: the agent's CLI runs in its own process group and would
    // outlive the app.
    if let Some(fast_loop) = app.try_state::<crate::agent::fast_loop::scheduler::FastLoop>() {
        fast_loop.shutdown();
    }
    if let Some(slow_loop) = app.try_state::<crate::agent::slow_loop::scheduler::SlowLoop>() {
        slow_loop.shutdown();
    }
    if let Some(limit) = app.try_state::<crate::agent::limit::SubscriptionLimit>() {
        limit.shutdown();
    }
    if let Some(builds) = app.try_state::<crate::projects::builds::BriefBuilds>() {
        builds.shutdown();
    }
    if let Some(builds) = app.try_state::<crate::summary::builds::SummaryBuilds>() {
        builds.shutdown();
    }
    crate::recording::stop_on_exit(app);
    crate::audio::mic_watch::stop(app);
    // The queue stays in the database for the next start.
    if let Some(sender) = app.try_state::<AnalyticsSender>() {
        sender.0.abort();
    }
    if let Some(cache) = app.try_state::<crate::records::audio::AudioCache>() {
        cache.clear();
    }
}

/// Keeps the app alive when the last window goes away; only "Выйти" exits.
/// On exit stops the agent's calls (killing its CLI), closes a running
/// recording and stops the microphone watcher.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    match event {
        RunEvent::Exit => shutdown(app),
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
    if patch.contains_key(settings::THEME) {
        windows::apply_theme(app, settings::theme(patch));
    }
    SettingsEffects {
        corrections,
        shortcut_errors,
        launch_at_login_error,
    }
}
