use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{calls, json::Json, new_id, now_ms, required, task_cards, topics};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QuestionStatus {
    Open,
    Answered,
    Dismissed,
}

impl QuestionStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Answered => "answered",
            Self::Dismissed => "dismissed",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "open" => Ok(Self::Open),
            "answered" => Ok(Self::Answered),
            "dismissed" => Ok(Self::Dismissed),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                format!("unknown question status {other}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub call_id: String,
    pub topic_id: Option<String>,
    pub card_id: Option<String>,
    pub text: String,
    pub status: QuestionStatus,
    /// Higher comes first.
    pub priority: i32,
    /// Why the agent asks: quotes, contradictions, sources. Its shape belongs
    /// to the frontend for now.
    pub evidence: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionCreate {
    pub call_id: String,
    pub text: String,
    /// A topic of the same call.
    #[specta(optional)]
    pub topic_id: Option<String>,
    /// A task card of the same call.
    #[specta(optional)]
    pub card_id: Option<String>,
    /// `open` when absent.
    #[specta(optional)]
    pub status: Option<QuestionStatus>,
    #[specta(optional)]
    pub priority: Option<i32>,
    /// `[]` when absent.
    #[specta(optional)]
    pub evidence: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuestionUpdate {
    #[specta(optional)]
    pub text: Option<String>,
    #[specta(optional)]
    pub status: Option<QuestionStatus>,
    #[specta(optional)]
    pub priority: Option<i32>,
    #[specta(optional)]
    pub evidence: Option<Value>,
    /// Moves the question to another topic of the same call; `null`
    /// detaches it, absent leaves it as it is.
    #[serde(default, deserialize_with = "super::json::double_option")]
    #[specta(optional, type = Option<String>)]
    pub topic_id: Option<Option<String>>,
    /// Like `topicId`, for a task card of the same call.
    #[serde(default, deserialize_with = "super::json::double_option")]
    #[specta(optional, type = Option<String>)]
    pub card_id: Option<Option<String>>,
}

const SELECT: &str = "SELECT id, call_id, topic_id, card_id, text, status, priority, evidence,
       created_at, updated_at
  FROM questions";

const EMPTY_TEXT: &str = "Текст вопроса не может быть пустым";

fn from_row(row: &Row) -> rusqlite::Result<Question> {
    let status: String = row.get(5)?;
    let Json(evidence) = row.get(7)?;
    Ok(Question {
        id: row.get(0)?,
        call_id: row.get(1)?,
        topic_id: row.get(2)?,
        card_id: row.get(3)?,
        text: row.get(4)?,
        status: QuestionStatus::parse(&status)?,
        priority: row.get(6)?,
        evidence,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

/// Topic and card must belong to the question's call.
fn check_links(
    connection: &Connection,
    call_id: &str,
    topic_id: Option<&str>,
    card_id: Option<&str>,
) -> CommandResult<()> {
    if let Some(topic_id) = topic_id
        && topics::get(connection, topic_id)?.call_id != call_id
    {
        return Err(CommandError::invalid("Тема относится к другому звонку"));
    }
    if let Some(card_id) = card_id
        && task_cards::get(connection, card_id)?.call_id != call_id
    {
        return Err(CommandError::invalid(
            "Карточка задачи относится к другому звонку",
        ));
    }
    Ok(())
}

/// The questions of a call: by priority, then oldest first.
pub fn list(connection: &Connection, call_id: &str) -> CommandResult<Vec<Question>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE call_id = ?1 ORDER BY priority DESC, created_at, id"
    ))?;
    let rows = statement.query_map([call_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Question> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Вопрос {id} не найден")))
}

pub fn create(
    connection: &Connection,
    input: QuestionCreate,
) -> CommandResult<(Question, Vec<DataChanged>)> {
    let text = required(&input.text, EMPTY_TEXT)?;
    let project_id = calls::project_of(connection, &input.call_id)?;
    check_links(
        connection,
        &input.call_id,
        input.topic_id.as_deref(),
        input.card_id.as_deref(),
    )?;
    let id = new_id();
    connection.execute(
        "INSERT INTO questions
           (id, call_id, topic_id, card_id, text, status, priority, evidence, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            id,
            input.call_id,
            input.topic_id,
            input.card_id,
            text,
            input.status.unwrap_or(QuestionStatus::Open).as_str(),
            input.priority.unwrap_or(0),
            Json(input.evidence.unwrap_or_else(|| Value::Array(Vec::new()))),
            now_ms()
        ],
    )?;
    let question = get(connection, &id)?;
    let event = DataChanged::new(Entity::Question, &id, Some(&project_id), Change::Created);
    Ok((question, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: QuestionUpdate,
) -> CommandResult<(Question, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let text = match patch.text {
        Some(text) => required(&text, EMPTY_TEXT)?,
        None => current.text,
    };
    let topic_id = patch.topic_id.unwrap_or(current.topic_id);
    let card_id = patch.card_id.unwrap_or(current.card_id);
    check_links(
        connection,
        &current.call_id,
        topic_id.as_deref(),
        card_id.as_deref(),
    )?;
    connection.execute(
        "UPDATE questions
            SET text = ?2, status = ?3, priority = ?4, evidence = ?5, topic_id = ?6, card_id = ?7,
                updated_at = MAX(?8, updated_at + 1)
          WHERE id = ?1",
        params![
            id,
            text,
            patch.status.unwrap_or(current.status).as_str(),
            patch.priority.unwrap_or(current.priority),
            Json(patch.evidence.unwrap_or(current.evidence)),
            topic_id,
            card_id,
            now_ms()
        ],
    )?;
    let project_id = calls::project_of(connection, &current.call_id)?;
    let question = get(connection, id)?;
    let event = DataChanged::new(Entity::Question, id, Some(&project_id), Change::Updated);
    Ok((question, vec![event]))
}

pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let question = get(connection, id)?;
    let project_id = calls::project_of(connection, &question.call_id)?;
    connection.execute("DELETE FROM questions WHERE id = ?1", [id])?;
    let event = DataChanged::new(Entity::Question, id, Some(&project_id), Change::Deleted);
    Ok(((), vec![event]))
}
