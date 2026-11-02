use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{json::Json, new_id, now_ms, required};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The project brief the agent builds; `null` until there is one.
    pub brief: Option<Value>,
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
    /// `null` removes the brief; absent leaves it as it is.
    #[serde(default, deserialize_with = "super::json::double_option")]
    #[specta(optional, type = Option<Value>)]
    pub brief: Option<Option<Value>>,
}

const SELECT: &str = "SELECT p.id, p.name, p.description, p.brief, p.created_at, p.updated_at,
       (SELECT count(*) FROM questions q JOIN calls c ON c.id = q.call_id
         WHERE c.project_id = p.id AND q.status = 'open')
  FROM projects p";

fn from_row(row: &Row) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        brief: super::json::optional(row.get(3)?),
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        open_questions: row.get(6)?,
    })
}

const EMPTY_NAME: &str = "Название проекта не может быть пустым";

pub fn list(connection: &Connection) -> CommandResult<Vec<Project>> {
    let mut statement = connection.prepare(&format!("{SELECT} ORDER BY p.created_at, p.id"))?;
    let rows = statement.query_map([], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Project> {
    connection
        .query_row(&format!("{SELECT} WHERE p.id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Проект {id} не найден")))
}

pub fn exists(connection: &Connection, id: &str) -> CommandResult<()> {
    let found = connection
        .query_row("SELECT 1 FROM projects WHERE id = ?1", [id], |_| Ok(()))
        .optional()?;
    found.ok_or_else(|| CommandError::not_found(format!("Проект {id} не найден")))
}

pub fn create(
    connection: &Connection,
    input: ProjectCreate,
) -> CommandResult<(Project, Vec<DataChanged>)> {
    let name = required(&input.name, EMPTY_NAME)?;
    let id = new_id();
    let now = now_ms();
    connection.execute(
        "INSERT INTO projects (id, name, description, brief, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![
            id,
            name,
            input.description.unwrap_or_default().trim(),
            input.brief.map(Json),
            now
        ],
    )?;
    let project = get(connection, &id)?;
    let event = DataChanged::new(Entity::Project, &id, Some(&id), Change::Created);
    Ok((project, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: ProjectUpdate,
) -> CommandResult<(Project, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let name = match patch.name {
        Some(name) => required(&name, EMPTY_NAME)?,
        None => current.name,
    };
    let description = patch
        .description
        .map_or(current.description, |text| text.trim().to_owned());
    let brief = patch.brief.unwrap_or(current.brief);
    connection.execute(
        "UPDATE projects
            SET name = ?2, description = ?3, brief = ?4, updated_at = MAX(?5, updated_at + 1)
          WHERE id = ?1",
        params![id, name, description, brief.map(Json), now_ms()],
    )?;
    let project = get(connection, id)?;
    let event = DataChanged::new(Entity::Project, id, Some(id), Change::Updated);
    Ok((project, vec![event]))
}

/// Deletes the project with its people, calls, topics, cards, questions and
/// transcripts (foreign keys cascade). One event about the project.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let deleted = connection.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    if deleted == 0 {
        return Err(CommandError::not_found(format!("Проект {id} не найден")));
    }
    let event = DataChanged::new(Entity::Project, id, Some(id), Change::Deleted);
    Ok(((), vec![event]))
}
