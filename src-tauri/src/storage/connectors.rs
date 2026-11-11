//! Connections of the connectors, the projects' selections in them and the
//! state of each project's last sync (connectors-outline design.md,
//! decision 3). No secret is ever here: they live in the OS store
//! (`connectors::secrets`).
//!
//! Events: `connections` (id: the connector's kind, no project) after a
//! connection changes; `connectorSelections` (id: the kind, the project)
//! after a project's selection or sync state changes without its sources.
//! A sync that changes sources sends the project's `DataChanged` instead,
//! one per sync: the stores of a project's selection re-read on it too.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use specta::Type;

use super::{new_id, projects};
use crate::{
    connectors::{Account, ConnectorKind, ErrorKind, SelectionItem, SelectionItemKind},
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity},
};

/* Events */

pub fn connection_changed(kind: ConnectorKind, change: Change) -> DataChanged {
    DataChanged::new(Entity::Connections, kind.as_str(), None, change)
}

pub fn selection_changed(project_id: &str, kind: ConnectorKind) -> DataChanged {
    DataChanged::new(
        Entity::ConnectorSelections,
        kind.as_str(),
        Some(project_id),
        Change::Updated,
    )
}

fn kind_of(text: &str, column: usize) -> rusqlite::Result<ConnectorKind> {
    ConnectorKind::parse(text)
        .ok_or_else(|| conversion(column, format!("unknown connector {text}")))
}

fn error_kind_of(text: Option<String>, column: usize) -> rusqlite::Result<Option<ErrorKind>> {
    text.map(|text| {
        ErrorKind::parse(&text).ok_or_else(|| conversion(column, format!("unknown error {text}")))
    })
    .transpose()
}

fn conversion(column: usize, message: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, message.into())
}

/* Connections */

/// Connected, or the service refused the secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Connected,
    Error,
}

/// A connection as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredConnection {
    pub kind: ConnectorKind,
    pub status: ConnectionStatus,
    pub account: Account,
    pub connected_at: i64,
    pub last_ok_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    pub error_kind: Option<ErrorKind>,
    pub error: Option<String>,
}

const CONNECTION: &str = "SELECT kind, status, account, connected_at, last_ok_at, last_attempt_at,
       error_kind, error
  FROM connections";

fn connection_from_row(row: &Row) -> rusqlite::Result<StoredConnection> {
    let kind: String = row.get(0)?;
    let status: String = row.get(1)?;
    let account: String = row.get(2)?;
    Ok(StoredConnection {
        kind: kind_of(&kind, 0)?,
        status: if status == "error" {
            ConnectionStatus::Error
        } else {
            ConnectionStatus::Connected
        },
        account: serde_json::from_str(&account)
            .map_err(|error| conversion(2, error.to_string()))?,
        connected_at: row.get(3)?,
        last_ok_at: row.get(4)?,
        last_attempt_at: row.get(5)?,
        error_kind: error_kind_of(row.get(6)?, 6)?,
        error: row.get(7)?,
    })
}

pub fn connection(
    connection: &Connection,
    kind: ConnectorKind,
) -> CommandResult<Option<StoredConnection>> {
    Ok(connection
        .query_row(
            &format!("{CONNECTION} WHERE kind = ?1"),
            [kind.as_str()],
            connection_from_row,
        )
        .optional()?)
}

pub fn connections(connection: &Connection) -> CommandResult<Vec<StoredConnection>> {
    let mut statement = connection.prepare(&format!("{CONNECTION} ORDER BY kind"))?;
    let rows = statement.query_map([], connection_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Connects (or reconnects) after a successful check: `connected`, no
/// error, the new account.
pub fn save_connected(
    connection: &Connection,
    kind: ConnectorKind,
    account: &Account,
    now: i64,
) -> CommandResult<(StoredConnection, Vec<DataChanged>)> {
    let existed = self::connection(connection, kind)?.is_some();
    connection.execute(
        "INSERT INTO connections
           (kind, status, account, connected_at, last_ok_at, last_attempt_at, error_kind, error)
         VALUES (?1, 'connected', ?2, ?3, ?3, ?3, NULL, NULL)
         ON CONFLICT (kind) DO UPDATE SET
           status = 'connected', account = excluded.account,
           connected_at = excluded.connected_at, last_ok_at = excluded.last_ok_at,
           last_attempt_at = excluded.last_attempt_at, error_kind = NULL, error = NULL",
        params![kind.as_str(), serde_json::to_string(account)?, now],
    )?;
    let saved = self::connection(connection, kind)?
        .ok_or_else(|| CommandError::storage("Подключение не сохранилось"))?;
    let change = if existed {
        Change::Updated
    } else {
        Change::Created
    };
    Ok((saved, vec![connection_changed(kind, change)]))
}

/// The service answered: `connected`, the error cleared, `last_ok_at` now,
/// the account as the service gave it (when it did). The event goes out
/// only when the status, the error or the account changed: a sync that
/// only moved the time sends none of its own.
pub fn record_ok(
    connection: &Connection,
    kind: ConnectorKind,
    account: Option<&Account>,
    now: i64,
) -> CommandResult<Vec<DataChanged>> {
    let Some(before) = self::connection(connection, kind)? else {
        return Ok(Vec::new());
    };
    let account = account.unwrap_or(&before.account);
    connection.execute(
        "UPDATE connections SET status = 'connected', account = ?2, last_ok_at = ?3,
                last_attempt_at = ?3, error_kind = NULL, error = NULL
          WHERE kind = ?1",
        params![kind.as_str(), serde_json::to_string(account)?, now],
    )?;
    let visible = before.status != ConnectionStatus::Connected
        || before.error_kind.is_some()
        || &before.account != account;
    Ok(if visible {
        vec![connection_changed(kind, Change::Updated)]
    } else {
        Vec::new()
    })
}

/// The service failed. When it refused the secret (`breaks`) the
/// connection goes to `error`; a network failure keeps it `connected` with
/// the error and the attempt's time (`connectors`, «Нет интернета»).
pub fn record_failure(
    connection: &Connection,
    kind: ConnectorKind,
    error_kind: ErrorKind,
    message: &str,
    breaks: bool,
    now: i64,
) -> CommandResult<Vec<DataChanged>> {
    let updated = connection.execute(
        "UPDATE connections
            SET status = CASE WHEN ?5 THEN 'error' ELSE status END,
                last_attempt_at = ?4, error_kind = ?2, error = ?3
          WHERE kind = ?1",
        params![kind.as_str(), error_kind.as_str(), message, now, breaks],
    )?;
    Ok(if updated == 0 {
        Vec::new()
    } else {
        vec![connection_changed(kind, Change::Updated)]
    })
}

/// Disconnects: the row goes, the projects' selections and sources stay.
pub fn delete_connection(
    connection: &Connection,
    kind: ConnectorKind,
) -> CommandResult<(bool, Vec<DataChanged>)> {
    let deleted = connection.execute("DELETE FROM connections WHERE kind = ?1", [kind.as_str()])?;
    Ok(if deleted == 0 {
        (false, Vec::new())
    } else {
        (true, vec![connection_changed(kind, Change::Deleted)])
    })
}

/* Selections */

/// Whether the service still has a selection item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ItemStatus {
    Ok,
    /// Deleted in the service, no access, or of another team.
    Unavailable,
}

/// A selection item as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredItem {
    pub item: SelectionItem,
    /// The team the item belongs to.
    pub account_ref: String,
    pub status: ItemStatus,
}

pub fn selection(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
) -> CommandResult<Vec<StoredItem>> {
    let mut statement = connection.prepare(
        "SELECT item_kind, external_id, title, url, account_ref, status
           FROM connector_selections
          WHERE project_id = ?1 AND connector = ?2
          ORDER BY created_at, id",
    )?;
    let rows = statement.query_map(params![project_id, kind.as_str()], |row| {
        let item_kind: String = row.get(0)?;
        let status: String = row.get(5)?;
        Ok(StoredItem {
            item: SelectionItem {
                item_kind: SelectionItemKind::parse(&item_kind)
                    .ok_or_else(|| conversion(0, format!("unknown item kind {item_kind}")))?,
                external_id: row.get(1)?,
                title: row.get(2)?,
                url: row.get(3)?,
            },
            account_ref: row.get(4)?,
            status: if status == "unavailable" {
                ItemStatus::Unavailable
            } else {
                ItemStatus::Ok
            },
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Replaces the project's selection in the connector. Items already there
/// (same kind and id) keep their status; the same item twice is kept once.
/// `NotFound` for an unknown project.
pub fn replace_selection(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
    account_ref: &str,
    items: &[SelectionItem],
    now: i64,
) -> CommandResult<Vec<DataChanged>> {
    projects::exists(connection, project_id)?;
    let before = selection(connection, project_id, kind)?;
    connection.execute(
        "DELETE FROM connector_selections WHERE project_id = ?1 AND connector = ?2",
        params![project_id, kind.as_str()],
    )?;
    for item in items {
        let external_id = item.external_id.trim();
        if external_id.is_empty() {
            return Err(CommandError::invalid("У пункта выбора нет идентификатора"));
        }
        let kept = before.iter().find(|stored| {
            stored.item.item_kind == item.item_kind
                && stored.item.external_id == external_id
                && stored.account_ref == account_ref
        });
        let status = match kept.map(|stored| stored.status) {
            Some(ItemStatus::Unavailable) => "unavailable",
            _ => "ok",
        };
        connection.execute(
            "INSERT INTO connector_selections
               (id, project_id, connector, account_ref, item_kind, external_id, title, url,
                status, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT (project_id, connector, external_id, item_kind) DO NOTHING",
            params![
                new_id(),
                project_id,
                kind.as_str(),
                account_ref,
                item.item_kind.as_str(),
                external_id,
                item.title.trim(),
                item.url,
                status,
                now
            ],
        )?;
    }
    Ok(vec![selection_changed(project_id, kind)])
}

/// Marks the items in `unavailable` (by external id) unavailable and the
/// rest available. `true` when a status changed.
pub fn set_item_statuses(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
    unavailable: &[String],
    now: i64,
) -> CommandResult<bool> {
    let mut changed = 0;
    for stored in selection(connection, project_id, kind)? {
        let status = if unavailable.contains(&stored.item.external_id) {
            "unavailable"
        } else {
            "ok"
        };
        changed += connection.execute(
            "UPDATE connector_selections SET status = ?5, updated_at = ?6
              WHERE project_id = ?1 AND connector = ?2 AND external_id = ?3
                AND item_kind = ?4 AND status != ?5",
            params![
                project_id,
                kind.as_str(),
                stored.item.external_id,
                stored.item.item_kind.as_str(),
                status,
                now
            ],
        )?;
    }
    Ok(changed > 0)
}

/// The projects with a selection in the connector.
pub fn projects_with_selection(
    connection: &Connection,
    kind: ConnectorKind,
) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT DISTINCT project_id FROM connector_selections WHERE connector = ?1
          ORDER BY project_id",
    )?;
    let rows = statement.query_map([kind.as_str()], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// The connectors the project has a selection in or sources of.
pub fn kinds_of_project(
    connection: &Connection,
    project_id: &str,
) -> CommandResult<Vec<ConnectorKind>> {
    let mut statement = connection.prepare(
        "SELECT connector FROM connector_selections WHERE project_id = ?1
         UNION
         SELECT connector FROM project_sources WHERE project_id = ?1 AND kind = 'connector'",
    )?;
    let names: Vec<String> = statement
        .query_map([project_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(ConnectorKind::ALL
        .into_iter()
        .filter(|kind| names.iter().any(|name| name == kind.as_str()))
        .collect())
}

/* Sync state */

/// A project's last sync with a connector.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    /// «Обновлено …»; `null` before the first successful sync.
    pub last_ok_at: Option<i64>,
    pub last_attempt_at: Option<i64>,
    /// Why the last attempt failed: «Не обновлялось: …»; `null` after a
    /// success.
    pub error_kind: Option<ErrorKind>,
    pub error: Option<String>,
    /// Documents over the limit of 200 the last sync left out
    /// («N не загружены»).
    pub skipped: u32,
}

pub fn sync_state(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
) -> CommandResult<Option<SyncState>> {
    Ok(connection
        .query_row(
            "SELECT last_ok_at, last_attempt_at, error_kind, error, skipped
               FROM project_connector_sync WHERE project_id = ?1 AND connector = ?2",
            params![project_id, kind.as_str()],
            |row| {
                Ok(SyncState {
                    last_ok_at: row.get(0)?,
                    last_attempt_at: row.get(1)?,
                    error_kind: error_kind_of(row.get(2)?, 2)?,
                    error: row.get(3)?,
                    skipped: row.get(4)?,
                })
            },
        )
        .optional()?)
}

pub fn record_sync_ok(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
    skipped: u32,
    now: i64,
) -> CommandResult<()> {
    connection.execute(
        "INSERT INTO project_connector_sync
           (project_id, connector, last_ok_at, last_attempt_at, error_kind, error, skipped)
         VALUES (?1, ?2, ?3, ?3, NULL, NULL, ?4)
         ON CONFLICT (project_id, connector) DO UPDATE SET
           last_ok_at = excluded.last_ok_at, last_attempt_at = excluded.last_attempt_at,
           error_kind = NULL, error = NULL, skipped = excluded.skipped",
        params![project_id, kind.as_str(), now, skipped],
    )?;
    Ok(())
}

pub fn record_sync_failure(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
    error_kind: ErrorKind,
    message: &str,
    now: i64,
) -> CommandResult<Vec<DataChanged>> {
    projects::exists(connection, project_id)?;
    connection.execute(
        "INSERT INTO project_connector_sync
           (project_id, connector, last_ok_at, last_attempt_at, error_kind, error)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5)
         ON CONFLICT (project_id, connector) DO UPDATE SET
           last_attempt_at = excluded.last_attempt_at, error_kind = excluded.error_kind,
           error = excluded.error",
        params![project_id, kind.as_str(), now, error_kind.as_str(), message],
    )?;
    Ok(vec![selection_changed(project_id, kind)])
}

/// Nothing is selected any more: the sync state goes too.
pub fn clear_sync_state(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
) -> CommandResult<()> {
    connection.execute(
        "DELETE FROM project_connector_sync WHERE project_id = ?1 AND connector = ?2",
        params![project_id, kind.as_str()],
    )?;
    Ok(())
}
