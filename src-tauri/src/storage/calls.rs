use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{
    json::{self, Json},
    new_id, now_ms, people, projects,
};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CallStatus {
    /// Recording.
    Live,
    /// "Завершить" was pressed: the agent collects the summary.
    Finishing,
    Finished,
}

impl CallStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Finishing => "finishing",
            Self::Finished => "finished",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "live" => Ok(Self::Live),
            "finishing" => Ok(Self::Finishing),
            "finished" => Ok(Self::Finished),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown call status {other}").into(),
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Call {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub status: CallStatus,
    /// Milliseconds since the Unix epoch, UTC.
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    /// Summary state, proposal and task-card reviews, recording state.
    /// Its shape belongs to the frontend for now.
    pub summary: Option<Value>,
    /// People of the project on the call, in the order they were added.
    pub participant_ids: Vec<String>,
    pub open_questions: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallCreate {
    pub project_id: String,
    #[specta(optional)]
    pub title: Option<String>,
    /// `live` when absent.
    #[specta(optional)]
    pub status: Option<CallStatus>,
    /// Now when absent.
    #[specta(optional)]
    pub started_at: Option<i64>,
    #[specta(optional)]
    pub ended_at: Option<i64>,
    #[specta(optional)]
    pub summary: Option<Value>,
    #[specta(optional)]
    pub participant_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallUpdate {
    #[specta(optional)]
    pub title: Option<String>,
    #[specta(optional)]
    pub status: Option<CallStatus>,
    /// `null` clears it; absent leaves it as it is.
    #[serde(default, deserialize_with = "json::double_option")]
    #[specta(optional, type = Option<i64>)]
    pub started_at: Option<Option<i64>>,
    /// `null` clears it ("Отменить завершение"); absent leaves it as it is.
    #[serde(default, deserialize_with = "json::double_option")]
    #[specta(optional, type = Option<i64>)]
    pub ended_at: Option<Option<i64>>,
    /// Replaces the whole summary; `null` clears it. To change some keys,
    /// use `calls_patch_summary`.
    #[serde(default, deserialize_with = "json::double_option")]
    #[specta(optional, type = Option<Value>)]
    pub summary: Option<Option<Value>>,
}

const SELECT: &str = "SELECT c.id, c.project_id, c.title, c.status, c.started_at, c.ended_at,
       c.summary, c.created_at, c.updated_at,
       (SELECT count(*) FROM questions q WHERE q.call_id = c.id AND q.status = 'open'),
       (SELECT json_group_array(person_id)
          FROM (SELECT person_id FROM call_participants p WHERE p.call_id = c.id ORDER BY rowid))
  FROM calls c";

fn from_row(row: &Row) -> rusqlite::Result<Call> {
    let status: String = row.get(3)?;
    let Json(participants) = row.get(10)?;
    Ok(Call {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        status: CallStatus::parse(&status)?,
        started_at: row.get(4)?,
        ended_at: row.get(5)?,
        summary: json::optional(row.get(6)?),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        open_questions: row.get(9)?,
        participant_ids: serde_json::from_value(participants).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                10,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
    })
}

fn check_times(started_at: Option<i64>, ended_at: Option<i64>) -> CommandResult<()> {
    if let (Some(start), Some(end)) = (started_at, ended_at)
        && end < start
    {
        return Err(CommandError::invalid(
            "Звонок не может закончиться раньше, чем начался",
        ));
    }
    Ok(())
}

/// Calls of a project, or every call when `project_id` is `None`; newest first.
pub fn list(connection: &Connection, project_id: Option<&str>) -> CommandResult<Vec<Call>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE ?1 IS NULL OR c.project_id = ?1
          ORDER BY coalesce(c.started_at, c.created_at) DESC, c.id DESC"
    ))?;
    let rows = statement.query_map([project_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Call> {
    connection
        .query_row(&format!("{SELECT} WHERE c.id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Звонок {id} не найден")))
}

/// The call's project; `NotFound` when there is no such call.
pub fn project_of(connection: &Connection, id: &str) -> CommandResult<String> {
    connection
        .query_row("SELECT project_id FROM calls WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Звонок {id} не найден")))
}

pub fn create(
    connection: &Connection,
    input: CallCreate,
) -> CommandResult<(Call, Vec<DataChanged>)> {
    projects::exists(connection, &input.project_id)?;
    let now = now_ms();
    let started_at = input.started_at.or(Some(now));
    check_times(started_at, input.ended_at)?;
    let id = new_id();
    connection.execute(
        "INSERT INTO calls
           (id, project_id, title, status, started_at, ended_at, summary, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            input.project_id,
            input.title.unwrap_or_default().trim(),
            input.status.unwrap_or(CallStatus::Live).as_str(),
            started_at,
            input.ended_at,
            input.summary.map(Json),
            now
        ],
    )?;
    for person_id in input.participant_ids.unwrap_or_default() {
        insert_participant(connection, &id, &input.project_id, &person_id)?;
    }
    let call = get(connection, &id)?;
    let event = DataChanged::new(Entity::Call, &id, Some(&call.project_id), Change::Created);
    Ok((call, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: CallUpdate,
) -> CommandResult<(Call, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let started_at = patch.started_at.unwrap_or(current.started_at);
    let ended_at = patch.ended_at.unwrap_or(current.ended_at);
    check_times(started_at, ended_at)?;
    connection.execute(
        "UPDATE calls
            SET title = ?2, status = ?3, started_at = ?4, ended_at = ?5, summary = ?6,
                updated_at = MAX(?7, updated_at + 1)
          WHERE id = ?1",
        params![
            id,
            patch
                .title
                .map_or(current.title, |title| title.trim().to_owned()),
            patch.status.unwrap_or(current.status).as_str(),
            started_at,
            ended_at,
            patch.summary.unwrap_or(current.summary).map(Json),
            now_ms()
        ],
    )?;
    let call = get(connection, id)?;
    let event = DataChanged::new(Entity::Call, id, Some(&call.project_id), Change::Updated);
    Ok((call, vec![event]))
}

/// Applies an RFC 7386 merge patch to the call's `summary` inside the
/// write's transaction, so two windows (or two quick decisions) changing
/// different keys never lose each other's change. A `null` summary is
/// patched as `{}`; a result of `null` clears it.
pub fn patch_summary(
    connection: &Connection,
    id: &str,
    patch: &Value,
) -> CommandResult<(Call, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let mut summary = current.summary.unwrap_or(Value::Null);
    json::merge_patch(&mut summary, patch);
    let summary = (!summary.is_null()).then_some(summary);
    connection.execute(
        "UPDATE calls SET summary = ?2, updated_at = MAX(?3, updated_at + 1) WHERE id = ?1",
        params![id, summary.map(Json), now_ms()],
    )?;
    let call = get(connection, id)?;
    let event = DataChanged::new(Entity::Call, id, Some(&call.project_id), Change::Updated);
    Ok((call, vec![event]))
}

/// Deletes the call with its topics, cards, questions and transcript.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let project_id = project_of(connection, id)?;
    connection.execute("DELETE FROM calls WHERE id = ?1", [id])?;
    let event = DataChanged::new(Entity::Call, id, Some(&project_id), Change::Deleted);
    Ok(((), vec![event]))
}

fn insert_participant(
    connection: &Connection,
    call_id: &str,
    project_id: &str,
    person_id: &str,
) -> CommandResult<()> {
    let person = people::get(connection, person_id)?;
    if person.project_id != project_id {
        return Err(CommandError::invalid(format!(
            "{} из другого проекта и не может быть участником этого звонка",
            person.name
        )));
    }
    connection.execute(
        "INSERT OR IGNORE INTO call_participants (call_id, person_id) VALUES (?1, ?2)",
        [call_id, person_id],
    )?;
    Ok(())
}

fn touch(connection: &Connection, id: &str) -> CommandResult<()> {
    connection.execute(
        "UPDATE calls SET updated_at = MAX(?2, updated_at + 1) WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

/// The people on the call, in the order they were added.
pub fn participants(connection: &Connection, call_id: &str) -> CommandResult<Vec<people::Person>> {
    project_of(connection, call_id)?;
    let mut statement = connection.prepare(
        "SELECT p.id, p.project_id, p.name, p.role, p.profile, p.created_at, p.updated_at
           FROM call_participants cp JOIN people p ON p.id = cp.person_id
          WHERE cp.call_id = ?1 ORDER BY cp.rowid",
    )?;
    let rows = statement.query_map([call_id], people::from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Adds a person of the same project to the call. Sends `call` / `updated`.
pub fn add_participant(
    connection: &Connection,
    call_id: &str,
    person_id: &str,
) -> CommandResult<(Call, Vec<DataChanged>)> {
    let project_id = project_of(connection, call_id)?;
    insert_participant(connection, call_id, &project_id, person_id)?;
    touch(connection, call_id)?;
    let call = get(connection, call_id)?;
    let event = DataChanged::new(Entity::Call, call_id, Some(&project_id), Change::Updated);
    Ok((call, vec![event]))
}

pub fn remove_participant(
    connection: &Connection,
    call_id: &str,
    person_id: &str,
) -> CommandResult<(Call, Vec<DataChanged>)> {
    let project_id = project_of(connection, call_id)?;
    let removed = connection.execute(
        "DELETE FROM call_participants WHERE call_id = ?1 AND person_id = ?2",
        [call_id, person_id],
    )?;
    if removed == 0 {
        return Err(CommandError::not_found(format!(
            "Человек {person_id} не участвует в звонке {call_id}"
        )));
    }
    touch(connection, call_id)?;
    let call = get(connection, call_id)?;
    let event = DataChanged::new(Entity::Call, call_id, Some(&project_id), Change::Updated);
    Ok((call, vec![event]))
}
