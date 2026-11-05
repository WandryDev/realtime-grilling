//! Commands of a finished call's records. Registered like the others
//! (`bindings::builder`, `command_names.rs`, `capabilities/*.json`): the
//! writes are the main window's.

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use super::audio::{self, AudioCache, MAX_BARS, RecordingPeaks};
use crate::{
    agent::fast_loop::app::call_state_changed,
    error::{CommandError, CommandResult},
    recording::store::RecordingStore,
    speech::refiner::Refiner,
    storage::{
        Storage,
        call_records::{self, CallCards, CallQuestion, CallRecording},
        call_search::{self, CallSearch},
        proposals::{
            self, Proposal,
            apply::{self, ProposalDecide},
        },
        recordings,
        summaries::{CardPatch, SummaryCard},
    },
};

/* Proposals (decision 8) */

/// The proposals of a call, oldest first, with their decisions.
/// `NotFound` for an unknown call.
#[tauri::command]
#[specta::specta]
pub async fn proposals_list(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<Proposal>> {
    storage.read(move |db| proposals::list(db, &call_id)).await
}

/// A person's pending proposals from every call, newest first (the
/// person's page). `NotFound` for an unknown person.
#[tauri::command]
#[specta::specta]
pub async fn proposals_for_person(
    storage: State<'_, Storage>,
    person_id: String,
) -> CommandResult<Vec<Proposal>> {
    storage
        .read(move |db| proposals::pending_for_person(db, &person_id))
        .await
}

/// Accepts a pending proposal and applies it to the profile or the
/// project's notes, or rejects it (nothing changes). `Invalid` with the
/// reason when it can't be applied (notes over the limit, a level that is
/// not 1–5) or is already decided; nothing changes then.
#[tauri::command]
#[specta::specta]
pub async fn proposal_decide(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
    input: ProposalDecide,
) -> CommandResult<Proposal> {
    storage
        .write(&app, move |db| apply::decide(db, &id, &input))
        .await
}

/// «Отменить» / «Вернуть»: the proposal is pending again, an accepted one
/// with the field put back. `Invalid` «Поле изменили после принятия» when
/// the field changed since; nothing changes then.
#[tauri::command]
#[specta::specta]
pub async fn proposal_undo(
    app: AppHandle,
    storage: State<'_, Storage>,
    id: String,
) -> CommandResult<Proposal> {
    storage.write(&app, move |db| apply::undo(db, &id)).await
}

/* Task cards (decision 7) */

/// The task cards page of a call: the saved summary's cards and its
/// questions for the next call (`source: summary`), or before a summary the
/// fast loop's cards of every recording (`source: live`). `NotFound` for
/// an unknown call.
#[tauri::command]
#[specta::specta]
pub async fn call_cards(storage: State<'_, Storage>, call_id: String) -> CommandResult<CallCards> {
    storage
        .read(move |db| call_records::cards(db, &call_id))
        .await
}

/// Accepts, defers, restores or renames a card of `call_cards`; absent
/// fields stay. A fast loop card also sends `CallStateChanged` of its
/// recording. `NotFound` for a card the call doesn't have, `Invalid` for a
/// blank title.
#[tauri::command]
#[specta::specta]
pub async fn call_card_update(
    app: AppHandle,
    storage: State<'_, Storage>,
    call_id: String,
    card_id: String,
    patch: CardPatch,
) -> CommandResult<SummaryCard> {
    let updated = storage
        .write(&app, move |db| {
            call_records::update_card(db, &call_id, &card_id, &patch)
        })
        .await?;
    if let Some(recording_id) = &updated.recording_id {
        call_state_changed(&app, recording_id);
    }
    Ok(updated.card)
}

/* Transcript and questions (decision 11) */

/// The recordings of a call in the order they started, each with its
/// transcript (refined where the second pass is done), times, duration,
/// file sizes and whether its audio was deleted. `NotFound` for an unknown
/// call.
#[tauri::command]
#[specta::specta]
pub async fn call_transcript(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<CallRecording>> {
    let data_dir = storage.data_dir().map(std::path::Path::to_path_buf);
    storage
        .read(move |db| call_records::transcript(db, data_dir.as_deref(), &call_id))
        .await
}

/// The questions of a call's recordings with the moments of their evidence
/// and answer, found for a segment of either pass. `NotFound` for an
/// unknown call.
#[tauri::command]
#[specta::specta]
pub async fn call_questions(
    storage: State<'_, Storage>,
    call_id: String,
) -> CommandResult<Vec<CallQuestion>> {
    storage
        .read(move |db| call_records::questions(db, &call_id))
        .await
}

/// Searches the calls' transcripts (shown pass), titles and summaries
/// (TL;DR, points, card facts) without case and «ё»: at most 200 matches
/// with ±60 characters around each, and the counts per project. On this
/// computer only.
#[tauri::command]
#[specta::specta]
pub async fn calls_search(
    storage: State<'_, Storage>,
    query: String,
    project_id: Option<String>,
) -> CommandResult<CallSearch> {
    storage
        .read(move |db| call_search::search(db, &query, project_id.as_deref()))
        .await
}

/* Audio (decisions 9, 10) */

/// The waveform of a recording: `bars` (1–2000) peaks per channel over the
/// longer channel. Decoded in Rust once, then cached. `NotFound` for an
/// unknown recording or deleted audio, `Invalid` for a recording being
/// written or a count of bars out of range.
#[tauri::command]
#[specta::specta]
pub async fn recording_peaks(
    storage: State<'_, Storage>,
    cache: State<'_, AudioCache>,
    recording_id: String,
    bars: u32,
) -> CommandResult<RecordingPeaks> {
    if !(1..=MAX_BARS).contains(&bars) {
        return Err(CommandError::invalid(format!(
            "Столбцов волны — от 1 до {MAX_BARS}"
        )));
    }
    let id = recording_id.clone();
    let recording = storage.read(move |db| recordings::get(db, &id)).await?;
    let dir = storage
        .data_dir()
        .ok_or_else(|| CommandError::storage("Нет папки данных приложения"))?;
    let files = audio::playable(&recording, dir).ok_or_else(|| {
        if recording.audio_deleted_at.is_some() {
            CommandError::not_found("Аудио записи удалено")
        } else {
            CommandError::invalid("Запись ещё идёт")
        }
    })?;
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cache.peaks(&recording_id, &files, bars))
        .await
        .map_err(|error| CommandError::storage(error.to_string()))?
        .map_err(|error| CommandError::external(format!("Не удалось прочитать запись: {error}")))
}

/// «Удалить запись»: deletes the audio files of every recording of a
/// finished call, stopping a second pass that runs; the transcript,
/// summary, cards, questions and proposals stay. `Invalid` for a call that
/// isn't finished.
#[tauri::command]
#[specta::specta]
pub async fn call_audio_delete(
    app: AppHandle,
    storage: State<'_, Storage>,
    cache: State<'_, AudioCache>,
    call_id: String,
) -> CommandResult<()> {
    let store: Arc<dyn RecordingStore> = storage
        .recording_store()
        .ok_or_else(|| CommandError::storage("Нет папки данных приложения"))?;
    let refiner = app
        .try_state::<Refiner>()
        .map(|refiner| refiner.inner().clone());
    audio::delete_call_audio(
        &storage,
        &app,
        store,
        refiner,
        cache.inner().clone(),
        &call_id,
    )
    .await
}
