//! Tauri commands. Each is async: the database work runs in `spawn_blocking`
//! (see `Storage::read` / `Storage::write`), and a write sends
//! `DataChanged` only after its transaction committed.
//!
//! Adding a command: register it in `bindings::builder` and in
//! `command_names.rs`, and allow it in `capabilities/*.json`.

use std::{path::PathBuf, sync::Arc};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_specta::Event;

use crate::{
    agent::{
        self, AgentSessions, AgentState,
        discover::SearchEnv,
        fast_loop::{
            app::{self as fast_loop_app, call_state_changed},
            events::CallStateView,
            scheduler::FastLoop,
        },
        install::{self, AgentInstallProgress},
        login,
        slow_loop::{app as slow_loop_app, scheduler::SlowLoop},
    },
    audio::{
        AudioInputs, AudioLevels, AudioSource, Inputs,
        mic_watch::{MicActivityChanged, MicWatch},
    },
    call::{CallManager, CallStart},
    connectors::{
        BrowseNode, ConnectorKind, ExternalRef, SelectionItem,
        service::{self as connector_service, ConnectOutcome, ConnectorView, ProjectConnectorView},
        sync as connector_sync,
    },
    error::{CommandError, CommandResult},
    events::{CallSession, Navigate},
    permissions::{self, PermissionKind, PermissionStatus, Permissions},
    projects::{
        brief::{export as brief_export_file, run as brief_run},
        builds::BriefBuilds,
        sources::{self as project_sources, SourceAddResult},
    },
    recording::{RecordingManager, status::RecordingStatus},
    records::audio::{self as records_audio, AudioCache},
    shell::{self, SettingsLock, shortcuts::ShortcutError, windows},
    speech::{
        benchmark::{self, BenchmarkFailure, BenchmarkResult, Thresholds},
        check, mic_check,
        models::{ErrorReason, ModelId, ModelManager, ModelState, SpeechModel},
        refiner::Refiner,
        service::Speech,
    },
    storage::{
        Storage, call_records,
        call_state::{self, AgentUsage, QuestionAction},
        calls::{self, Call, CallCreate, CallStatus, CallUpdate},
        data::{self, DataSummary, RecordingsInfo},
        people::{self, Person, PersonCreate, PersonUpdate},
        projects::{self, Project, ProjectCreate, ProjectOverview, ProjectUpdate},
        recordings::{self, RecordingLinks, TranscriptState},
        settings::{self, SettingsMap},
        sources::{self, ProjectSource},
        summaries,
        transcript::{self, TranscriptSegment},
    },
    summary::{
        CallSummaryView,
        builds::{Stop, SummaryBuilds},
        run as summary_run,
    },
};

/* Projects */

#[tauri::command]
#[specta::specta]
pub async fn projects_list(
    storage: State<'_, Storage>,
    builds: State<'_, BriefBuilds>,
) -> CommandResult<Vec<Project>> {
    Ok(builds.mark_all(storage.read(projects::list).await?))
}

#[tauri::command]
#[specta::specta]
pub async fn projects_get(
    storage: State<'_, Storage>,
    builds: State<'_, BriefBuilds>,
    id: String,
) -> CommandResult<Project> {
    let project = storage.read(move |db| projects::get(db, &id)).await?;
    Ok(builds.mark(project))
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
    builds: State<'_, BriefBuilds>,
    id: String,
    patch: ProjectUpdate,
) -> CommandResult<Project> {
    let project = storage
        .write(&app, move |db| projects::update(db, &id, patch))
        .await?;
    Ok(builds.mark(project))
}

#[tauri::command]
#[specta::specta]
pub async fn projects_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    builds: State<'_, BriefBuilds>,
    summaries: State<'_, SummaryBuilds>,
    cache: State<'_, AudioCache>,
    id: String,
) -> CommandResult<()> {
    crate::projects::delete(&storage, &app, &builds, &id).await?;
    // Its calls went with it: their summary builds stop, saving nothing,
    // and their decoded audio goes.
    summaries.stop_project(&id);
    records_audio::forget_deleted(&storage, &cache).await;
    Ok(())
}

/// Per project: open questions of its recordings and when the last one
/// started (the home screen).
#[tauri::command]
#[specta::specta]
pub async fn projects_overview(storage: State<'_, Storage>) -> CommandResult<Vec<ProjectOverview>> {
    storage.read(projects::overview).await
}

/* Project documents */

/// Adds files from the manager's computer to the project: a result per
/// path, in order (added, a duplicate of an existing document, or
/// rejected with a reason). `NotFound` for an unknown project.
#[tauri::command]
#[specta::specta]
pub async fn project_sources_add(
    app: AppHandle,
    storage: State<'_, Storage>,
    project_id: String,
    paths: Vec<String>,
) -> CommandResult<Vec<SourceAddResult>> {
    project_sources::add(&storage, &app, &project_id, paths).await
}

/// The project's documents in the order they were added, without their
/// text. `NotFound` for an unknown project.
#[tauri::command]
#[specta::specta]
pub async fn project_sources_list(
    storage: State<'_, Storage>,
    project_id: String,
) -> CommandResult<Vec<ProjectSource>> {
    storage.read(move |db| sources::list(db, &project_id)).await
}

/// Deletes a document and its copy. `NotFound` for an unknown id.
#[tauri::command]
#[specta::specta]
pub async fn project_sources_remove(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<()> {
    project_sources::remove(&storage, &app, id).await
}

/* Project brief */

/// Starts building the project's brief with the agent, in the background,
/// and returns at once: `BriefProgress` follows the stages (1…5) to `done`,
/// `failed` or `cancelled`. While a build of the project runs, does nothing
/// (follow that one). `NotFound` for an unknown project.
#[tauri::command]
#[specta::specta]
pub async fn brief_build(
    app: AppHandle,
    storage: State<'_, Storage>,
    builds: State<'_, BriefBuilds>,
    project_id: String,
) -> CommandResult<()> {
    let id = project_id.clone();
    storage.read(move |db| projects::exists(db, &id)).await?;
    brief_run::start(&Arc::new(app), &builds, &project_id, None);
    Ok(())
}

/// Stops the project's build and kills the agent; the old brief stays.
/// Nothing when none runs.
#[tauri::command]
#[specta::specta]
pub fn brief_cancel(builds: State<'_, BriefBuilds>, project_id: String) -> CommandResult<()> {
    builds.cancel(&project_id);
    Ok(())
}

/// The start widget, when shown for a project: refreshes an `outdated`
/// brief (or builds a missing one when there are materials) in the
/// background, if the agent is ready and no build runs. `true` when a
/// build started. The call never waits for it.
#[tauri::command]
#[specta::specta]
pub async fn brief_prepare(
    app: AppHandle,
    builds: State<'_, BriefBuilds>,
    project_id: String,
) -> CommandResult<bool> {
    brief_run::prepare(&Arc::new(app), &builds, &project_id).await
}

/// Writes `<Проект> — бриф.md` into `folder` and returns its path.
/// `NotFound` for an unknown project, `Invalid` without a brief or with a
/// folder that does not exist, `External` when the file can't be written.
#[tauri::command]
#[specta::specta]
pub async fn brief_export(
    storage: State<'_, Storage>,
    project_id: String,
    folder: String,
) -> CommandResult<String> {
    brief_export_file::export(&storage, &project_id, &folder).await
}

/* Connectors (connectors-outline design.md, decision 6) */

/// The catalog with each connector's connection: Outline works, GitHub and
/// ClickUp are «скоро» (`available: false`). No secret is ever in it.
#[tauri::command]
#[specta::specta]
pub async fn connectors_list(app: AppHandle) -> CommandResult<Vec<ConnectorView>> {
    connector_service::list(&app).await
}

/// Checks the address and the key with the service, then saves the key in
/// Keychain / Credential Manager and the connection (also to replace the
/// key of a connected or broken one). A refusal is `rejected` with the
/// field it belongs to, and nothing is saved. A key that opens several
/// workspaces (ClickUp) answers `chooseWorkspace`, nothing saved: call
/// again with the same key and the picked `workspace`. `External` when the
/// OS store refused the key; `Invalid` for a connector that is «скоро».
#[tauri::command]
#[specta::specta]
pub async fn connector_connect_api_key(
    app: AppHandle,
    kind: ConnectorKind,
    host: String,
    key: String,
    workspace: Option<String>,
) -> CommandResult<ConnectOutcome> {
    connector_service::connect_api_key(&Arc::new(app), kind, &host, &key, workspace.as_deref())
        .await
}

/// Removes the key from the OS store and the connection. The projects'
/// selections and sources stay with their last text.
#[tauri::command]
#[specta::specta]
pub async fn connector_disconnect(app: AppHandle, kind: ConnectorKind) -> CommandResult<()> {
    connector_service::disconnect(&app, kind).await
}

/// The picker's tree: the containers (Outline's collections with their
/// document counts) without `parent`, else what is inside it. `Invalid`
/// when not connected, `External` with what to show when the service
/// failed (recorded on the connection).
#[tauri::command]
#[specta::specta]
pub async fn connector_browse(
    app: AppHandle,
    kind: ConnectorKind,
    parent: Option<ExternalRef>,
) -> CommandResult<Vec<BrowseNode>> {
    connector_service::browse(&app, kind, parent).await
}

/// The project's selection in each connector that gives sources, with the
/// items' state and the last sync. `NotFound` for an unknown project.
#[tauri::command]
#[specta::specta]
pub async fn connector_selection_get(
    app: AppHandle,
    project_id: String,
) -> CommandResult<Vec<ProjectConnectorView>> {
    connector_service::selection_get(&app, &project_id).await
}

/// Replaces the project's selection in the connector (an empty list
/// removes it) and starts its sync in the background. `Invalid` when it
/// brings more than 200 documents (nothing saved) or the connector is not
/// connected.
#[tauri::command]
#[specta::specta]
pub async fn connector_selection_set(
    app: AppHandle,
    project_id: String,
    kind: ConnectorKind,
    items: Vec<SelectionItem>,
) -> CommandResult<ProjectConnectorView> {
    let view = connector_service::selection_set(&app, &project_id, kind, items).await?;
    let host = Arc::new(app);
    tauri::async_runtime::spawn(async move {
        let _ = connector_sync::sync_fresh(&host, &project_id, kind).await;
    });
    Ok(view)
}

/// «Обновить»: syncs the project with the connector (every connector it
/// uses without `kind`) and returns when done; joins a sync that runs. The
/// outcome is in the selection's sync state.
#[tauri::command]
#[specta::specta]
pub async fn connector_sync(
    app: AppHandle,
    project_id: String,
    kind: Option<ConnectorKind>,
) -> CommandResult<()> {
    let host = Arc::new(app);
    let results = match kind {
        Some(kind) => vec![(
            kind,
            connector_sync::sync_project(&host, &project_id, kind).await,
        )],
        None => connector_sync::sync_all(&host, &project_id).await?,
    };
    for (_, result) in results {
        result?;
    }
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

/// Also sends the project's `DataChanged`: its brief depends on its people.
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

/// Also sends the project's `DataChanged`: its brief depends on its people.
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

/// Also sends the project's `DataChanged`: its brief depends on its people.
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
    summaries: State<'_, SummaryBuilds>,
    cache: State<'_, AudioCache>,
    id: String,
) -> CommandResult<()> {
    let call_id = id.clone();
    storage
        .write(&app, move |db| calls::delete(db, &call_id))
        .await?;
    // A summary build of it stops: its agent is killed, nothing is saved.
    summaries.stop(&id, Stop::Aborted);
    // The call's recordings went with it; now their files and their
    // decoded copies.
    storage.sweep_recordings().await;
    records_audio::forget_deleted(&storage, &cache).await;
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

/// Where the second pass over a recording is: `live` (not started yet),
/// `refining`, `refined`, `failed`, or `skipped` (recorded before speech
/// recognition). A window that comes late to a pass reads it here first.
/// `NotFound` for an unknown recording.
#[tauri::command]
#[specta::specta]
pub async fn transcript_state(
    storage: State<'_, Storage>,
    recording_id: String,
) -> CommandResult<TranscriptState> {
    storage
        .read(move |db| Ok(recordings::get(db, &recording_id)?.transcript_state))
        .await
}

/* The call state (agent-fast-loop) */

/// Everything a window shows about a recording's call: topics, cards,
/// questions with their place in the visible list (`visible`, `rank` 0 =
/// the main one), the final check, and the agent's state. Read again on
/// `CallStateChanged`. `NotFound` for an unknown recording.
#[tauri::command]
#[specta::specta]
pub async fn call_state_get(
    storage: State<'_, Storage>,
    fast_loop: State<'_, FastLoop>,
    slow_loop: State<'_, SlowLoop>,
    recording_id: String,
) -> CommandResult<CallStateView> {
    let fast_loop = fast_loop.inner().clone();
    let slow_loop = slow_loop.inner().clone();
    storage
        .read(move |db| slow_loop_app::view(db, &fast_loop, &slow_loop, &recording_id))
        .await
}

/// «Закрепить» / «Открепить» / «Скрыть» / «Задал» / «Вернуть» on a
/// question; every window gets `CallStateChanged`. `NotFound` for an
/// unknown question, `Invalid` for an action its state doesn't allow.
#[tauri::command]
#[specta::specta]
pub async fn questions_act(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    action: QuestionAction,
) -> CommandResult<()> {
    let recording_id = storage
        .write(&app, move |db| {
            Ok((call_state::act(db, &id, action)?, Vec::new()))
        })
        .await?;
    call_state_changed(&app, &recording_id);
    Ok(())
}

/// «Убрать» on a finding of the column «Контекст»: it is hidden in every
/// window (`CallStateChanged`) and no longer given to the agent; questions
/// that cite it stay. `NotFound` when the recording has no such finding.
#[tauri::command]
#[specta::specta]
pub async fn context_finding_hide(
    app: AppHandle,
    storage: State<'_, Storage>,
    recording_id: String,
    finding_id: String,
) -> CommandResult<()> {
    fast_loop_app::hide_finding(&app, &storage, recording_id, finding_id).await
}

/// «Повторить»: calls the agent of the recording now, or checks it again
/// when it was not ready. `NotFound` when the recording's live pass doesn't
/// run.
#[tauri::command]
#[specta::specta]
pub fn agent_retry(fast_loop: State<'_, FastLoop>, recording_id: String) -> CommandResult<()> {
    fast_loop.retry(&recording_id)
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
    let count_changed = patch.contains_key(settings::QUESTION_COUNT);
    let microphone_changed = patch.contains_key(settings::MICROPHONE);
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
    if microphone_changed && let Some(inputs) = app.try_state::<Inputs>() {
        // Reopens a running level meter; the recording follows on its own.
        let (inputs, chosen) = (inputs.inner().clone(), settings::microphone(&settings));
        let _ = permissions::blocking(move || inputs.select(chosen)).await;
    }
    if count_changed {
        // Every window shows the new number of questions at once.
        let recordings = storage
            .write(&app, |db| {
                Ok((fast_loop_app::recompute_lists(db)?, Vec::new()))
            })
            .await?;
        for recording_id in recordings {
            call_state_changed(&app, &recording_id);
        }
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

/* Data (settings-real design.md, decisions 4 and 8) */

/// «Папка записей»: where the recordings' files are (for «Показать в
/// Finder»), what they take and how many calls still have audio.
#[tauri::command]
#[specta::specta]
pub async fn recordings_info(storage: State<'_, Storage>) -> CommandResult<RecordingsInfo> {
    data::recordings_info(&storage).await
}

/// The summary next to «Удалить всё»: projects, calls, what the recordings
/// take.
#[tauri::command]
#[specta::specta]
pub async fn data_summary(storage: State<'_, Storage>) -> CommandResult<DataSummary> {
    data::summary(&storage).await
}

/// «Удалить всё»: every project, person, call, transcript, summary and
/// connection, the recordings' files, the connectors' secrets; the settings
/// back to their defaults (no `agentPath`, onboarding not done). Then
/// onboarding shows and the main window hides. `Invalid` while a call or a
/// recording goes on (discard it first); `External` when a file or a secret
/// could not be removed (the rest is gone all the same).
#[tauri::command]
#[specta::specta]
pub async fn data_delete_all(
    app: AppHandle,
    storage: State<'_, Storage>,
    lock: State<'_, SettingsLock>,
    models: State<'_, ModelManager>,
    recorder: State<'_, RecordingManager>,
    calls: State<'_, CallManager>,
    cache: State<'_, AudioCache>,
) -> CommandResult<()> {
    if recorder.is_recording() || calls.is_active() {
        return Err(CommandError::invalid(
            "Идёт звонок: завершите или удалите его, потом удаляйте данные",
        ));
    }
    let _one_at_a_time = lock.0.lock().await;
    let before = storage.read(settings::get).await?;
    let secrets = Arc::clone(&app.state::<crate::connectors::Connectors>().secrets);
    let deleted = data::delete_everything(&storage, &app, secrets.as_ref()).await;
    // The OS follows the default settings: autostart, the overlay hidden
    // from screen sharing, the shortcuts.
    let defaults = settings::defaults();
    let applied: SettingsMap = [
        settings::LAUNCH_AT_LOGIN,
        settings::HIDE_ON_SHARE,
        settings::SHORTCUTS,
    ]
    .into_iter()
    .filter_map(|key| Some((key.to_owned(), defaults.get(key)?.clone())))
    .collect();
    let handle = app.clone();
    let effects = tauri::async_runtime::spawn_blocking(move || {
        shell::apply_settings(&handle, &applied, &before)
    })
    .await
    .map_err(|error| CommandError::storage(error.to_string()))?;
    if !effects.corrections.is_empty() {
        let corrections = effects.corrections;
        storage
            .write(&app, move |db| Ok(((), settings::put(db, &corrections)?)))
            .await?;
    }
    models.set_selected(settings::speech_model(&defaults));
    if let Some(inputs) = app.try_state::<Inputs>() {
        let inputs = inputs.inner().clone();
        let _ = permissions::blocking(move || inputs.select(None)).await;
    }
    let cache = cache.inner().clone();
    let _ = tauri::async_runtime::spawn_blocking(move || cache.clear()).await;
    shell::remember_onboarding(&app, false);
    windows::show(&app, windows::ONBOARDING);
    windows::hide(&app, windows::MAIN);
    deleted
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
/// fails. On success its settings take effect as at a normal start, and the
/// recordings a previous run left unrefined are queued for the second pass.
#[tauri::command]
#[specta::specta]
pub async fn storage_reopen(
    app: AppHandle,
    storage: State<'_, Storage>,
    lock: State<'_, SettingsLock>,
    models: State<'_, ModelManager>,
    refiner: State<'_, Refiner>,
) -> CommandResult<()> {
    let _one_at_a_time = lock.0.lock().await;
    if storage.error().is_none() {
        return Ok(());
    }
    storage.reopen().await?;
    let settings = storage.read(settings::get).await?;
    models.set_selected(settings::speech_model(&settings));
    if let Some(inputs) = app.try_state::<Inputs>() {
        let (inputs, chosen) = (inputs.inner().clone(), settings::microphone(&settings));
        let _ = permissions::blocking(move || inputs.select(chosen)).await;
    }
    refiner.queue_unrefined().await;
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
    fast_loop: State<'_, FastLoop>,
    slow_loop: State<'_, SlowLoop>,
) -> CommandResult<AgentState> {
    let cwd = agent_workdir(&app);
    let state = agent::locate_and_check(&storage, &app, &SearchEnv::from_process(), &cwd).await;
    resume_calls(&fast_loop, &slow_loop, &state);
    Ok(state)
}

/// A ready agent resumes the calls of a recording that waited for it, in
/// both loops.
fn resume_calls(fast_loop: &FastLoop, slow_loop: &SlowLoop, state: &AgentState) {
    if matches!(state, AgentState::Ready { .. }) {
        fast_loop.agent_ready();
        slow_loop.agent_ready();
    }
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
    fast_loop: State<'_, FastLoop>,
    slow_loop: State<'_, SlowLoop>,
    code: String,
) -> CommandResult<AgentState> {
    let code = code.trim();
    if code.is_empty() || code.contains(['\n', '\r']) {
        return Err(CommandError::invalid("Вставьте код из браузера"));
    }
    let session = sessions.take_login().await?;
    let cli = agent_cli(&app, &storage).await?;
    let state = agent::finish_login(session, code, &cli, &agent_workdir(&app)).await?;
    resume_calls(&fast_loop, &slow_loop, &state);
    Ok(state)
}

/// "Отменить": stops the login in progress (or still starting), if any.
#[tauri::command]
#[specta::specta]
pub async fn agent_login_cancel(sessions: State<'_, AgentSessions>) -> CommandResult<()> {
    sessions.cancel_login().await;
    Ok(())
}

/// «Указать другой» (settings-real design.md, decision 7): the status of
/// the CLI at `path`, without saving it. A path that is not a file named as
/// the CLI is `notInstalled` and is never run.
#[tauri::command]
#[specta::specta]
pub async fn agent_check_path(app: AppHandle, path: String) -> CommandResult<AgentState> {
    Ok(agent::check_path(std::path::Path::new(path.trim()), &agent_workdir(&app)).await)
}

/// The last known share of the subscription limit, from the newest agent
/// call that reported one; `null` without any.
#[tauri::command]
#[specta::specta]
pub async fn agent_usage(storage: State<'_, Storage>) -> CommandResult<Option<AgentUsage>> {
    storage.read(call_state::latest_usage).await
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

/* Microphones (settings-real design.md, decision 1) */

/// The computer's input devices, the chosen microphone (`"system"`: «Как в
/// системе») and since when it is missing, if it is.
#[tauri::command]
#[specta::specta]
pub async fn audio_inputs_get(inputs: State<'_, Inputs>) -> CommandResult<AudioInputs> {
    let inputs = inputs.inner().clone();
    permissions::blocking(move || inputs.get()).await
}

/// Subscribes the calling window to `AudioInputsChanged`: the list is
/// checked once a second while any window subscribed. Hiding or closing the
/// window ends its subscriptions.
#[tauri::command]
#[specta::specta]
pub fn audio_inputs_start(window: WebviewWindow, inputs: State<'_, Inputs>) -> CommandResult<()> {
    inputs.start(window.label());
    Ok(())
}

/// Ends one subscription of the calling window.
#[tauri::command]
#[specta::specta]
pub fn audio_inputs_stop(window: WebviewWindow, inputs: State<'_, Inputs>) -> CommandResult<()> {
    inputs.stop(window.label());
    Ok(())
}

/* Microphone activity */

/// Whether another app uses the microphone now, as the last
/// `MicActivityChanged` said: a window opened during a call sees "busy".
#[tauri::command]
#[specta::specta]
pub fn mic_activity_get(watch: State<'_, MicWatch>) -> CommandResult<MicActivityChanged> {
    Ok(watch.current())
}

/* Call (call-lifecycle design.md, decision 2) */

/// The call in progress as the windows last got it (`CallSessionChanged`):
/// a window opened mid-call shows it at once.
#[tauri::command]
#[specta::specta]
pub fn call_current(calls: State<'_, CallManager>) -> CommandResult<CallSession> {
    Ok(calls.current())
}

/// "Начать": creates the call (`live`, its project or none, its people)
/// and records it; the start widget goes and the overlay or the call
/// window shows ("Компактный оверлей"). During a call, returns it and
/// creates nothing. Without microphone access: `External` with
/// `reason: noAccess`, and no call. An unknown project or person:
/// `NotFound`; a person of another project, or people without a project:
/// `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn call_start(
    calls: State<'_, CallManager>,
    input: CallStart,
) -> CommandResult<CallSession> {
    calls.start(input).await
}

/// "Завершить" of the live call: the recording stops, the call gets its
/// end time and is `finishing`; the overlay goes and the main window opens
/// `/call` for the summary. Otherwise nothing changes. An unknown call:
/// `NotFound`; a call that isn't the current one: `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn call_finish(
    calls: State<'_, CallManager>,
    call_id: String,
) -> CommandResult<CallSession> {
    calls.finish(&call_id).await
}

/// "Отменить завершение" of the finishing call: `live` again with a new
/// recording of the same call. A recording that doesn't start leaves the
/// call live without one and answers its error. Otherwise nothing changes.
#[tauri::command]
#[specta::specta]
pub async fn call_resume(
    calls: State<'_, CallManager>,
    call_id: String,
) -> CommandResult<CallSession> {
    calls.resume(&call_id).await
}

/// The summary of the finishing call is built: it is `finished`, and no
/// call is current. Otherwise nothing changes.
#[tauri::command]
#[specta::specta]
pub async fn call_close(
    calls: State<'_, CallManager>,
    call_id: String,
) -> CommandResult<CallSession> {
    calls.close(&call_id).await
}

/// "Продолжить": the countdown "Завершать звонок сам" stops until the
/// microphone is let go again.
#[tauri::command]
#[specta::specta]
pub async fn call_keep(
    calls: State<'_, CallManager>,
    call_id: String,
) -> CommandResult<CallSession> {
    calls.keep(&call_id).await
}

/// "Удалить все данные" during a call: the live call's recording stops, no
/// call is current and the overlay goes, without a summary and without
/// moving the main window. The call's row is left for the delete that
/// follows. Otherwise nothing changes.
#[tauri::command]
#[specta::specta]
pub async fn call_discard(
    calls: State<'_, CallManager>,
    call_id: String,
) -> CommandResult<CallSession> {
    calls.discard(&call_id).await
}

/* Call summary (post-call design.md, decision 1) */

/// The summary of a call and the build running for it. `summary` is
/// `null` while the call is live, or finishing before its build wrote
/// anything; a finished call without one reads `failed` / `interrupted`.
/// `building` is the last `SummaryProgress` of the build running now (a
/// window that opens during it shows that stage), `null` when none runs.
/// `NotFound` for an unknown call.
#[tauri::command]
#[specta::specta]
pub async fn summary_get(
    storage: State<'_, Storage>,
    builds: State<'_, SummaryBuilds>,
    call_id: String,
) -> CommandResult<CallSummaryView> {
    let id = call_id.clone();
    let summary = storage
        .read(move |db| {
            let mut summary = summaries::get(db, &id)?;
            // Its quotes and ranges at the phrases the transcript shows.
            if let Some(content) = summary
                .as_mut()
                .and_then(|summary| summary.content.as_mut())
            {
                call_records::shown(db, &id, content)?;
            }
            Ok(summary)
        })
        .await?;
    Ok(CallSummaryView {
        summary,
        building: builds.progress(&call_id),
    })
}

/// «Собрать итоги»: builds the summary of a finished call again, in the
/// background, and returns at once; `SummaryProgress` follows the stages.
/// The previous summary stays until the new one is saved. While a build
/// of the call runs, does nothing (follow that one). `NotFound` for an
/// unknown call, `Invalid` for a live one.
#[tauri::command]
#[specta::specta]
pub async fn summary_build(
    app: AppHandle,
    storage: State<'_, Storage>,
    builds: State<'_, SummaryBuilds>,
    call_id: String,
) -> CommandResult<()> {
    let id = call_id.clone();
    let call = storage.read(move |db| calls::get(db, &id)).await?;
    if call.status == CallStatus::Live {
        return Err(CommandError::invalid(
            "Итоги собираются после звонка: сначала завершите его",
        ));
    }
    summary_run::start(&Arc::new(app), &builds, &call_id);
    Ok(())
}

/// «Остановить»: the call's build stops (its agent is killed, nothing is
/// saved), its summary is `failed` / `cancelled` and the call `finished`;
/// a previous summary stays. Without a build a finishing call is closed
/// all the same; otherwise nothing changes.
#[tauri::command]
#[specta::specta]
pub async fn summary_cancel(
    app: AppHandle,
    builds: State<'_, SummaryBuilds>,
    call_id: String,
) -> CommandResult<()> {
    summary_run::stop(&app, &builds, &call_id).await;
    Ok(())
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
/// Unknown call: `NotFound`. The project and the people only feed the
/// glossary: a deleted project or person, a participant of another project,
/// participants without a project, or a project other than the call's (the
/// call's wins) are dropped and the recording starts.
///
/// A running hardware check is interrupted (its window gets `Invalid`,
/// nothing is stored): the live pass needs the recognizer and the selected
/// model.
#[tauri::command]
#[specta::specta]
pub async fn recording_start(
    recorder: State<'_, RecordingManager>,
    speech: State<'_, Speech>,
    input: RecordingStart,
) -> CommandResult<String> {
    speech.interrupt_check();
    let recorder = recorder.inner().clone();
    let started = permissions::blocking(move || recorder.start(&input.into())).await?;
    // A check that began while the devices opened.
    speech.interrupt_check();
    started
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
/// is, except one waiting to retry after a broken connection: it retries
/// at once. Without room for the rest of the file plus 10 % of the model the
/// model becomes `noSpace` and nothing is downloaded. A new file forgets the
/// stored hardware check of the model.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_download(
    app: AppHandle,
    models: State<'_, ModelManager>,
    id: ModelId,
) -> CommandResult<SpeechModel> {
    let was_ready = models.get(id).state == ModelState::Ready;
    let model = models.download(id);
    if !was_ready {
        forget_benchmark(&app, id).await?;
    }
    Ok(model)
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
/// hardware check of it is cancelled, the recognizer lets go of it first)
/// and its stored hardware check. The selected model can't be removed while
/// recording: `Invalid`.
#[tauri::command]
#[specta::specta]
pub async fn speech_model_remove(
    app: AppHandle,
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
    let removed = removed?;
    forget_benchmark(&app, id).await?;
    Ok(removed)
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
/// of the settings); a model that is not installed is `noModel`, one that
/// does not load `modelFailed`, and nothing is stored for them. One check at
/// a time, never while recording (`Invalid`). `speech_benchmark_cancel`,
/// closing the window or a recording starting ends it with `Invalid` and
/// nothing stored.
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
    if recorder.is_recording() {
        // A recording started meanwhile; it may have missed this check.
        speech.interrupt_check();
    }
    let outcome = benchmark::run(
        &speech.recognizer(),
        &set,
        &Thresholds::default(),
        1.0,
        guard.cancelled.clone(),
    )
    .await;
    let (interrupted, cancelled) = (guard.interrupted(), guard.is_cancelled());
    drop(guard);
    if interrupted {
        return Err(CommandError::invalid("Проверка прервана: началась запись"));
    }
    let result = match outcome {
        Ok(result) if !cancelled => result,
        _ => return Err(CommandError::invalid("Проверка отменена")),
    };
    if result.reason == Some(BenchmarkFailure::ModelFailed) {
        models.set_error(model, ErrorReason::Load, "Модель не загрузилась");
    }
    if !result.ran() {
        // Nothing measured: the next look at the model checks it again.
        return Ok(result);
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

/// Forgets the hardware check of `model` (`speechBenchmark[model]`): its file
/// was removed or is downloaded again. Writes only when there is one.
async fn forget_benchmark(app: &AppHandle, model: ModelId) -> CommandResult<()> {
    let lock = app.state::<SettingsLock>();
    let _one_at_a_time = lock.0.lock().await;
    app.state::<Storage>()
        .write(app, move |db| {
            let Some(Value::Object(mut checks)) =
                settings::get(db)?.remove(settings::SPEECH_BENCHMARK)
            else {
                return Ok(((), Vec::new()));
            };
            if checks.remove(model.as_str()).is_none() {
                return Ok(((), Vec::new()));
            }
            let patch =
                SettingsMap::from([(settings::SPEECH_BENCHMARK.to_owned(), Value::Object(checks))]);
            Ok(((), settings::put(db, &patch)?))
        })
        .await
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

/// The mic check of onboarding and «Проверить звук» (decision 15): up to
/// 8 s from the chosen microphone (else the default input), ended early by
/// the end of a phrase, recognized in the call language with the selected
/// model. Nothing is stored. Empty text when nothing was said. `Invalid` without an installed model, `External` with
/// `reason` when the microphone can't be used.
#[tauri::command]
#[specta::specta]
pub async fn speech_mic_check(
    app: AppHandle,
    storage: State<'_, Storage>,
    models: State<'_, ModelManager>,
    speech: State<'_, Speech>,
    inputs: State<'_, Inputs>,
) -> CommandResult<String> {
    if models.selected_path().is_none() {
        return Err(CommandError::invalid("Модель распознавания не скачана"));
    }
    let language = storage
        .read(|db| Ok(settings::call_language(&settings::get(db)?)))
        .await
        .unwrap_or_default();
    let vad_model = crate::vad::bundled_model_path(&app);
    let inputs = inputs.inner().clone();
    let audio = permissions::blocking(move || {
        mic_check::listen_to_microphone(&vad_model, &inputs.target())
    })
    .await??;
    mic_check::recognize(&speech.recognizer(), audio, language).await
}
