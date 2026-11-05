//! Commands of a finished call's records. Registered like the others
//! (`bindings::builder`, `command_names.rs`, `capabilities/*.json`): the
//! writes are the main window's.

use tauri::{AppHandle, State};

use crate::{
    agent::fast_loop::app::call_state_changed,
    error::CommandResult,
    storage::{
        Storage,
        call_records::{self, CallCards, CallQuestion, CallRecording},
        proposals::{
            self, Proposal,
            apply::{self, ProposalDecide},
        },
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
