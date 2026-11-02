use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{calls, json::Json, new_id, now_ms, topics};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TaskCardDecision {
    Pending,
    Accepted,
    Discarded,
}

impl TaskCardDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Accepted => "accepted",
            Self::Discarded => "discarded",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "pending" => Ok(Self::Pending),
            "accepted" => Ok(Self::Accepted),
            "discarded" => Ok(Self::Discarded),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Text,
                format!("unknown task card decision {other}").into(),
            )),
        }
    }
}

/// The task card of a topic.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCard {
    pub id: String,
    pub topic_id: String,
    /// The topic's call.
    pub call_id: String,
    pub title: String,
    /// The card's fields with their facts. Its shape belongs to the frontend
    /// until the agent writes cards (tasks 6 and 8).
    pub fields: Value,
    pub decision: TaskCardDecision,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCardCreate {
    pub topic_id: String,
    #[specta(optional)]
    pub title: Option<String>,
    /// `[]` when absent.
    #[specta(optional)]
    pub fields: Option<Value>,
    /// `pending` when absent.
    #[specta(optional)]
    pub decision: Option<TaskCardDecision>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskCardUpdate {
    #[specta(optional)]
    pub title: Option<String>,
    /// Replaces all fields.
    #[specta(optional)]
    pub fields: Option<Value>,
    #[specta(optional)]
    pub decision: Option<TaskCardDecision>,
}

const SELECT: &str = "SELECT id, topic_id, call_id, title, fields, created_at, decision, updated_at
  FROM task_cards";

fn from_row(row: &Row) -> rusqlite::Result<TaskCard> {
    let Json(fields) = row.get(4)?;
    let decision: String = row.get(6)?;
    Ok(TaskCard {
        id: row.get(0)?,
        topic_id: row.get(1)?,
        call_id: row.get(2)?,
        title: row.get(3)?,
        fields,
        created_at: row.get(5)?,
        decision: TaskCardDecision::parse(&decision)?,
        updated_at: row.get(7)?,
    })
}

/// The cards of a call, in topic order.
pub fn list(connection: &Connection, call_id: &str) -> CommandResult<Vec<TaskCard>> {
    let mut statement = connection.prepare(
        "SELECT k.id, k.topic_id, k.call_id, k.title, k.fields, k.created_at, k.decision,
                k.updated_at
           FROM task_cards k JOIN topics t ON t.id = k.topic_id
          WHERE k.call_id = ?1 ORDER BY t.position, k.created_at, k.id",
    )?;
    let rows = statement.query_map([call_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<TaskCard> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Карточка задачи {id} не найдена")))
}

pub fn create(
    connection: &Connection,
    input: TaskCardCreate,
) -> CommandResult<(TaskCard, Vec<DataChanged>)> {
    let topic = topics::get(connection, &input.topic_id)?;
    let project_id = calls::project_of(connection, &topic.call_id)?;
    let id = new_id();
    connection.execute(
        "INSERT INTO task_cards (id, topic_id, call_id, title, fields, decision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            id,
            topic.id,
            topic.call_id,
            input.title.unwrap_or_default().trim(),
            Json(input.fields.unwrap_or_else(|| Value::Array(Vec::new()))),
            input.decision.unwrap_or(TaskCardDecision::Pending).as_str(),
            now_ms()
        ],
    )?;
    let card = get(connection, &id)?;
    let event = DataChanged::new(Entity::TaskCard, &id, Some(&project_id), Change::Created);
    Ok((card, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: TaskCardUpdate,
) -> CommandResult<(TaskCard, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    connection.execute(
        "UPDATE task_cards SET title = ?2, fields = ?3, decision = ?4,
                updated_at = MAX(?5, updated_at + 1)
          WHERE id = ?1",
        params![
            id,
            patch
                .title
                .map_or(current.title, |title| title.trim().to_owned()),
            Json(patch.fields.unwrap_or(current.fields)),
            patch.decision.unwrap_or(current.decision).as_str(),
            now_ms()
        ],
    )?;
    let project_id = calls::project_of(connection, &current.call_id)?;
    let card = get(connection, id)?;
    let event = DataChanged::new(Entity::TaskCard, id, Some(&project_id), Change::Updated);
    Ok((card, vec![event]))
}

/// Deletes the card; its questions stay without a card.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let card = get(connection, id)?;
    let project_id = calls::project_of(connection, &card.call_id)?;
    connection.execute("DELETE FROM task_cards WHERE id = ?1", [id])?;
    let event = DataChanged::new(Entity::TaskCard, id, Some(&project_id), Change::Deleted);
    Ok(((), vec![event]))
}
