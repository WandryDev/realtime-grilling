use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

use super::{json::Json, new_id, now_ms, projects, required};
use crate::{
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

/// A person of the client. Stored once per project; calls refer to it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub role: String,
    /// What the screens show about the person: `howToAsk`, `askStyle`,
    /// `tech` / `project` levels (1–5), `portrait`, `notes`, `suggestion`,
    /// `initials`. An object; its shape belongs to the frontend for now.
    pub profile: Value,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonCreate {
    pub project_id: String,
    pub name: String,
    #[specta(optional)]
    pub role: Option<String>,
    #[specta(optional)]
    pub profile: Option<Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PersonUpdate {
    #[specta(optional)]
    pub name: Option<String>,
    #[specta(optional)]
    pub role: Option<String>,
    /// Replaces the whole profile.
    #[specta(optional)]
    pub profile: Option<Value>,
}

const SELECT: &str =
    "SELECT id, project_id, name, role, profile, created_at, updated_at FROM people";

const EMPTY_NAME: &str = "Имя человека не может быть пустым";

pub(super) fn from_row(row: &Row) -> rusqlite::Result<Person> {
    let Json(profile) = row.get(4)?;
    Ok(Person {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        role: row.get(3)?,
        profile,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn profile_object(profile: Option<Value>) -> CommandResult<Value> {
    match profile {
        None => Ok(Value::Object(serde_json::Map::new())),
        Some(value @ Value::Object(_)) => Ok(value),
        Some(_) => Err(CommandError::invalid(
            "Профиль человека должен быть объектом",
        )),
    }
}

pub fn list(connection: &Connection, project_id: &str) -> CommandResult<Vec<Person>> {
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE project_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map([project_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Person> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| CommandError::not_found(format!("Человек {id} не найден")))
}

pub fn create(
    connection: &Connection,
    input: PersonCreate,
) -> CommandResult<(Person, Vec<DataChanged>)> {
    let name = required(&input.name, EMPTY_NAME)?;
    let profile = profile_object(input.profile)?;
    projects::exists(connection, &input.project_id)?;
    let id = new_id();
    connection.execute(
        "INSERT INTO people (id, project_id, name, role, profile, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![
            id,
            input.project_id,
            name,
            input.role.unwrap_or_default().trim(),
            Json(profile),
            now_ms()
        ],
    )?;
    let person = get(connection, &id)?;
    let event = DataChanged::new(
        Entity::Person,
        &id,
        Some(&person.project_id),
        Change::Created,
    );
    Ok((person, vec![event]))
}

pub fn update(
    connection: &Connection,
    id: &str,
    patch: PersonUpdate,
) -> CommandResult<(Person, Vec<DataChanged>)> {
    let current = get(connection, id)?;
    let name = match patch.name {
        Some(name) => required(&name, EMPTY_NAME)?,
        None => current.name,
    };
    let role = patch
        .role
        .map_or(current.role, |role| role.trim().to_owned());
    let profile = match patch.profile {
        Some(profile) => profile_object(Some(profile))?,
        None => current.profile,
    };
    connection.execute(
        "UPDATE people SET name = ?2, role = ?3, profile = ?4, updated_at = MAX(?5, updated_at + 1)
          WHERE id = ?1",
        params![id, name, role, Json(profile), now_ms()],
    )?;
    let person = get(connection, id)?;
    let event = DataChanged::new(
        Entity::Person,
        id,
        Some(&person.project_id),
        Change::Updated,
    );
    Ok((person, vec![event]))
}

/// Deletes the person; they leave every call they took part in.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let person = get(connection, id)?;
    connection.execute("DELETE FROM people WHERE id = ?1", [id])?;
    let event = DataChanged::new(
        Entity::Person,
        id,
        Some(&person.project_id),
        Change::Deleted,
    );
    Ok(((), vec![event]))
}
