//! Accepting, rejecting and undoing a proposal (post-call design.md,
//! decision 8; `knowledge-proposals`).
//!
//! The data change and the decision are written in the caller's
//! transaction (`Storage::write`): an error leaves both as they were.
//!
//! - **Profile.** `role` is the `people.role` column; `tech` and `project`
//!   (1–5), `howToAsk`, `notes` and `portrait:<label>` are keys of the
//!   `profile` JSON, written read-modify-write. `applied` keeps the value
//!   written and the one before it.
//! - **Brief.** The line `- <call date>: <text>` goes under `## Из звонков`
//!   in the project's notes (the section is added when missing). The notes
//!   are part of the brief's fingerprint (`brief_inputs`), so a fresh brief
//!   reads as `outdated` from then on; so do the people.
//! - **Undo** puts the previous value back only while the field still holds
//!   what was written (for the notes: removes exactly that line), else
//!   `Invalid` «Поле изменили после принятия» and nothing changes.

use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use specta::Type;

use super::{DecisionChange, Proposal, ProposalApplied, ProposalDecision, ProposalTarget, get};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
    storage::{
        calls,
        people::{self, PersonUpdate},
        projects::{self, MAX_NOTES_CHARS, ProjectUpdate},
    },
};

/// The heading of the notes' section the accepted brief proposals go to.
pub const NOTES_SECTION: &str = "## Из звонков";

/// A level of the profile: 1–5.
const LEVELS: std::ops::RangeInclusive<u8> = 1..=5;

/// What the undo says when the field changed after it was accepted.
const CHANGED_SINCE: &str = "Поле изменили после принятия";

/// `proposal_decide`: accept (with the manager's text of "Изменить и
/// принять", if any) or reject.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProposalDecide {
    /// `accepted` or `rejected`; `pending` is the undo's.
    pub decision: ProposalDecision,
    /// Accepted with this text instead of the proposed one.
    #[specta(optional)]
    pub edited: Option<String>,
}

/// A field of a profile a proposal may change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProfileField<'a> {
    /// The `people.role` column.
    Role,
    /// `tech` / `project`: a number 1–5.
    Level(&'a str),
    /// `howToAsk` / `notes`.
    Text(&'a str),
    /// `portrait` → label.
    Portrait(&'a str),
}

fn profile_field(field: &str) -> CommandResult<ProfileField<'_>> {
    match field {
        "role" => Ok(ProfileField::Role),
        "tech" | "project" => Ok(ProfileField::Level(field)),
        "howToAsk" | "notes" => Ok(ProfileField::Text(field)),
        _ => match field.strip_prefix("portrait:").map(str::trim) {
            Some(label) if !label.is_empty() => Ok(ProfileField::Portrait(label)),
            _ => Err(CommandError::invalid(format!("Поля профиля «{field}» нет"))),
        },
    }
}

/// The text to write: the manager's or the proposed one, trimmed.
fn accepted_text(proposal: &Proposal, edited: Option<&str>) -> CommandResult<String> {
    let text = edited.unwrap_or(&proposal.after);
    crate::storage::required(text, "Принятое значение не может быть пустым")
}

/// The JSON value a profile field gets from `text`.
fn profile_value(field: ProfileField<'_>, text: &str) -> CommandResult<Value> {
    match field {
        ProfileField::Level(_) => text
            .parse::<u8>()
            .ok()
            .filter(|level| LEVELS.contains(level))
            .map(|level| json!(level))
            .ok_or_else(|| CommandError::invalid("Уровень — число от 1 до 5")),
        ProfileField::Role | ProfileField::Text(_) | ProfileField::Portrait(_) => {
            Ok(Value::String(text.to_owned()))
        }
    }
}

/// The field's current value; `None` when it is not set.
fn current_value(person: &people::Person, field: ProfileField<'_>) -> Option<Value> {
    let value = match field {
        ProfileField::Role => {
            return (!person.role.is_empty()).then(|| Value::String(person.role.clone()));
        }
        ProfileField::Level(key) | ProfileField::Text(key) => person.profile.get(key),
        ProfileField::Portrait(label) => person
            .profile
            .get("portrait")
            .and_then(Value::as_object)
            .and_then(|portrait| portrait.get(label)),
    };
    value.filter(|value| !value.is_null()).cloned()
}

/// Writes `value` into the field (`None`: unsets it) and returns the
/// person's events.
fn write_value(
    connection: &Connection,
    person: &people::Person,
    field: ProfileField<'_>,
    value: Option<Value>,
) -> CommandResult<Vec<DataChanged>> {
    let mut patch = PersonUpdate::default();
    let mut profile = match &person.profile {
        Value::Object(profile) => profile.clone(),
        _ => Map::new(),
    };
    match field {
        ProfileField::Role => {
            patch.role = Some(match value {
                Some(Value::String(role)) => role,
                _ => String::new(),
            });
        }
        ProfileField::Level(key) | ProfileField::Text(key) => {
            match value {
                Some(value) => profile.insert(key.to_owned(), value),
                None => profile.remove(key),
            };
            patch.profile = Some(Value::Object(profile));
        }
        ProfileField::Portrait(label) => {
            let mut portrait = match profile.remove("portrait") {
                Some(Value::Object(portrait)) => portrait,
                _ => Map::new(),
            };
            match value {
                Some(value) => portrait.insert(label.to_owned(), value),
                None => portrait.remove(label),
            };
            profile.insert("portrait".to_owned(), Value::Object(portrait));
            patch.profile = Some(Value::Object(profile));
        }
    }
    Ok(people::update(connection, &person.id, patch)?.1)
}

fn person_of(connection: &Connection, proposal: &Proposal) -> CommandResult<people::Person> {
    let id = proposal
        .person_id
        .as_deref()
        .ok_or_else(|| CommandError::invalid("Предложение по профилю без человека"))?;
    people::get(connection, id)
}

fn project_of(connection: &Connection, proposal: &Proposal) -> CommandResult<String> {
    calls::project_of(connection, &proposal.call_id)?
        .ok_or_else(|| CommandError::invalid("У звонка без проекта нет брифа"))
}

/// The call's date in local time, `05.11.2026`.
fn call_date(connection: &Connection, call_id: &str) -> CommandResult<String> {
    let call = calls::get(connection, call_id)?;
    Ok(local_date(call.started_at.unwrap_or(call.created_at)))
}

/// Milliseconds since the Unix epoch as a local date, `05.11.2026`.
fn local_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%d.%m.%Y")
                .to_string()
        })
        .unwrap_or_default()
}

/// The notes line of an accepted brief proposal: one line, whatever the
/// text's line breaks.
fn notes_line(date: &str, text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("- {date}: {text}")
}

fn is_heading(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

/// The range of lines of the `## Из звонков` section after its heading.
fn section(lines: &[&str]) -> Option<(usize, usize)> {
    let heading = lines.iter().position(|line| line.trim() == NOTES_SECTION)?;
    let end = lines[heading + 1..]
        .iter()
        .position(|line| is_heading(line))
        .map_or(lines.len(), |offset| heading + 1 + offset);
    Some((heading, end))
}

/// `notes` with `line` at the end of the `## Из звонков` section, the
/// section added at the end when there is none.
pub fn with_line(notes: &str, line: &str) -> String {
    let mut lines: Vec<&str> = notes.lines().collect();
    let Some((heading, end)) = section(&lines) else {
        let notes = notes.trim_end();
        return if notes.trim().is_empty() {
            format!("{NOTES_SECTION}\n{line}")
        } else {
            format!("{notes}\n\n{NOTES_SECTION}\n{line}")
        };
    };
    let last = (heading + 1..end)
        .rev()
        .find(|&index| !lines[index].trim().is_empty())
        .unwrap_or(heading);
    lines.insert(last + 1, line);
    lines.join("\n")
}

/// `notes` without the last line equal to `line`; `None` when there is no
/// such line. A `## Из звонков` section left empty goes too.
pub fn without_line(notes: &str, line: &str) -> Option<String> {
    let mut lines: Vec<&str> = notes.lines().collect();
    let index = lines.iter().rposition(|known| known.trim_end() == line)?;
    lines.remove(index);
    if let Some((heading, end)) = section(&lines)
        && lines[heading + 1..end]
            .iter()
            .all(|line| line.trim().is_empty())
    {
        lines.drain(heading..end);
        // The blank line that separated it from what came before.
        if heading > 0 && heading == lines.len() && lines[heading - 1].trim().is_empty() {
            lines.pop();
        }
    }
    Some(lines.join("\n"))
}

fn set_notes(
    connection: &Connection,
    project_id: &str,
    notes: String,
) -> CommandResult<Vec<DataChanged>> {
    if notes.trim().chars().count() > MAX_NOTES_CHARS {
        return Err(CommandError::invalid(
            "Заметки проекта будут длиннее 50 000 символов: сократите их, \
             чтобы принять предложение",
        ));
    }
    let patch = ProjectUpdate {
        notes: Some(notes),
        ..ProjectUpdate::default()
    };
    Ok(projects::update(connection, project_id, patch)?.1)
}

/// The proposal's call changed (its counters of pending proposals).
fn call_changed(connection: &Connection, proposal: &Proposal) -> CommandResult<DataChanged> {
    let project_id = calls::project_of(connection, &proposal.call_id)?;
    Ok(DataChanged::new(
        Entity::Call,
        &proposal.call_id,
        project_id.as_deref(),
        Change::Updated,
    ))
}

/// Accepts a pending proposal and applies it, or rejects it (nothing else
/// changes). `NotFound` for an unknown proposal; `Invalid` for a decided
/// one (undo it first), `pending` as the decision, a blank text, a level
/// that is not 1–5, an unknown profile field, or notes that would be longer
/// than the limit, and then nothing changes. Sends the person's (and the
/// project's) or the project's `DataChanged`, and the call's.
pub fn decide(
    connection: &Connection,
    id: &str,
    input: &ProposalDecide,
) -> CommandResult<(Proposal, Vec<DataChanged>)> {
    let proposal = get(connection, id)?;
    if proposal.decision != ProposalDecision::Pending {
        return Err(CommandError::invalid(
            "Предложение уже разобрано: сначала отмените решение",
        ));
    }
    let (change, mut events) = match input.decision {
        ProposalDecision::Pending => {
            return Err(CommandError::invalid(
                "Предложение можно принять или отклонить",
            ));
        }
        ProposalDecision::Rejected => (
            DecisionChange {
                decision: ProposalDecision::Rejected,
                edited: None,
                applied: None,
            },
            Vec::new(),
        ),
        ProposalDecision::Accepted => {
            let text = accepted_text(&proposal, input.edited.as_deref())?;
            let (applied, events) = apply(connection, &proposal, &text)?;
            let change = DecisionChange {
                decision: ProposalDecision::Accepted,
                edited: input.edited.as_ref().map(|_| text),
                applied: Some(applied),
            };
            (change, events)
        }
    };
    events.push(call_changed(connection, &proposal)?);
    let decided = super::set_decision(connection, id, &change)?;
    Ok((decided, events))
}

/// Writes the accepted `text`; returns what was written and what was there.
fn apply(
    connection: &Connection,
    proposal: &Proposal,
    text: &str,
) -> CommandResult<(ProposalApplied, Vec<DataChanged>)> {
    match proposal.target {
        ProposalTarget::Person => {
            let field = profile_field(&proposal.field)?;
            let person = person_of(connection, proposal)?;
            let written = profile_value(field, text)?;
            let previous = current_value(&person, field);
            let events = write_value(connection, &person, field, Some(written.clone()))?;
            Ok((ProposalApplied { written, previous }, events))
        }
        ProposalTarget::Brief => {
            let project_id = project_of(connection, proposal)?;
            let project = projects::get(connection, &project_id)?;
            let line = notes_line(&call_date(connection, &proposal.call_id)?, text);
            let events = set_notes(connection, &project_id, with_line(&project.notes, &line))?;
            let applied = ProposalApplied {
                written: Value::String(line),
                previous: None,
            };
            Ok((applied, events))
        }
    }
}

/// «Отменить» / «Вернуть»: the proposal is pending again. An accepted one
/// first puts the field back as it was (for the notes: removes its line),
/// which is `Invalid` «Поле изменили после принятия», with nothing changed,
/// when the field no longer holds what was written. `NotFound` for an
/// unknown proposal, `Invalid` for a pending one. Sends the events of
/// [`decide`].
pub fn undo(connection: &Connection, id: &str) -> CommandResult<(Proposal, Vec<DataChanged>)> {
    let proposal = get(connection, id)?;
    let mut events = match proposal.decision {
        ProposalDecision::Pending => {
            return Err(CommandError::invalid("Предложение ещё не разобрано"));
        }
        ProposalDecision::Rejected => Vec::new(),
        ProposalDecision::Accepted => {
            let applied = proposal
                .applied
                .as_ref()
                .ok_or_else(|| CommandError::invalid(CHANGED_SINCE))?;
            revert(connection, &proposal, applied)?
        }
    };
    events.push(call_changed(connection, &proposal)?);
    let change = DecisionChange {
        decision: ProposalDecision::Pending,
        edited: None,
        applied: None,
    };
    let pending = super::set_decision(connection, id, &change)?;
    Ok((pending, events))
}

fn revert(
    connection: &Connection,
    proposal: &Proposal,
    applied: &ProposalApplied,
) -> CommandResult<Vec<DataChanged>> {
    match proposal.target {
        ProposalTarget::Person => {
            let field = profile_field(&proposal.field)?;
            let person = person_of(connection, proposal)?;
            if current_value(&person, field).as_ref() != Some(&applied.written) {
                return Err(CommandError::invalid(CHANGED_SINCE));
            }
            write_value(connection, &person, field, applied.previous.clone())
        }
        ProposalTarget::Brief => {
            let project_id = project_of(connection, proposal)?;
            let project = projects::get(connection, &project_id)?;
            let notes = applied
                .written
                .as_str()
                .and_then(|line| without_line(&project.notes, line))
                .ok_or_else(|| CommandError::invalid(CHANGED_SINCE))?;
            set_notes(connection, &project_id, notes)
        }
    }
}

#[cfg(test)]
mod tests;
