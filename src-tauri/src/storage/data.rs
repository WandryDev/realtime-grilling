//! What the settings show of the data and «Удалить всё» (settings-real
//! design.md, decisions 4 and 8).

use std::{fs, io, path::Path};

use rusqlite::Connection;
use serde::Serialize;
use specta::Type;

use crate::{
    connectors::{ConnectorKind, secrets::SecretStore},
    error::{CommandError, CommandResult},
    events::{Change, DataChanged, Entity, EventSink},
    recording::store::RECORDINGS_DIR,
    storage::{Storage, settings},
};

/// The recordings' folder in «Общие».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingsInfo {
    /// The folder of the recordings' files, for «Показать в Finder».
    pub path: String,
    /// What its files take, in bytes.
    pub bytes: u64,
    /// Calls that still have audio (not deleted by hand or by the
    /// retention period).
    pub calls: u32,
}

/// The summary next to «Удалить всё».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    pub projects: u32,
    pub calls: u32,
    /// What the recordings' files take, in bytes.
    pub bytes: u64,
}

/// The size of every file under `dir`; a missing folder is empty. Unreadable
/// entries are skipped. Blocks: call it off the async workers.
pub fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_bytes(&entry.path()),
            Ok(kind) if kind.is_file() => entry.metadata().map_or(0, |meta| meta.len()),
            _ => 0,
        })
        .sum()
}

/// Calls with at least one recording whose audio is still there.
pub fn calls_with_audio(connection: &Connection) -> CommandResult<u32> {
    Ok(connection.query_row(
        "SELECT count(DISTINCT call_id) FROM recordings
          WHERE call_id IS NOT NULL AND audio_deleted_at IS NULL",
        [],
        |row| row.get(0),
    )?)
}

/// The numbers of projects and calls.
pub fn counts(connection: &Connection) -> CommandResult<(u32, u32)> {
    Ok(connection.query_row(
        "SELECT (SELECT count(*) FROM projects), (SELECT count(*) FROM calls)",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

/// Every table of the database but the migrations' own.
fn tables(connection: &Connection) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// «Удалить всё» in the database: every row of every table, the settings
/// too (they read as the defaults then, onboarding not done and no
/// `agentPath`). Run it in one transaction. Returns what the windows
/// re-read: each project deleted, each call without a project, each
/// connection and the settings.
pub fn delete_all(connection: &Connection) -> CommandResult<Vec<DataChanged>> {
    let ids = |sql: &str| -> CommandResult<Vec<(String, Option<String>)>> {
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<Result<_, _>>()?)
    };
    let projects = ids("SELECT id, id FROM projects ORDER BY id")?;
    let calls = ids("SELECT id, project_id FROM calls WHERE project_id IS NULL ORDER BY id")?;
    let connections = ids("SELECT kind, NULL FROM connections ORDER BY kind")?;
    // Constraints are checked at the commit, when every table is empty.
    connection.pragma_update(None, "defer_foreign_keys", "ON")?;
    for table in tables(connection)? {
        connection.execute(&format!("DELETE FROM \"{table}\""), [])?;
    }
    let mut events: Vec<DataChanged> = projects
        .iter()
        .map(|(id, _)| DataChanged::new(Entity::Project, id, Some(id), Change::Deleted))
        .collect();
    events.extend(
        calls
            .iter()
            .map(|(id, _)| DataChanged::new(Entity::Call, id, None, Change::Deleted)),
    );
    events.extend(
        connections
            .iter()
            .map(|(kind, _)| DataChanged::new(Entity::Connections, kind, None, Change::Deleted)),
    );
    events.push(DataChanged::new(
        Entity::Settings,
        settings::SETTINGS_ID,
        None,
        Change::Updated,
    ));
    Ok(events)
}

/// Removes every file and folder inside `dir` (the recordings' folder),
/// keeping the folder. A missing folder is fine.
pub fn empty_dir(dir: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut failed = None;
    for entry in entries {
        let entry = entry?;
        let removed = if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        };
        if let Err(error) = removed {
            failed.get_or_insert(error);
        }
    }
    failed.map_or(Ok(()), Err)
}

/// The recordings' folder of the app data folder `data_dir`.
pub fn recordings_dir(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join(RECORDINGS_DIR)
}

/// «Папка записей»: the folder, what it takes, the calls with audio.
pub async fn recordings_info(storage: &Storage) -> CommandResult<RecordingsInfo> {
    let dir = storage
        .data_dir()
        .map(recordings_dir)
        .ok_or_else(|| CommandError::storage("Нет папки данных приложения"))?;
    let calls = storage.read(calls_with_audio).await?;
    let path = dir.to_string_lossy().into_owned();
    let bytes = tauri::async_runtime::spawn_blocking(move || dir_bytes(&dir))
        .await
        .map_err(|error| CommandError::storage(error.to_string()))?;
    Ok(RecordingsInfo { path, bytes, calls })
}

/// The summary next to «Удалить всё».
pub async fn summary(storage: &Storage) -> CommandResult<DataSummary> {
    let (projects, calls) = storage.read(counts).await?;
    let dir = storage.data_dir().map(recordings_dir);
    let bytes = tauri::async_runtime::spawn_blocking(move || dir.map_or(0, |dir| dir_bytes(&dir)))
        .await
        .map_err(|error| CommandError::storage(error.to_string()))?;
    Ok(DataSummary {
        projects,
        calls,
        bytes,
    })
}

/// «Удалить всё» (decision 8): every row in one transaction (its events go
/// out after the commit), then the recordings' files, the copies of the
/// projects' documents and the connectors' secrets. The settings read as
/// the defaults afterwards. A file or a secret that can't be removed is
/// `External` once the rest is done (the data rows are gone by then).
pub async fn delete_everything(
    storage: &Storage,
    sink: &impl EventSink,
    secrets: &dyn SecretStore,
) -> CommandResult<()> {
    storage.write(sink, |db| Ok(((), delete_all(db)?))).await?;
    let mut failure: Option<String> = None;
    if let Some(dir) = storage.data_dir().map(Path::to_owned) {
        let recordings = recordings_dir(&dir);
        let emptied = tauri::async_runtime::spawn_blocking(move || empty_dir(&recordings))
            .await
            .map_err(|error| io::Error::other(error.to_string()))
            .and_then(|done| done);
        if let Err(error) = emptied {
            failure.get_or_insert(format!("Не удалось удалить файлы записей: {error}"));
        }
        let swept = storage
            .read(move |db| crate::projects::sources::files::sweep(db, &dir))
            .await;
        if let Err(error) = swept {
            failure.get_or_insert(format!("Не удалось удалить документы проектов: {error}"));
        }
    }
    for kind in ConnectorKind::ALL {
        if let Err(error) = secrets.delete(kind) {
            failure.get_or_insert(format!(
                "Не удалось удалить ключ {} из системного хранилища: {error}",
                kind.label()
            ));
        }
    }
    failure.map_or(Ok(()), |message| Err(CommandError::external(message)))
}

#[cfg(test)]
mod tests;
