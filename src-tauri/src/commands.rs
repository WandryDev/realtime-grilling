//! Tauri commands. Each is async: the database work runs in `spawn_blocking`
//! (see `Storage::read` / `Storage::write`), and a write sends
//! `DataChanged` only after its transaction committed.
//!
//! Adding a command: register it in `bindings::builder` and in
//! `command_names.rs`, and allow it in `capabilities/*.json`.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_specta::Event;

use crate::{
    agent::{
        self, AgentSessions, AgentState,
        discover::SearchEnv,
        install::{self, AgentInstallProgress},
        login,
    },
    audio::{
        AudioLevels, AudioSource,
        mic_watch::{MicActivityChanged, MicWatch},
    },
    error::{CommandError, CommandResult},
    events::Navigate,
    permissions::{self, PermissionKind, PermissionStatus, Permissions},
    recording::{RecordingManager, status::RecordingStatus},
    shell::{self, SettingsLock, shortcuts::ShortcutError, windows},
    speech::{
        benchmark::{self, BenchmarkFailure, BenchmarkResult, Thresholds},
        check, mic_check,
        models::{ErrorReason, ModelId, ModelManager, SpeechModel},
        service::Speech,
    },
    storage::{
        Storage,
        calls::{self, Call, CallCreate, CallUpdate},
        people::{self, Person, PersonCreate, PersonUpdate},
        projects::{self, Project, ProjectCreate, ProjectUpdate},
        questions::{self, Question, QuestionCreate, QuestionUpdate},
        recordings::RecordingLinks,
        settings::{self, SettingsMap},
        task_cards::{self, TaskCard, TaskCardCreate, TaskCardUpdate},
        topics::{self, Topic, TopicCreate, TopicUpdate},
        transcript::{self, TranscriptSegment},
    },
};

/* Projects */

#[tauri::command]
#[specta::specta]
pub async fn projects_list(storage: State<'_, Storage>) -> CommandResult<Vec<Project>> {
    storage.read(projects::list).await
}

#[tauri::command]
#[specta::specta]
pub async fn projects_get(storage: State<'_, Storage>, id: String) -> CommandResult<Project> {
    storage.read(move |db| projects::get(db, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn projects_create(
    app: AppHandle,
    storage: State<'_, Storage>,
    input: ProjectCreate,
) -> CommandResult<Project> {
    storage
        .write(&app, move |db| projects::create(db, input))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn projects_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: ProjectUpdate,
) -> CommandResult<Project> {
    storage
        .write(&app, move |db| projects::update(db, &id, patch))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn projects_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    storage
        .write(&app, move |db| projects::delete(db, &id))
        .await?;
    // The project's calls took their recordings with them; now their files.
    storage.sweep_recordings().await;
    Ok(())
}

/* People */

#[tauri::command]
#[specta::specta]
pub async fn people_list(
    storage: State<'_, Storage>,
    project_id: String,
) -> CommandResult<Vec<Person>> {
    storage.read(move |db| people::list(db, &project_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn people_get(storage: State<'_, Storage>, id: String) -> CommandResult<Person> {
    storage.read(move |db| people::get(db, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn people_create(
    app: AppHandle,
    storage: State<'_, Storage>,
    input: PersonCreate,
) -> CommandResult<Person> {
    storage
        .write(&app, move |db| people::create(db, input))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn people_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: PersonUpdate,
) -> CommandResult<Person> {
    storage
        .write(&app, move |db| people::update(db, &id, patch))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn people_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    storage.write(&app, move |db| people::delete(db, &id)).await
}

/* Calls and participants */

/// Calls of a project, or all calls when `projectId` is `null`; newest first.
#[tauri::command]
#[specta::specta]
pub async fn calls_list(
    storage: State<'_, Storage>,
    project_id: Option<String>,
) -> CommandResult<Vec<Call>> {
    storage
        .read(move |db| calls::list(db, project_id.as_deref()))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn calls_get(storage: State<'_, Storage>, id: String) -> CommandResult<Call> {
    storage.read(move |db| calls::get(db, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn calls_create(
    app: AppHandle,
    storage: State<'_, Storage>,
    input: CallCreate,
) -> CommandResult<Call> {
    storage
        .write(&app, move |db| calls::create(db, input))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn calls_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: CallUpdate,
) -> CommandResult<Call> {
    storage
        .write(&app, move |db| calls::update(db, &id, patch))
        .await
}

/// Applies an RFC 7386 JSON merge patch to the call's `summary` in one
/// transaction: only the keys in `patch` change, `null` removes a key.
#[tauri::command]
#[specta::specta]
pub async fn calls_patch_summary(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: Value,
) -> CommandResult<Call> {
    storage
        .write(&app, move |db| calls::patch_summary(db, &id, &patch))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn calls_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    storage
        .write(&app, move |db| calls::delete(db, &id))
        .await?;
    // The call's recordings went with it; now their files.
    storage.sweep_recordings().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn call_participants_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<Person>> {
    storage
        .read(move |db| calls::participants(db, &call_id))
        .await
}

/// Adds a person of the call's project; another project's person is `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn call_participants_add(
    app: AppHandle,
    storage: State<'_, Storage>,
    call_id: String,
    person_id: String,
) -> CommandResult<Call> {
    storage
        .write(&app, move |db| {
            calls::add_participant(db, &call_id, &person_id)
        })
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn call_participants_remove(
    app: AppHandle,
    storage: State<'_, Storage>,
    call_id: String,
    person_id: String,
) -> CommandResult<Call> {
    storage
        .write(&app, move |db| {
            calls::remove_participant(db, &call_id, &person_id)
        })
        .await
}

/* Topics */

#[tauri::command]
#[specta::specta]
pub async fn topics_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<Topic>> {
    storage.read(move |db| topics::list(db, &call_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn topics_get(storage: State<'_, Storage>, id: String) -> CommandResult<Topic> {
    storage.read(move |db| topics::get(db, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn topics_create(
    app: AppHandle,
    storage: State<'_, Storage>,
    input: TopicCreate,
) -> CommandResult<Topic> {
    storage
        .write(&app, move |db| topics::create(db, input))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn topics_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: TopicUpdate,
) -> CommandResult<Topic> {
    storage
        .write(&app, move |db| topics::update(db, &id, patch))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn topics_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    storage.write(&app, move |db| topics::delete(db, &id)).await
}

/* Task cards */

#[tauri::command]
#[specta::specta]
pub async fn task_cards_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<TaskCard>> {
    storage.read(move |db| task_cards::list(db, &call_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn task_cards_get(storage: State<'_, Storage>, id: String) -> CommandResult<TaskCard> {
    storage.read(move |db| task_cards::get(db, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn task_cards_create(
    app: AppHandle,
    storage: State<'_, Storage>,
    input: TaskCardCreate,
) -> CommandResult<TaskCard> {
    storage
        .write(&app, move |db| task_cards::create(db, input))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn task_cards_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: TaskCardUpdate,
) -> CommandResult<TaskCard> {
    storage
        .write(&app, move |db| task_cards::update(db, &id, patch))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn task_cards_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    storage
        .write(&app, move |db| task_cards::delete(db, &id))
        .await
}

/* Questions */

#[tauri::command]
#[specta::specta]
pub async fn questions_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<Question>> {
    storage.read(move |db| questions::list(db, &call_id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn questions_get(storage: State<'_, Storage>, id: String) -> CommandResult<Question> {
    storage.read(move |db| questions::get(db, &id)).await
}

#[tauri::command]
#[specta::specta]
pub async fn questions_create(
    app: AppHandle,
    storage: State<'_, Storage>,
    input: QuestionCreate,
) -> CommandResult<Question> {
    storage
        .write(&app, move |db| questions::create(db, input))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn questions_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    patch: QuestionUpdate,
) -> CommandResult<Question> {
    storage
        .write(&app, move |db| questions::update(db, &id, patch))
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn questions_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    storage
        .write(&app, move |db| questions::delete(db, &id))
        .await
}

/* Transcript */

// Only the backend writes the transcript (speech recognition).

/// The transcripts of a call's recordings, recording after recording, both
/// channels in time order; refined where the second pass is done.
#[tauri::command]
#[specta::specta]
pub async fn transcript_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<TranscriptSegment>> {
    storage
        .read(move |db| transcript::for_call(db, &call_id))
        .await
}

/// The transcript of a recording, both channels in time order: the refined
/// pass if there is one, else the live pass. `NotFound` for an unknown
/// recording.
#[tauri::command]
#[specta::specta]
pub async fn transcript_for_recording(
    storage: State<'_, Storage>,
    recording_id: String,
) -> CommandResult<Vec<TranscriptSegment>> {
    storage
        .read(move |db| transcript::for_recording(db, &recording_id))
        .await
}

/* Settings */

/// Stored preferences over the defaults of the keys Rust acts on
/// (`onboardingCompleted`, `launchAtLogin`, `hideOnShare`, `shortcuts`,
/// `micBusyBehavior`).
/// The frontend merges the result over its own defaults.
#[tauri::command]
#[specta::specta]
pub async fn settings_get(storage: State<'_, Storage>) -> CommandResult<SettingsMap> {
    storage.read(settings::get).await
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdateResult {
    /// All preferences after the update, as `settings_get` returns them.
    pub settings: SettingsMap,
    /// Shortcuts the OS did not register. Each keeps its previous keys
    /// (stored and active); the other shortcuts are applied.
    pub shortcut_errors: Vec<ShortcutError>,
    /// Why "Запускать при входе в систему" could not change; the stored
    /// value then stays as it was.
    pub launch_at_login_error: Option<String>,
}

/// Writes the given keys and applies their effects: `launchAtLogin`
/// (autostart), `hideOnShare` (overlay hidden from screen sharing),
/// `shortcuts` (global shortcuts), `onboardingCompleted`.
///
/// `shortcuts` changes only the actions it names. Updates run one at a time.
/// The database is written first, so a failed write leaves the OS as it
/// was; what the OS then refuses is stored back to what it has.
#[tauri::command]
#[specta::specta]
pub async fn settings_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    lock: State<'_, SettingsLock>,
    models: State<'_, ModelManager>,
    recorder: State<'_, RecordingManager>,
    patch: SettingsMap,
) -> CommandResult<SettingsUpdateResult> {
    settings::validate(&patch)?;
    let _one_at_a_time = lock.0.lock().await;
    // As `speech_model_select`: a ready model, not changed while recording.
    let model = patch
        .contains_key(settings::SPEECH_MODEL)
        .then(|| settings::speech_model(&patch));
    if let Some(model) = model {
        models.check_select(model, recorder.is_recording())?;
    }
    let (before, stored) = storage
        .write(&app, move |db| {
            let before = settings::get(db)?;
            let patch = settings::merge_shortcuts(&before, patch);
            let events = settings::put(db, &patch)?;
            Ok(((before, patch), events))
        })
        .await?;
    let handle = app.clone();
    let effects = tauri::async_runtime::spawn_blocking(move || {
        shell::apply_settings(&handle, &stored, &before)
    })
    .await
    .map_err(|error| CommandError::storage(error.to_string()))?;
    let corrections = effects.corrections;
    let settings = storage
        .write(&app, move |db| {
            let events = settings::put(db, &corrections)?;
            Ok((settings::get(db)?, events))
        })
        .await?;
    shell::remember_onboarding(
        &app,
        settings::flag(&settings, settings::ONBOARDING_COMPLETED),
    );
    if model.is_some() {
        models.set_selected(settings::speech_model(&settings));
    }
    Ok(SettingsUpdateResult {
        settings,
        shortcut_errors: effects.shortcut_errors,
        launch_at_login_error: effects.launch_at_login_error,
    })
}

/// "Готово" on the last onboarding step: remembers it, hides onboarding and
/// shows the main window.
#[tauri::command]
#[specta::specta]
pub async fn onboarding_complete(
    app: AppHandle,
    storage: State<'_, Storage>,
    lock: State<'_, SettingsLock>,
) -> CommandResult<()> {
    let patch = SettingsMap::from([(settings::ONBOARDING_COMPLETED.to_owned(), Value::Bool(true))]);
    let _one_at_a_time = lock.0.lock().await;
    storage
        .write(&app, move |db| Ok(((), settings::put(db, &patch)?)))
        .await?;
    shell::remember_onboarding(&app, true);
    windows::show(&app, windows::MAIN);
    windows::hide(&app, windows::ONBOARDING);
    Ok(())
}

/* Windows and storage */

/// A window a screen can hand over to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WindowLabel {
    Main,
    Widget,
    Overlay,
}

impl WindowLabel {
    fn label(self) -> &'static str {
        match self {
            Self::Main => windows::MAIN,
            Self::Widget => windows::WIDGET,
            Self::Overlay => windows::OVERLAY,
        }
    }
}

/// Shows, restores and focuses a window and, with `route`, opens that route
/// in it (`Navigate`). The floating windows hand over through it: the start
/// widget to the overlay, both to the main window for the call window, the
/// summary or "Открыть Grill". The caller hides itself.
#[tauri::command]
#[specta::specta]
pub fn windows_show(
    app: AppHandle,
    label: WindowLabel,
    route: Option<String>,
) -> CommandResult<()> {
    let label = label.label();
    if let Some(route) = route {
        if !route.starts_with('/') {
            return Err(CommandError::invalid(format!(
                "Маршрут окна должен начинаться с «/»: {route}"
            )));
        }
        Navigate { route }
            .emit_to(&app, label)
            .map_err(|error| CommandError::storage(error.to_string()))?;
    }
    windows::show(&app, label);
    Ok(())
}

/// "Повторить" on the storage error screen: opens and migrates the database
/// again if it failed at start. `Storage` with the reason when it still
/// fails. On success its settings take effect as at a normal start.
#[tauri::command]
#[specta::specta]
pub async fn storage_reopen(
    app: AppHandle,
    storage: State<'_, Storage>,
    lock: State<'_, SettingsLock>,
    models: State<'_, ModelManager>,
) -> CommandResult<()> {
    let _one_at_a_time = lock.0.lock().await;
    if storage.error().is_none() {
        return Ok(());
    }
    storage.reopen().await?;
    let settings = storage.read(settings::get).await?;
    models.set_selected(settings::speech_model(&settings));
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || shell::storage_opened(&handle, &settings))
        .await
        .map_err(|error| CommandError::storage(error.to_string()))
}

/* OS permissions */

/// The microphone and system audio access, without any prompt.
#[tauri::command]
#[specta::specta]
pub async fn permissions_get() -> CommandResult<Permissions> {
    permissions::blocking(permissions::all).await
}

/// "Разрешить": shows the system prompt where the OS has one and returns
/// the state after the user's answer. A `denied` access stays `denied`
/// (Windows opens the privacy settings for the microphone).
#[tauri::command]
#[specta::specta]
pub async fn permission_request(
    app: AppHandle,
    kind: PermissionKind,
) -> CommandResult<PermissionStatus> {
    permissions::request(&app, kind).await
}

/// "Открыть настройки": the settings page of the access (the URL is
/// chosen here, never by the frontend).
#[tauri::command]
#[specta::specta]
pub fn permission_open_settings(app: AppHandle, kind: PermissionKind) -> CommandResult<()> {
    permissions::open_settings(&app, kind)
}

/* Agent CLI */

/// Where the agent CLI runs: the app's data folder, never a project.
fn agent_workdir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!("grill: failed to create {}: {error}", dir.display());
    }
    dir
}

async fn agent_cli(app: &AppHandle, storage: &Storage) -> CommandResult<PathBuf> {
    agent::locate(storage, app, &SearchEnv::from_process())
        .await
        .ok_or_else(|| CommandError::not_found("Claude Code не установлен"))
}

/// Finds the CLI (saving `agentPath`), then its version and login. Never
/// calls the model; a CLI that hangs is `error`.
#[tauri::command]
#[specta::specta]
pub async fn agent_status(
    app: AppHandle,
    storage: State<'_, Storage>,
) -> CommandResult<AgentState> {
    let cwd = agent_workdir(&app);
    Ok(agent::locate_and_check(&storage, &app, &SearchEnv::from_process(), &cwd).await)
}

/// "Установить": runs the official installer with `AgentInstallProgress`
/// to the calling window, then checks the status. A failed install is
/// `External` whose message is a summary line, a blank line and the
/// installer's output (for "Скопировать для поддержки"). After
/// `agent_install_cancel` it resolves to the status.
#[tauri::command]
#[specta::specta]
pub async fn agent_install(
    app: AppHandle,
    window: WebviewWindow,
    storage: State<'_, Storage>,
    sessions: State<'_, AgentSessions>,
) -> CommandResult<AgentState> {
    let cancelled = sessions.begin_install()?;
    let cwd = agent_workdir(&app);
    let label = window.label().to_owned();
    let handle = app.clone();
    let outcome = install::run(
        &install::Installer::official(),
        &cwd,
        install::INSTALL_TIMEOUT,
        cancelled,
        move |stage| {
            if let Err(error) = AgentInstallProgress::from(stage).emit_to(&handle, label.as_str()) {
                eprintln!("grill: failed to emit install progress: {error}");
            }
        },
    )
    .await;
    match outcome {
        install::Outcome::Cancelled => {
            Ok(agent::locate_and_check(&storage, &app, &SearchEnv::from_process(), &cwd).await)
        }
        install::Outcome::Failed { message } => Err(CommandError::external(message)),
        install::Outcome::Installed { log } => {
            let state =
                agent::locate_and_check(&storage, &app, &SearchEnv::from_process(), &cwd).await;
            if state == AgentState::NotInstalled {
                return Err(CommandError::external(format!(
                    "Установщик завершился, но Claude Code не найден\n\n{log}"
                )));
            }
            Ok(state)
        }
    }
}

/// Stops a running install (kills the installer); nothing when none runs.
#[tauri::command]
#[specta::specta]
pub fn agent_install_cancel(sessions: State<'_, AgentSessions>) -> CommandResult<()> {
    sessions.cancel_install();
    Ok(())
}

/// "Войти": starts `claude auth login --claudeai` (it opens the browser
/// itself) and returns the sign-in link for "Открыть страницу ещё раз".
/// A login in progress is replaced. `NotFound` without the CLI (or when
/// `agent_login_cancel` came while the CLI was starting; it is killed),
/// `External` when the CLI shows no link within 15 s. Unfinished, it stops
/// after 10 min.
#[tauri::command]
#[specta::specta]
pub async fn agent_login_start(
    app: AppHandle,
    storage: State<'_, Storage>,
    sessions: State<'_, AgentSessions>,
) -> CommandResult<String> {
    let id = sessions.begin_login();
    drop(sessions.login.lock().await.take());
    let cli = agent_cli(&app, &storage).await?;
    let session = login::start(&cli, &agent_workdir(&app), id, login::URL_TIMEOUT).await?;
    let url = session.url().to_owned();
    sessions.keep_login(session).await?;
    login::expire_later(&sessions.login, id, login::SESSION_TIMEOUT);
    Ok(url)
}

/// "Подтвердить": passes the code from the browser to the CLI and returns
/// the status. A code it refused is `Invalid` ("Код не подошёл"); the
/// login is then over and "Войти" starts a new one. Without a login
/// waiting for a code (never started, cancelled, expired, or after a wrong
/// code) it is `NotFound` ("Вход не начат или истёк"). The code is not
/// kept or logged.
#[tauri::command]
#[specta::specta]
pub async fn agent_login_submit(
    app: AppHandle,
    storage: State<'_, Storage>,
    sessions: State<'_, AgentSessions>,
    code: String,
) -> CommandResult<AgentState> {
    let code = code.trim();
    if code.is_empty() || code.contains(['\n', '\r']) {
        return Err(CommandError::invalid("Вставьте код из браузера"));
    }
    let session = sessions.take_login().await?;
    let cli = agent_cli(&app, &storage).await?;
    agent::finish_login(session, code, &cli, &agent_workdir(&app)).await
}

/// "Отменить": stops the login in progress (or still starting), if any.
#[tauri::command]
#[specta::specta]
pub async fn agent_login_cancel(sessions: State<'_, AgentSessions>) -> CommandResult<()> {
    sessions.cancel_login().await;
    Ok(())
}

/// "Перезапустить": macOS shows a system audio access granted in this
/// process only after a restart.
#[tauri::command]
#[specta::specta]
pub fn app_restart(app: AppHandle) -> CommandResult<()> {
    shell::QuitRequested::restart(&app)
}

/* Level meters */

/// Subscribes the calling window to `AudioLevel` of a source, opening the
/// device if no window listens to it yet. `External` with `reason`
/// `noAccess` / `noDevice` / `busy` when it can't be opened.
#[tauri::command]
#[specta::specta]
pub async fn audio_level_start(
    window: WebviewWindow,
    levels: State<'_, AudioLevels>,
    source: AudioSource,
) -> CommandResult<()> {
    let label = window.label().to_owned();
    let levels = levels.inner().clone();
    permissions::blocking(move || levels.start(&label, source)).await?
}

/// Ends the calling window's subscription; the last one releases the
/// device. Hiding or closing a window ends its subscriptions too.
#[tauri::command]
#[specta::specta]
pub async fn audio_level_stop(
    window: WebviewWindow,
    levels: State<'_, AudioLevels>,
    source: AudioSource,
) -> CommandResult<()> {
    let label = window.label().to_owned();
    let levels = levels.inner().clone();
    permissions::blocking(move || levels.stop(&label, source)).await
}

/* Microphone activity */

/// Whether another app uses the microphone now, as the last
/// `MicActivityChanged` said: a window opened during a call sees "busy".
#[tauri::command]
#[specta::specta]
pub fn mic_activity_get(watch: State<'_, MicWatch>) -> CommandResult<MicActivityChanged> {
    Ok(watch.current())
}

/* Recording */

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStart {
    /// The call being recorded; a recording without a call is fine.
    #[specta(optional)]
    pub call_id: Option<String>,
    /// The project of the call (the call's project when omitted).
    #[specta(optional)]
    pub project_id: Option<String>,
    /// The client's people on the call, people of `projectId`.
    #[specta(optional)]
    pub participant_ids: Option<Vec<String>>,
}

impl From<RecordingStart> for RecordingLinks {
    fn from(input: RecordingStart) -> Self {
        Self {
            call_id: input.call_id,
            project_id: input.project_id,
            participant_ids: input.participant_ids.unwrap_or_default(),
        }
    }
}

/// Starts recording both channels and returns the recording's id (UUID v7).
/// While a recording runs, returns its id and opens nothing. Without
/// microphone access: `External` with `reason: noAccess`, nothing stored.
/// Without system audio access the recording goes on with "Я" only.
///
/// Unknown call, project or person: `NotFound`. A participant of another
/// project, participants without a project, or a project other than the
/// call's: `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn recording_start(
    recorder: State<'_, RecordingManager>,
    input: RecordingStart,
) -> CommandResult<String> {
    let recorder = recorder.inner().clone();
    permissions::blocking(move || recorder.start(&input.into())).await?
}

/// Stops the recording `id`: the files are closed and the devices released.
/// An already stopped recording stays as it is; an unknown id is `NotFound`.
#[tauri::command]
#[specta::specta]
pub async fn recording_stop(
    recorder: State<'_, RecordingManager>,
    id: String,
) -> CommandResult<()> {
    let recorder = recorder.inner().clone();
    permissions::blocking(move || recorder.stop(&id)).await?
}

/// The recording now, as the last `RecordingChanged` said: a window opened
/// during a recording sees it at once.
#[tauri::command]
#[specta::specta]
pub fn recording_status(recorder: State<'_, RecordingManager>) -> CommandResult<RecordingStatus> {
    Ok(recorder.status())
}

/* Speech models */

/// Both models (turbo, then small) with their download size, state and
/// whether `speechModel` names them. Files deleted by hand are noticed here.
#[tauri::command]
#[specta::specta]
pub async fn speech_models_list(
    models: State<'_, ModelManager>,
) -> CommandResult<Vec<SpeechModel>> {
    Ok(models.list())
}

/// "Скачать" / "Продолжить": starts the download in the background, or
/// resumes it from the `.part`, and returns the model at once; progress
/// comes in `SpeechModelChanged`. A ready or downloading model stays as it
/// is. Without room for the rest of the file plus 10 % of the model the
/// model becomes `noSpace` and nothing is downloaded.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_download(
    models: State<'_, ModelManager>,
    id: ModelId,
) -> CommandResult<SpeechModel> {
    Ok(models.download(id))
}

/// "Пауза": stops the download and keeps what is downloaded. Resolves once
/// it stopped.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_pause(
    models: State<'_, ModelManager>,
    id: ModelId,
) -> CommandResult<SpeechModel> {
    Ok(models.pause(id).await)
}

/// "Отменить": stops the download, also a paused one, and deletes the
/// unfinished file. A ready model stays.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_cancel(
    models: State<'_, ModelManager>,
    id: ModelId,
) -> CommandResult<SpeechModel> {
    models.cancel(id).await
}

/// "Удалить": deletes the model's files (a download in progress stops, a
/// hardware check of it is cancelled, the recognizer lets go of it first).
/// The selected model can't be removed while recording: `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_remove(
    models: State<'_, ModelManager>,
    recorder: State<'_, RecordingManager>,
    speech: State<'_, Speech>,
    id: ModelId,
) -> CommandResult<SpeechModel> {
    let recording = recorder.is_recording();
    speech.cancel_check(None, Some(id));
    if models.selected() == id && !recording {
        let speech = speech.inner().clone();
        permissions::blocking(move || speech.unload()).await?;
    }
    let removed = models.remove(id, recording).await;
    // A failed removal leaves the model installed: the recognizer gets it
    // back.
    speech.set_selected_model(models.selected_path());
    removed
}

/// Recognize with this model: stores `speechModel` (`DataChanged` of the
/// settings, `SpeechModelChanged` of both models). Only a ready model
/// (`Invalid` otherwise); while recording only the model already selected.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_select(
    app: AppHandle,
    storage: State<'_, Storage>,
    lock: State<'_, SettingsLock>,
    models: State<'_, ModelManager>,
    recorder: State<'_, RecordingManager>,
    id: ModelId,
) -> CommandResult<SpeechModel> {
    let _one_at_a_time = lock.0.lock().await;
    models.check_select(id, recorder.is_recording())?;
    let patch = SettingsMap::from([(
        settings::SPEECH_MODEL.to_owned(),
        Value::String(id.as_str().to_owned()),
    )]);
    storage
        .write(&app, move |db| Ok(((), settings::put(db, &patch)?)))
        .await?;
    models.set_selected(id);
    Ok(models.get(id))
}

/* Speech checks */

/// The hardware check of an installed model (speech-recognition design.md
/// decision 14): the bundled phrases at the pace of a call. The result is
/// also stored in `speechBenchmark[model]` with `checkedAt` (`DataChanged`
/// of the settings); a model that is not installed is `noModel` and nothing
/// is stored. One check at a time, never while recording (`Invalid`).
/// `speech_benchmark_cancel` or closing the window ends it with `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn speech_benchmark(
    app: AppHandle,
    window: WebviewWindow,
    models: State<'_, ModelManager>,
    recorder: State<'_, RecordingManager>,
    speech: State<'_, Speech>,
    model: ModelId,
) -> CommandResult<BenchmarkResult> {
    if recorder.is_recording() {
        return Err(CommandError::invalid(
            "Проверку нельзя запустить во время записи",
        ));
    }
    let Some(path) = models.model_path(model) else {
        return Ok(BenchmarkResult::not_run(BenchmarkFailure::NoModel));
    };
    let dir = check::bundled_dir(&app);
    let set = permissions::blocking(move || check::load(&dir))
        .await?
        .map_err(|error| CommandError::storage(error.to_string()))?;
    let guard = speech.begin_check(model, Some(path), window.label())?;
    let outcome = benchmark::run(
        &speech.recognizer(),
        &set,
        &Thresholds::default(),
        1.0,
        guard.cancelled.clone(),
    )
    .await;
    drop(guard);
    let Ok(result) = outcome else {
        return Err(CommandError::invalid("Проверка отменена"));
    };
    if result.reason == Some(BenchmarkFailure::ModelFailed) {
        models.set_error(model, ErrorReason::Load, "Модель не загрузилась");
    }
    let mut entry = serde_json::to_value(result)?;
    entry["checkedAt"] = Value::from(crate::storage::now_ms());
    let lock = app.state::<SettingsLock>();
    let _one_at_a_time = lock.0.lock().await;
    app.state::<Storage>()
        .write(&app, move |db| {
            let mut checks = settings::get(db)?
                .remove(settings::SPEECH_BENCHMARK)
                .filter(Value::is_object)
                .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
            checks[model.as_str()] = entry;
            let patch = SettingsMap::from([(settings::SPEECH_BENCHMARK.to_owned(), checks)]);
            Ok(((), settings::put(db, &patch)?))
        })
        .await?;
    Ok(result)
}

/// Cancels the calling window's hardware check; nothing when none runs.
#[tauri::command]
#[specta::specta]
pub fn speech_benchmark_cancel(
    window: WebviewWindow,
    speech: State<'_, Speech>,
) -> CommandResult<()> {
    speech.cancel_check(Some(window.label()), None);
    Ok(())
}

/// The mic check of onboarding (decision 15): up to 8 s from the default
/// input, ended early by the end of a phrase, recognized in the call
/// language with the selected model. Nothing is stored. Empty text when
/// nothing was said. `Invalid` without an installed model, `External` with
/// `reason` when the microphone can't be used.
#[tauri::command]
#[specta::specta]
pub async fn speech_mic_check(
    app: AppHandle,
    storage: State<'_, Storage>,
    models: State<'_, ModelManager>,
    speech: State<'_, Speech>,
) -> CommandResult<String> {
    if models.selected_path().is_none() {
        return Err(CommandError::invalid("Модель распознавания не скачана"));
    }
    let language = storage
        .read(|db| Ok(settings::call_language(&settings::get(db)?)))
        .await
        .unwrap_or_default();
    let vad_model = crate::vad::bundled_model_path(&app);
    let audio =
        permissions::blocking(move || mic_check::listen_to_microphone(&vad_model)).await??;
    mic_check::recognize(&speech.recognizer(), audio, language).await
}
