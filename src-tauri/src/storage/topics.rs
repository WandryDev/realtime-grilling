use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{calls, new_id, now_ms, required};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

/// A topic of a call: its task card and questions hang off it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub call_id: String,
    pub title: String,
    /// Order within the call, ascending.
    pub position: i32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicCreate {
    pub call_id: String,
    pub title: String,
    /// After the last topic when absent.
    #[specta(optional)]
    pub position: Option<i32>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TopicUpdate {
    #[specta(optional)]
    pub title: Option<String>,
    #[specta(optional)]
    pub position: Option<i32>,
}

const SELECT: &str = "SELECT id, call_id, title, position, created_at, updated_at FROM topics";

const EMPTY_TITLE: &str = "Название темы не может быть пустым";

fn from_row(row: &Row) -> rusqlite::Result<Topic> {
    Ok(Topic {
        id: row.get(0)?,
        call_id: row.get(1)?,
        title: row.get(2)?,
        position: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

pub fn list(connection: &Connection, call_id: &str) -> CommandResult<Vec<Topic>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE call_id = ?1 ORDER BY position, id"
    ))?;
    let rows = statement.query_map([call_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Topic> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Тема {id} не найдена")))
}

pub fn create(
    connection: &Connection,
    input: TopicCreate,
) -> CommandResult<(Topic, Vec<DataChanged>)> {
    let title = required(&input.title, EMPTY_TITLE)?;
    let project_id = calls::project_of(connection, &input.call_id)?;
    let position = match input.position {
        Some(position) => position,
        None => connection.query_row(
            "SELECT coalesce(max(position) + 1, 0) FROM topics WHERE call_id = ?1",
            [&input.call_id],
            |row| row.get(0),
        )?,
    };
    let id = new_id();
    connection.execute(
        "INSERT INTO topics (id, call_id, title, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, input.call_id, title, position, now_ms()],
    )?;
    let topic = get(connection, &id)?;
    let event = DataChanged::new(Entity::Topic, &id, Some(&project_id), Change::Created);
    Ok((topic, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: TopicUpdate,
) -> CommandResult<(Topic, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let title = match patch.title {
        Some(title) => required(&title, EMPTY_TITLE)?,
        None => current.title,
    };
    connection.execute(
        "UPDATE topics SET title = ?2, position = ?3, updated_at = MAX(?4, updated_at + 1)
          WHERE id = ?1",
        params![
            id,
            title,
            patch.position.unwrap_or(current.position),
            now_ms()
        ],
    )?;
    let project_id = calls::project_of(connection, &current.call_id)?;
    let topic = get(connection, id)?;
    let event = DataChanged::new(Entity::Topic, id, Some(&project_id), Change::Updated);
    Ok((topic, vec![event]))
}

/// Deletes the topic with its task cards; its questions stay without a topic.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let topic = get(connection, id)?;
    let project_id = calls::project_of(connection, &topic.call_id)?;
    connection.execute("DELETE FROM topics WHERE id = ?1", [id])?;
    let event = DataChanged::new(Entity::Topic, id, Some(&project_id), Change::Deleted);
    Ok(((), vec![event]))
}
