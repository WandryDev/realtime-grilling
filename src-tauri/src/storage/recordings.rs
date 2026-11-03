//! Rows of the call recordings (audio-capture design.md, decision 13).
//!
//! Only the recorder writes them; windows learn about a recording from the
//! recorder's own events, so nothing here sends `DataChanged`. The files
//! behind a row belong to a [`RecordingStore`]: a row's files are removed by
//! [`sweep`] once the row is gone.

use std::{collections::HashSet, path::Path, time::UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{calls, now_ms};
use crate::{
    error::{CommandError, CommandResult},
    recording::store::RecordingStore,
};

/// Where a recording is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingState {
    /// Being written now (or the app died while writing it, until the next
    /// open marks it [`Self::Interrupted`]).
    Recording,
    /// Stopped by the user or the app; the files end with EOS.
    Finished,
    /// The app stopped without closing the files; they play up to the last
    /// page that reached the disk.
    Interrupted,
}

impl RecordingState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Recording => "recording",
            Self::Finished => "finished",
            Self::Interrupted => "interrupted",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "recording" => Ok(Self::Recording),
            "finished" => Ok(Self::Finished),
            "interrupted" => Ok(Self::Interrupted),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                format!("unknown recording status {other}").into(),
            )),
        }
    }
}

/// Channel files of a recording, relative to the app data folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordingFiles {
    pub me: String,
    pub others: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recording {
    pub id: String,
    pub call_id: Option<String>,
    pub status: RecordingState,
    /// Milliseconds since the Unix epoch, UTC.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub files: RecordingFiles,
    pub created_at: i64,
    pub updated_at: i64,
}

const SELECT: &str = "SELECT id, call_id, status, started_at, ended_at, me_file, others_file,
       created_at, updated_at
  FROM recordings";

fn from_row(row: &Row) -> rusqlite::Result<Recording> {
    let status: String = row.get(2)?;
    Ok(Recording {
        id: row.get(0)?,
        call_id: row.get(1)?,
        status: RecordingState::parse(&status)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
        files: RecordingFiles {
            me: row.get(5)?,
            others: row.get(6)?,
        },
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn not_found(id: &str) -> CommandError {
    CommandError::not_found(format!("Запись {id} не найдена"))
}

/// Adds a row in the `recording` state and returns its new id (UUID v7).
/// `files` names the channel files for that id (see
/// [`RecordingStore::files`]). `NotFound` when `call_id` names no call.
///
/// Insert the row before creating the files: a sweep deletes every folder
/// without a row.
pub fn create(
    connection: &Connection,
    call_id: Option<&str>,
    started_at: i64,
    files: impl FnOnce(&str) -> RecordingFiles,
) -> CommandResult<String> {
    if let Some(call_id) = call_id {
        calls::project_of(connection, call_id)?;
    }
    let id = super::new_id();
    let files = files(&id);
    let now = now_ms();
    connection.execute(
        "INSERT INTO recordings
           (id, call_id, status, started_at, ended_at, me_file, others_file, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?7)",
        params![
            id,
            call_id,
            RecordingState::Recording.as_str(),
            started_at,
            files.me,
            files.others,
            now
        ],
    )?;
    Ok(id)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Recording> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| not_found(id))
}

/// Ids of every recording, oldest first.
pub fn list_ids(connection: &Connection) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare("SELECT id FROM recordings ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Marks a recording that is being written as `finished` at `ended_at`
/// (never before its start). A recording that already ended stays as it is.
/// `NotFound` for an unknown id.
pub fn finish(connection: &Connection, id: &str, ended_at: i64) -> CommandResult<Recording> {
    end(connection, id, RecordingState::Finished, ended_at)
}

/// Marks a recording that is being written as `interrupted` at `ended_at`.
/// A recording that already ended stays as it is. `NotFound` for an unknown id.
pub fn mark_interrupted(
    connection: &Connection,
    id: &str,
    ended_at: i64,
) -> CommandResult<Recording> {
    end(connection, id, RecordingState::Interrupted, ended_at)
}

fn end(
    connection: &Connection,
    id: &str,
    state: RecordingState,
    ended_at: i64,
) -> CommandResult<Recording> {
    connection.execute(
        "UPDATE recordings
            SET status = ?2, ended_at = max(?3, started_at), updated_at = ?4
          WHERE id = ?1 AND status = 'recording'",
        params![id, state.as_str(), ended_at, now_ms()],
    )?;
    get(connection, id)
}

/// Deletes a row (a start that failed after the insert). The files go with
/// the next sweep. `NotFound` for an unknown id.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<()> {
    let deleted = connection.execute("DELETE FROM recordings WHERE id = ?1", [id])?;
    if deleted == 0 {
        return Err(not_found(id));
    }
    Ok(())
}

/// After a crash: every row still `recording` becomes `interrupted`, ending
/// when its files last changed (the newer of the two), or at its start when
/// neither file exists. `data_dir` is what the file paths are relative to.
/// Returns the ids it changed.
///
/// Run on open, before any recorder can start.
pub fn recover_interrupted(connection: &Connection, data_dir: &Path) -> CommandResult<Vec<String>> {
    let stale: Vec<Recording> = {
        let mut statement = connection.prepare(&format!("{SELECT} WHERE status = 'recording'"))?;
        let rows = statement.query_map([], from_row)?;
        rows.collect::<Result<_, _>>()?
    };
    for recording in &stale {
        let modified = [&recording.files.me, &recording.files.others]
            .into_iter()
            .filter_map(|file| modified_ms(&data_dir.join(file)))
            .max();
        mark_interrupted(
            connection,
            &recording.id,
            modified.unwrap_or(recording.started_at),
        )?;
    }
    Ok(stale.into_iter().map(|recording| recording.id).collect())
}

fn modified_ms(path: &Path) -> Option<i64> {
    let modified = path.metadata().and_then(|meta| meta.modified()).ok()?;
    let since_epoch = modified.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(since_epoch.as_millis()).ok()
}

/// Removes the files of every recording without a row (deleted with its
/// call or project, or left by a failed start). Returns the removed ids.
///
/// Runs under the caller's connection: holding the database lock keeps a
/// recording from being created between the read of the ids and the sweep.
pub fn sweep(connection: &Connection, store: &dyn RecordingStore) -> CommandResult<Vec<String>> {
    let known: HashSet<String> = list_ids(connection)?.into_iter().collect();
    store
        .sweep(&known)
        .map_err(|error| CommandError::storage(format!("Не удалось убрать файлы записей: {error}")))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{Duration, SystemTime},
    };

    use rusqlite_migration::{M, Migrations};

    use super::*;
    use crate::{
        recording::store::{LocalStore, RecordingStore},
        storage::{
            DATABASE_FILE, MIGRATIONS,
            calls::{self, CallCreate},
            open, open_in_memory,
            projects::{self, ProjectCreate},
        },
    };

    fn epoch_ms(time: SystemTime) -> i64 {
        i64::try_from(time.duration_since(UNIX_EPOCH).unwrap().as_millis()).unwrap()
    }

    fn files(id: &str) -> RecordingFiles {
        RecordingFiles {
            me: format!("recordings/{id}/me.opus"),
            others: format!("recordings/{id}/others.opus"),
        }
    }

    fn project(connection: &Connection, name: &str) -> String {
        let input = ProjectCreate {
            name: name.into(),
            ..Default::default()
        };
        projects::create(connection, input).unwrap().0.id
    }

    fn call(connection: &Connection, project_id: &str) -> String {
        let input = CallCreate {
            project_id: project_id.into(),
            ..Default::default()
        };
        calls::create(connection, input).unwrap().0.id
    }

    #[test]
    fn creates_finishes_and_lists() {
        let connection = open_in_memory().unwrap();
        let project_id = project(&connection, "Acme");
        let call_id = call(&connection, &project_id);

        let id = create(&connection, Some(&call_id), 1_000, files).unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok_and(|uuid| uuid.get_version_num() == 7));
        let recording = get(&connection, &id).unwrap();
        assert_eq!(recording.status, RecordingState::Recording);
        assert_eq!(recording.call_id.as_deref(), Some(call_id.as_str()));
        assert_eq!(recording.ended_at, None);
        assert_eq!(recording.files, files(&id));

        let finished = finish(&connection, &id, 61_000).unwrap();
        assert_eq!(finished.status, RecordingState::Finished);
        assert_eq!(finished.ended_at, Some(61_000));

        // Stopping again changes nothing.
        let again = finish(&connection, &id, 99_000).unwrap();
        assert_eq!(again.ended_at, Some(61_000));
        let interrupted = mark_interrupted(&connection, &id, 99_000).unwrap();
        assert_eq!(interrupted.status, RecordingState::Finished);

        let loose = create(&connection, None, 2_000, files).unwrap();
        assert_eq!(list_ids(&connection).unwrap(), vec![id, loose]);
    }

    #[test]
    fn rejects_unknown_ids() {
        let connection = open_in_memory().unwrap();
        let missing = "0190d1a0-0000-7000-8000-000000000000";
        let error = create(&connection, Some(missing), 0, files).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }));
        assert!(list_ids(&connection).unwrap().is_empty());
        for error in [
            get(&connection, missing).unwrap_err(),
            finish(&connection, missing, 0).unwrap_err(),
            mark_interrupted(&connection, missing, 0).unwrap_err(),
            delete(&connection, missing).unwrap_err(),
        ] {
            assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
        }
    }

    #[test]
    fn end_time_is_never_before_the_start() {
        let connection = open_in_memory().unwrap();
        let id = create(&connection, None, 5_000, files).unwrap();
        let recording = finish(&connection, &id, 4_000).unwrap();
        assert_eq!(recording.ended_at, Some(5_000));
    }

    #[test]
    fn deleting_a_project_or_call_deletes_its_recordings_only() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let globex = project(&connection, "Globex");
        let acme_call = call(&connection, &acme);
        let globex_call = call(&connection, &globex);
        let other_call = call(&connection, &globex);

        let of_acme = create(&connection, Some(&acme_call), 0, files).unwrap();
        let of_globex = create(&connection, Some(&globex_call), 0, files).unwrap();
        let of_other = create(&connection, Some(&other_call), 0, files).unwrap();
        let loose = create(&connection, None, 0, files).unwrap();

        projects::delete(&connection, &acme).unwrap();
        assert!(get(&connection, &of_acme).is_err());
        assert_eq!(
            list_ids(&connection).unwrap(),
            vec![of_globex.clone(), of_other.clone(), loose.clone()]
        );

        calls::delete(&connection, &globex_call).unwrap();
        assert_eq!(
            list_ids(&connection).unwrap(),
            vec![of_other, loose.clone()]
        );

        projects::delete(&connection, &globex).unwrap();
        assert_eq!(list_ids(&connection).unwrap(), vec![loose.clone()]);
        assert_eq!(get(&connection, &loose).unwrap().call_id, None);
    }

    #[test]
    fn migration_keeps_the_data_of_0001() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let first = [M::up(include_str!("../../migrations/0001_init.sql"))];
        let (project_id, call_id) = {
            let connection = open(&path, &Migrations::from_slice(&first)).unwrap();
            let project_id = project(&connection, "Acme");
            let call_id = call(&connection, &project_id);
            (project_id, call_id)
        };

        let connection = open(&path, &MIGRATIONS).unwrap();
        assert_eq!(
            projects::get(&connection, &project_id).unwrap().name,
            "Acme"
        );
        assert_eq!(
            calls::get(&connection, &call_id).unwrap().project_id,
            project_id
        );
        let id = create(&connection, Some(&call_id), 0, files).unwrap();
        assert_eq!(list_ids(&connection).unwrap(), vec![id]);
    }

    #[test]
    fn rejects_an_unknown_status() {
        let connection = open_in_memory().unwrap();
        let error = connection
            .execute(
                "INSERT INTO recordings VALUES ('x', NULL, 'paused', 0, NULL, 'a', 'b', 0, 0)",
                [],
            )
            .unwrap_err();
        assert!(error.to_string().contains("CHECK"), "{error}");
    }

    #[test]
    fn recovers_a_crashed_recording_from_the_file_time() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open_in_memory().unwrap();
        let store = LocalStore::new(dir.path());
        let started_at = epoch_ms(SystemTime::now()) - 300_000;

        // Crashed after writing: the file times give the end.
        let crashed = create(&connection, None, started_at, |id| store.files(id)).unwrap();
        let writers = store.create(&crashed).unwrap();
        drop(writers);
        let me = dir.path().join(store.files(&crashed).me);
        let others = dir.path().join(store.files(&crashed).others);
        let me_time =
            UNIX_EPOCH + Duration::from_millis(u64::try_from(started_at).unwrap() + 120_000);
        let others_time = me_time + Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&me)
            .unwrap()
            .set_modified(me_time)
            .unwrap();
        fs::File::options()
            .write(true)
            .open(&others)
            .unwrap()
            .set_modified(others_time)
            .unwrap();

        // Crashed before creating its files: ends at its start.
        let empty = create(&connection, None, started_at, |id| store.files(id)).unwrap();
        // Finished properly: left alone.
        let done = create(&connection, None, started_at, |id| store.files(id)).unwrap();
        finish(&connection, &done, started_at + 10).unwrap();

        let changed = recover_interrupted(&connection, dir.path()).unwrap();
        assert_eq!(changed, vec![crashed.clone(), empty.clone()]);

        let crashed = get(&connection, &crashed).unwrap();
        assert_eq!(crashed.status, RecordingState::Interrupted);
        assert_eq!(crashed.ended_at, Some(epoch_ms(others_time)));
        let empty = get(&connection, &empty).unwrap();
        assert_eq!(empty.status, RecordingState::Interrupted);
        assert_eq!(empty.ended_at, Some(started_at));
        assert_eq!(
            get(&connection, &done).unwrap().ended_at,
            Some(started_at + 10)
        );
        assert!(
            recover_interrupted(&connection, dir.path())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn sweep_removes_the_files_of_deleted_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open_in_memory().unwrap();
        let store = LocalStore::new(dir.path());
        let project_id = project(&connection, "Acme");
        let call_id = call(&connection, &project_id);

        let live = create(&connection, None, 0, |id| store.files(id)).unwrap();
        drop(store.create(&live).unwrap());
        store.finish(&live).unwrap();
        let of_call = create(&connection, Some(&call_id), 0, |id| store.files(id)).unwrap();
        drop(store.create(&of_call).unwrap());
        store.finish(&of_call).unwrap();

        calls::delete(&connection, &call_id).unwrap();
        let removed = sweep(&connection, &store).unwrap();

        assert_eq!(removed, vec![of_call.clone()]);
        assert!(!dir.path().join("recordings").join(&of_call).exists());
        assert!(dir.path().join(store.files(&live).me).exists());
        assert!(dir.path().join(store.files(&live).others).exists());
    }
}
