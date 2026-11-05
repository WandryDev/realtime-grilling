//! Commands of a finished call's records. Registered like the others
//! (`bindings::builder`, `command_names.rs`, `capabilities/*.json`): the
//! writes are the main window's.

use tauri::{AppHandle, State};

use crate::{
    error::CommandResult,
    storage::{
        Storage,
        proposals::{
            self, Proposal,
            apply::{self, ProposalDecide},
        },
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
