//! Tauri commands. Each is async: the database work runs in `spawn_blocking`
//! (see `Storage::read` / `Storage::write`), and a write sends
//! `DataChanged` only after its transaction committed.
//!
//! Adding a command: register it in `bindings::builder` and in
//! `command_names.rs`, and allow it in `capabilities/*.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, State};
use tauri_specta::Event;

use crate::{
    error::{CommandError, CommandResult},
    events::Navigate,
    shell::{self, SettingsLock, shortcuts::ShortcutError, windows},
    storage::{
        Storage,
        calls::{self, Call, CallCreate, CallUpdate},
        people::{self, Person, PersonCreate, PersonUpdate},
        projects::{self, Project, ProjectCreate, ProjectUpdate},
        questions::{self, Question, QuestionCreate, QuestionUpdate},
        settings::{self, SettingsMap},
        task_cards::{self, TaskCard, TaskCardCreate, TaskCardUpdate},
        topics::{self, Topic, TopicCreate, TopicUpdate},
        transcript::{self, SegmentInput, TranscriptSegment},
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
        .await
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
    storage.write(&app, move |db| calls::delete(db, &id)).await
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

/// Both channels of a call in time order.
#[tauri::command]
#[specta::specta]
pub async fn transcript_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<TranscriptSegment>> {
    storage.read(move |db| transcript::list(db, &call_id)).await
}

/// Adds a batch of segments with one `transcript` event.
#[tauri::command]
#[specta::specta]
pub async fn transcript_append(
    app: AppHandle,
    storage: State<'_, Storage>,
    call_id: String,
    segments: Vec<SegmentInput>,
) -> CommandResult<Vec<TranscriptSegment>> {
    storage
        .write(&app, move |db| transcript::append(db, &call_id, segments))
        .await
}

/* Settings */

/// Stored preferences over the defaults of the keys Rust acts on
/// (`onboardingCompleted`, `launchAtLogin`, `hideOnShare`, `shortcuts`).
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
    patch: SettingsMap,
) -> CommandResult<SettingsUpdateResult> {
    settings::validate(&patch)?;
    let _one_at_a_time = lock.0.lock().await;
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
) -> CommandResult<()> {
    let _one_at_a_time = lock.0.lock().await;
    if storage.error().is_none() {
        return Ok(());
    }
    storage.reopen().await?;
    let settings = storage.read(settings::get).await?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || shell::storage_opened(&handle, &settings))
        .await
        .map_err(|error| CommandError::storage(error.to_string()))
}
