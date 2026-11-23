use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{json::Json, new_id, now_ms, required};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
    projects::brief_inputs,
};

/// Whether the brief matches the project's materials (projects-people-brief
/// design.md, decision 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BriefState {
    /// No brief yet.
    None,
    /// Built from the description, notes, people and documents as they are.
    Fresh,
    /// Something it was built from changed since (or it was not built by
    /// the agent).
    Outdated,
    /// A build of this project runs now.
    Building,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The project brief the agent builds; `null` until there is one.
    pub brief: Option<Value>,
    /// What the manager wrote about the project for the agent.
    pub notes: String,
    /// When the brief was built, milliseconds since the Unix epoch, UTC;
    /// `null` without a brief.
    pub brief_built_at: Option<i64>,
    /// The brief was built from shortened materials.
    pub brief_truncated: bool,
    pub brief_state: BriefState,
    /// Open questions across the project's calls (the sidebar count).
    pub open_questions: u32,
    /// Milliseconds since the Unix epoch, UTC.
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreate {
    pub name: String,
    #[specta(optional)]
    pub description: Option<String>,
    #[specta(optional)]
    pub notes: Option<String>,
    /// A brief given here is not the agent's: it reads as `outdated`.
    #[specta(optional)]
    pub brief: Option<Value>,
}

/// Only the fields present change.
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdate {
    #[specta(optional)]
    pub name: Option<String>,
    #[specta(optional)]
    pub description: Option<String>,
    #[specta(optional)]
    pub notes: Option<String>,
    /// `null` removes the brief; absent leaves it as it is. A brief given
    /// here is not the agent's: it reads as `outdated`.
    #[serde(default, deserialize_with = "super::json::double_option")]
    #[specta(optional, type = Option<Value>)]
    pub brief: Option<Option<Value>>,
}

const SELECT: &str = "SELECT p.id, p.name, p.description, p.brief, p.created_at, p.updated_at,
       (SELECT count(*) FROM questions q JOIN calls c ON c.id = q.call_id
         WHERE c.project_id = p.id AND q.status = 'open'),
       p.notes, p.brief_built_at, p.brief_truncated, p.brief_inputs
  FROM projects p";

/// A row and the fingerprint its brief was built from.
fn from_row(row: &Row) -> rusqlite::Result<(Project, Option<String>)> {
    let project = Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        brief: super::json::optional(row.get(3)?),
        notes: row.get(7)?,
        brief_built_at: row.get(8)?,
        brief_truncated: row.get(9)?,
        brief_state: BriefState::None,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        open_questions: row.get(6)?,
    };
    Ok((project, row.get(10)?))
}

/// Fills `brief_state` from the current inputs. `building` is not known
/// here: [`crate::projects::builds::BriefBuilds::mark`] sets it.
fn with_state(
    connection: &Connection,
    (mut project, built_from): (Project, Option<String>),
) -> CommandResult<Project> {
    project.brief_state = if project.brief.is_none() {
        BriefState::None
    } else {
        let current = brief_inputs::fingerprint(connection, &project.id)?;
        if built_from.as_deref() == Some(current.as_str()) {
            BriefState::Fresh
        } else {
            BriefState::Outdated
        }
    };
    Ok(project)
}

const EMPTY_NAME: &str = "Название проекта не может быть пустым";
/// Longest description, in characters: it goes whole into every brief build.
pub const MAX_DESCRIPTION_CHARS: usize = 5_000;
/// Longest notes, in characters: they go whole into every brief build.
pub const MAX_NOTES_CHARS: usize = 50_000;

/// `text` trimmed, `Invalid` when longer than `max` characters.
fn limited(text: &str, max: usize, too_long: &str) -> CommandResult<String> {
    let text = text.trim();
    if text.chars().count() > max {
        return Err(CommandError::invalid(too_long));
    }
    Ok(text.to_owned())
}

fn description_text(text: &str) -> CommandResult<String> {
    limited(
        text,
        MAX_DESCRIPTION_CHARS,
        "Описание длиннее 5 000 символов",
    )
}

fn notes_text(text: &str) -> CommandResult<String> {
    limited(text, MAX_NOTES_CHARS, "Заметки длиннее 50 000 символов")
}

pub fn list(connection: &Connection) -> CommandResult<Vec<Project>> {
    let mut statement = connection.prepare(&format!("{SELECT} ORDER BY p.created_at, p.id"))?;
    let rows: Vec<_> = statement
        .query_map([], from_row)?
        .collect::<Result<_, _>>()?;
    rows.into_iter()
        .map(|row| with_state(connection, row))
        .collect()
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Project> {
    let row = connection
        .query_row(&format!("{SELECT} WHERE p.id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| not_found(id))?;
    with_state(connection, row)
}

fn not_found(id: &str) -> CommandError {
    CommandError::not_found(format!("Проект {id} не найден"))
}

pub fn exists(connection: &Connection, id: &str) -> CommandResult<()> {
    let found = connection
        .query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |_| Ok(()))
        .optional()?;
    found.ok_or_else(|| not_found(id))
}

/// "Something the project's brief depends on changed": people, documents.
/// The stores re-read the project and its new `briefState`.
pub fn changed(id: &str) -> DataChanged {
    DataChanged::new(Entity::Project, id, Some(id), Change::Updated)
}

pub fn create(
    connection: &Connection,
    input: ProjectCreate,
) -> CommandResult<(Project, Vec<DataChanged>)> {
    let name = required(&input.name, EMPTY_NAME)?;
    let description = description_text(&input.description.unwrap_or_default())?;
    let notes = notes_text(&input.notes.unwrap_or_default())?;
    let id = new_id();
    let now = now_ms();
    let built_at = input.brief.as_ref().map(|_| now);
    connection.execute(
        "INSERT INTO projects
           (id, name, description, notes, brief, brief_built_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            name,
            description,
            notes,
            input.brief.map(Json),
            built_at,
            now
        ],
    )?;
    let project = get(connection, &id)?;
    super::analytics::project(connection, &id, now)?;
    let event = DataChanged::new(Entity::Project, &id, Some(&id), Change::Created);
    Ok((project, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: ProjectUpdate,
) -> CommandResult<(Project, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let renamed = patch
        .name
        .as_deref()
        .is_some_and(|name| name.trim() != current.name);
    let name = match patch.name {
        Some(name) => required(&name, EMPTY_NAME)?,
        None => current.name,
    };
    let description = match patch.description {
        Some(text) => description_text(&text)?,
        None => current.description,
    };
    let notes = match patch.notes {
        Some(text) => notes_text(&text)?,
        None => current.notes,
    };
    connection.execute(
        "UPDATE projects
            SET name = ?2, description = ?3, notes = ?4, updated_at = MAX(?5, updated_at + 1)
          WHERE id = ?1",
        params![id, name, description, notes, now_ms()],
    )?;
    if let Some(brief) = patch.brief {
        // Not built by the agent from known inputs: no fingerprint.
        let built_at = brief.as_ref().map(|_| now_ms());
        connection.execute(
            "UPDATE projects
                SET brief = ?2, brief_built_at = ?3, brief_inputs = NULL, brief_truncated = 0
              WHERE id = ?1",
            params![id, brief.map(Json), built_at],
        )?;
    }
    if renamed {
        super::analytics::project(connection, id, now_ms())?;
    }
    let project = get(connection, id)?;
    let event = DataChanged::new(Entity::Project, id, Some(id), Change::Updated);
    Ok((project, vec![event]))
}

/// Deletes the project with its people, calls, topics, cards, questions,
/// transcripts and documents (foreign keys cascade). One event about the
/// project. The documents' files go after the commit.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let deleted = connection.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if deleted == 0 {
        return Err(not_found(id));
    }
    let event = DataChanged::new(Entity::Project, id, Some(id), Change::Deleted);
    Ok(((), vec![event]))
}

/// A brief the agent built (projects-people-brief group 2): replaces the
/// brief, remembers `inputs` (the fingerprint of what it was built from,
/// [`brief_inputs::BriefInputs::fingerprint`] read before the build) and
/// whether the materials were shortened.
pub fn save_brief(
    connection: &Connection,
    id: &str,
    brief: &Value,
    inputs: &str,
    truncated: bool,
) -> CommandResult<(Project, Vec<DataChanged>)> {
    let now = now_ms();
    let changed = connection.execute(
        "UPDATE projects
            SET brief = ?2, brief_built_at = ?3, brief_inputs = ?4, brief_truncated = ?5,
                updated_at = MAX(?3, updated_at + 1)
          WHERE id = ?1",
        params![id, Json(brief.clone()), now, inputs, truncated],
    )?;
    if changed == 0 {
        return Err(not_found(id));
    }
    let project = get(connection, id)?;
    let event = DataChanged::new(Entity::Project, id, Some(id), Change::Updated);
    Ok((project, vec![event]))
}

/// What the home screen shows about a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverview {
    pub project_id: String,
    /// Open questions of the project's recordings.
    pub open_questions: u32,
    /// When the project's last recording started, milliseconds since the
    /// Unix epoch, UTC; `null` without recordings.
    pub last_recording_at: Option<i64>,
}

/// Every project's overview, in the order of [`list`].
pub fn overview(connection: &Connection) -> CommandResult<Vec<ProjectOverview>> {
    let mut statement = connection.prepare(
        "SELECT p.id,
                (SELECT count(*) FROM questions q JOIN recordings r ON r.id = q.recording_id
                  WHERE r.project_id = p.id AND q.status = 'open'),
                (SELECT max(r.started_at) FROM recordings r WHERE r.project_id = p.id)
           FROM projects p
          ORDER BY p.created_at, p.id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(ProjectOverview {
            project_id: row.get(0)?,
            open_questions: row.get(1)?,
            last_recording_at: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}
