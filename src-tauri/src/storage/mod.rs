//! Local SQLite database (design.md, decisions 8–10).
//!
//! One connection behind a `Mutex`; commands run their queries in
//! `spawn_blocking` so the main thread never waits for the disk. If the
//! database can't be opened or migrated the app still starts: the storage is
//! an `Err` and every data command answers `Storage`.

pub mod call_records;
pub mod call_search;
pub mod call_state;
pub mod calls;
pub mod json;
pub mod people;
pub mod projects;
pub mod proposals;
#[allow(
    dead_code,
    reason = "create / finish / delete are for the RecordingManager (audio-capture task 4.5)"
)]
pub mod recordings;
pub mod settings;
pub mod sources;
pub mod summaries;
#[allow(
    dead_code,
    reason = "append_live / replace_refined are for the TranscriptSink and the Refiner \
              (speech-recognition tasks 5.1–5.2)"
)]
pub mod transcript;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, Transaction};
use rusqlite_migration::{M, Migrations, SchemaVersion};

use crate::{
    error::{CommandError, CommandResult},
    events::{DataChanged, EventSink},
    recording::store::LocalStore,
};

pub const DATABASE_FILE: &str = "grill.db";

/// How many `grill.db.bak-v<N>` copies to keep.
const BACKUPS_TO_KEEP: usize = 2;

const MIGRATION_LIST: &[M<'static>] = &[
    M::up(include_str!("../../migrations/0001_init.sql")),
    M::up(include_str!("../../migrations/0002_recordings.sql")),
    M::up(include_str!(
        "../../migrations/0003_transcript_by_recording.sql"
    )),
    M::up(include_str!(
        "../../migrations/0004_call_state_by_recording.sql"
    )),
    M::up(include_str!(
        "../../migrations/0005_project_sources_and_brief.sql"
    )),
    // Rebuilds `calls`: runs with the foreign keys off (see `migrate`).
    M::up(include_str!(
        "../../migrations/0006_call_without_project.sql"
    ))
    .foreign_key_check(),
    M::up(include_str!(
        "../../migrations/0007_call_summaries_and_proposals.sql"
    )),
];

pub const MIGRATIONS: Migrations<'static> = Migrations::from_slice(MIGRATION_LIST);

/// Schema version this build knows.
pub const SCHEMA_VERSION: usize = MIGRATION_LIST.len();

type Db = Arc<Mutex<Connection>>;

/// The database or the reason it is unavailable. Managed as Tauri state.
///
/// A failed open can be retried (`storage_reopen`, "Повторить" on the
/// storage error screen): the state then switches to the database.
pub struct Storage {
    db: RwLock<Result<Db, String>>,
    /// Where `grill.db` lives; `None` when the app has no data folder.
    dir: Option<PathBuf>,
    /// The recordings' files next to the database; `None` without a data folder.
    recordings: Option<Arc<LocalStore>>,
}

impl Storage {
    /// Opens `<dir>/grill.db`, migrating it to [`SCHEMA_VERSION`].
    ///
    /// Then tidies the recordings: rows a crash left `recording` become
    /// `interrupted`, folders without a row are removed. Calls a crash or a
    /// quit left `live` or `finishing` become `finished`. Copies of project
    /// documents without a row and folders of deleted projects go too.
    pub fn open_in(dir: &Path) -> Self {
        let recordings = Arc::new(LocalStore::new(dir));
        Self {
            db: RwLock::new(open_dir(dir, &recordings)),
            dir: Some(dir.to_owned()),
            recordings: Some(recordings),
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            db: RwLock::new(Err(message.into())),
            dir: None,
            recordings: None,
        }
    }

    #[cfg(test)]
    fn from_result(result: Result<Connection, String>) -> Self {
        Self {
            db: RwLock::new(result.map(|connection| Arc::new(Mutex::new(connection)))),
            dir: None,
            recordings: None,
        }
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::from_result(open_in_memory())
    }

    /// Why the database is unavailable, if it is.
    pub fn error(&self) -> Option<String> {
        self.state().as_ref().err().cloned()
    }

    fn state(&self) -> std::sync::RwLockReadGuard<'_, Result<Db, String>> {
        self.db
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn db(&self) -> CommandResult<Db> {
        self.state().clone().map_err(CommandError::storage)
    }

    /// Opens and migrates the database again if it failed before; a
    /// working database is kept as it is. `Storage` when it still fails.
    pub async fn reopen(&self) -> CommandResult<()> {
        if self.db().is_ok() {
            return Ok(());
        }
        let (Some(dir), Some(recordings)) = (self.dir.clone(), self.recordings.clone()) else {
            return self.db().map(|_| ());
        };
        let opened = tauri::async_runtime::spawn_blocking(move || open_dir(&dir, &recordings))
            .await
            .map_err(|error| CommandError::storage(error.to_string()))?;
        let mut state = self
            .db
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Another retry may have opened it meanwhile: keep that connection.
        if state.is_err() {
            *state = opened;
        }
        state.clone().map(|_| ()).map_err(CommandError::storage)
    }

    /// Runs a read off the main thread.
    pub async fn read<T, F>(&self, read: F) -> CommandResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> CommandResult<T> + Send + 'static,
    {
        let db = self.db()?;
        tauri::async_runtime::spawn_blocking(move || read(&lock(&db)))
            .await
            .map_err(|error| CommandError::storage(error.to_string()))?
    }

    /// Runs a write in one transaction off the main thread. The events go out
    /// only after the commit succeeded.
    pub async fn write<T, F>(&self, sink: &impl EventSink, write: F) -> CommandResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Transaction) -> CommandResult<(T, Vec<DataChanged>)> + Send + 'static,
    {
        let db = self.db()?;
        let (value, events) = tauri::async_runtime::spawn_blocking(move || {
            let mut connection = lock(&db);
            let transaction = connection.transaction()?;
            let output = write(&transaction)?;
            transaction.commit()?;
            Ok::<_, CommandError>(output)
        })
        .await
        .map_err(|error| CommandError::storage(error.to_string()))??;
        for event in events {
            sink.data_changed(event);
        }
        Ok(value)
    }

    /// The app data folder (`grill.db`, recordings, projects' documents);
    /// `None` without one.
    pub fn data_dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// The store of the recordings' files, shared with the recorder so a
    /// sweep never removes a recording being written. `None` without a data
    /// folder.
    pub fn recording_store(&self) -> Option<Arc<LocalStore>> {
        self.recordings.clone()
    }

    /// Removes the files of recordings that no longer have a row: call it
    /// after deleting a call or a project. A failure is only logged: the
    /// next start sweeps again.
    pub async fn sweep_recordings(&self) {
        let (Ok(db), Some(store)) = (self.db(), self.recordings.clone()) else {
            return;
        };
        let swept = tauri::async_runtime::spawn_blocking(move || {
            recordings::sweep(&lock(&db), store.as_ref())
        })
        .await;
        match swept {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => eprintln!("grill: recordings sweep failed: {error}"),
            Err(error) => eprintln!("grill: recordings sweep failed: {error}"),
        }
    }

    /// Synchronous read for app setup, before the event loop runs.
    pub fn read_now<T>(
        &self,
        read: impl FnOnce(&Connection) -> CommandResult<T>,
    ) -> CommandResult<T> {
        let db = self.db()?;
        read(&lock(&db))
    }
}

/// Opens `<dir>/grill.db`, creating the folder first, and tidies the
/// recordings.
fn open_dir(dir: &Path, recordings: &LocalStore) -> Result<Db, String> {
    let connection = fs::create_dir_all(dir)
        .map_err(|error| format!("Не удалось создать папку данных {}: {error}", dir.display()))
        .and_then(|()| open(&dir.join(DATABASE_FILE), &MIGRATIONS))?;
    tidy_recordings(&connection, dir, recordings);
    // After the recordings: a call ends when its last recording did.
    if let Err(error) = calls::finish_stale(&connection, now_ms()) {
        eprintln!("grill: could not finish the calls left running: {error}");
    }
    // No build runs yet: a `building` summary was left by a crash or a quit.
    if let Err(error) = summaries::interrupt_building(&connection, now_ms()) {
        eprintln!("grill: could not mark the interrupted summary builds: {error}");
    }
    if let Err(error) = crate::projects::sources::files::sweep(&connection, dir) {
        eprintln!("grill: documents sweep failed: {error}");
    }
    Ok(Arc::new(Mutex::new(connection)))
}

/// After a crash and at every start (`specs/local-storage`, "Модель
/// данных"; audio-capture tasks 3.2–3.3). Failures are logged: the database
/// works without it.
fn tidy_recordings(connection: &Connection, dir: &Path, store: &LocalStore) {
    if let Err(error) = recordings::recover_interrupted(connection, dir) {
        eprintln!("grill: could not mark interrupted recordings: {error}");
    }
    if let Err(error) = recordings::sweep(connection, store) {
        eprintln!("grill: recordings sweep failed: {error}");
    }
}

/// A panic while holding the lock leaves the connection usable: every write
/// is a transaction that rolled back on drop.
fn lock(db: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Milliseconds since the Unix epoch, UTC.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

/// A new time-ordered id.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Opens the database file, backs it up and migrates it.
///
/// Never writes to a database that is newer than `migrations`.
pub fn open(path: &Path, migrations: &Migrations) -> Result<Connection, String> {
    let latest = migration_count(migrations)?;
    let mut connection = Connection::open(path)
        .map_err(|error| format!("Не удалось открыть базу {}: {error}", path.display()))?;
    let version = schema_version(&connection, migrations)?;
    if version > latest {
        return Err(format!(
            "База данных создана более новой версией Grill (схема v{version}, \
             эта версия знает v{latest}). Обновите приложение."
        ));
    }
    configure(&connection)?;
    if version > 0 && version < latest {
        backup(&connection, path, version)?;
    }
    migrate(&mut connection, migrations)?;
    Ok(connection)
}

/// Opens the app's database file only to read it (`grill-eval export`):
/// SQLite refuses every write, nothing is migrated or backed up. A schema
/// other than this build's is an error: its queries may not fit it.
pub fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Не удалось открыть базу {}: {error}", path.display()))?;
    let version = schema_version(&connection, &MIGRATIONS)?;
    if version != SCHEMA_VERSION {
        return Err(format!(
            "База {} на схеме v{version}, а эта сборка знает v{SCHEMA_VERSION}. \
             Откройте приложение этой же версии, чтобы обновить базу, или соберите \
             grill-eval из той версии, что её создала.",
            path.display()
        ));
    }
    connection
        .busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|error| format!("Не удалось настроить базу: {error}"))?;
    Ok(connection)
}

/// A migrated database in memory: the tests, and the database of a
/// `grill-eval` replay.
pub fn open_in_memory() -> Result<Connection, String> {
    let mut connection = Connection::open_in_memory().map_err(|error| error.to_string())?;
    configure(&connection)?;
    migrate(&mut connection, &MIGRATIONS)?;
    Ok(connection)
}

fn migration_count(migrations: &Migrations) -> Result<usize, String> {
    // `pending_migrations` on an empty in-memory database = number of migrations.
    let empty = Connection::open_in_memory().map_err(|error| error.to_string())?;
    migrations
        .pending_migrations(&empty)
        .map_err(|error| error.to_string())
        .and_then(|count| usize::try_from(count).map_err(|error| error.to_string()))
}

fn schema_version(connection: &Connection, migrations: &Migrations) -> Result<usize, String> {
    let version = migrations
        .current_version(connection)
        .map_err(|error| format!("Не удалось прочитать версию схемы: {error}"))?;
    Ok(match version {
        SchemaVersion::NoneSet => 0,
        SchemaVersion::Inside(v) | SchemaVersion::Outside(v) => v.get(),
    })
}

fn configure(connection: &Connection) -> Result<(), String> {
    connection
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        .and_then(|_| connection.pragma_update(None, "foreign_keys", "ON"))
        .and_then(|()| connection.pragma_update(None, "busy_timeout", 5000))
        .map_err(|error| format!("Не удалось настроить базу: {error}"))
}

fn migrate(connection: &mut Connection, migrations: &Migrations) -> Result<(), String> {
    let dropped = call_transcript_rows(connection);
    let dropped_state = call_state_rows(connection);
    // All pending migrations run in one transaction: on failure the database
    // stays on its previous version. The foreign keys are off meanwhile, as
    // rusqlite_migration asks (a pragma inside the transaction does
    // nothing): rebuilding a parent table (0006) must not cascade into its
    // children. A migration that rebuilds one checks them before commit.
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .map_err(|error| format!("Не удалось настроить базу: {error}"))?;
    let migrated = migrations.to_latest(connection);
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Не удалось настроить базу: {error}"))?;
    migrated.map_err(|error| format!("Не удалось обновить схему базы: {error}"))?;
    if let Some(count) = dropped.filter(|_| !has_call_transcript(connection)) {
        eprintln!(
            "grill: migration 0003 dropped {count} transcript segment(s) without a recording"
        );
    }
    if let Some(count) = dropped_state.filter(|_| !has_call_state(connection)) {
        eprintln!(
            "grill: migration 0004 dropped {count} topic, task card and question row(s) \
             without a recording"
        );
    }
    Ok(())
}

/// Rows of the topics, task cards and questions of 0001 (keyed by call, no
/// recording), which 0004 drops; `None` when the tables are not those.
fn call_state_rows(connection: &Connection) -> Option<i64> {
    if !has_call_state(connection) {
        return None;
    }
    connection
        .query_row(
            "SELECT (SELECT count(*) FROM topics) + (SELECT count(*) FROM task_cards)
                  + (SELECT count(*) FROM questions)",
            [],
            |row| row.get(0),
        )
        .ok()
}

/// Whether `topics` exists without a `recording_id` column (0001's tables).
fn has_call_state(connection: &Connection) -> bool {
    has_columns_without(connection, "topics", "call_id", "recording_id")
}

/// Rows of the transcript of 0001 (keyed by call, no recording), which 0003
/// drops; `None` when the table is not that one.
fn call_transcript_rows(connection: &Connection) -> Option<i64> {
    if !has_call_transcript(connection) {
        return None;
    }
    connection
        .query_row("SELECT count(*) FROM transcript_segments", [], |row| {
            row.get(0)
        })
        .ok()
}

/// Whether `transcript_segments` exists without a `recording_id` column.
fn has_call_transcript(connection: &Connection) -> bool {
    has_columns_without(connection, "transcript_segments", "call_id", "recording_id")
}

/// Whether `table` has the column `with` and not the column `without`.
fn has_columns_without(connection: &Connection, table: &str, with: &str, without: &str) -> bool {
    let columns = |name: &str| -> i64 {
        connection
            .query_row(
                "SELECT count(*) FROM pragma_table_info(?1) WHERE name = ?2",
                [table, name],
                |row| row.get(0),
            )
            .unwrap_or(0)
    };
    columns(with) == 1 && columns(without) == 0
}

/// `grill.db.bak-v<version>` next to the database.
pub fn backup_path(path: &Path, version: usize) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".bak-v{version}"));
    path.with_file_name(name)
}

/// Copies the database before migrating it and keeps the newest copies.
fn backup(connection: &Connection, path: &Path, version: usize) -> Result<(), String> {
    let target = backup_path(path, version);
    // `VACUUM INTO` refuses to overwrite; a copy of the same version left by a
    // failed migration holds the same data.
    if target.exists() {
        fs::remove_file(&target).map_err(|error| error.to_string())?;
    }
    connection
        .execute("VACUUM INTO ?1", [target.to_string_lossy()])
        .map_err(|error| format!("Не удалось сделать копию базы перед обновлением: {error}"))?;
    prune_backups(path);
    Ok(())
}

fn prune_backups(path: &Path) {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return;
    };
    let prefix = format!("{}.bak-v", name.to_string_lossy());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<(usize, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let version = file_name.to_str()?.strip_prefix(&prefix)?.parse().ok()?;
            Some((version, entry.path()))
        })
        .collect();
    backups.sort_by_key(|(version, _)| std::cmp::Reverse(*version));
    for (_, stale) in backups.into_iter().skip(BACKUPS_TO_KEEP) {
        let _ = fs::remove_file(stale);
    }
}

/// Validates that a required text is not blank and returns it trimmed.
pub fn required(value: &str, message: &str) -> CommandResult<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid(message));
    }
    Ok(trimmed.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pragma<T: rusqlite::types::FromSql>(connection: &Connection, name: &str) -> T {
        connection
            .pragma_query_value(None, name, |row| row.get(0))
            .unwrap()
    }

    fn version(connection: &Connection) -> i64 {
        pragma(connection, "user_version")
    }

    #[test]
    fn opens_the_database_with_pragmas() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(dir.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        assert!(dir.path().join(DATABASE_FILE).exists());
        storage
            .read_now(|connection| {
                assert_eq!(pragma::<String>(connection, "journal_mode"), "wal");
                assert_eq!(pragma::<i64>(connection, "foreign_keys"), 1);
                assert_eq!(pragma::<i64>(connection, "busy_timeout"), 5000);
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn opening_tidies_the_recordings() {
        use crate::recording::store::RecordingStore;

        let dir = tempfile::tempdir().unwrap();
        let (crashed, orphan) = {
            let storage = Storage::open_in(dir.path());
            let store = storage.recording_store().unwrap();
            storage
                .read_now(|connection| {
                    let crashed = recordings::create(
                        connection,
                        &recordings::RecordingLinks::default(),
                        1_000,
                        |id| store.files(id),
                    )?;
                    drop(store.create(&crashed).unwrap());
                    let orphan = "0190d1a0-0000-7000-8000-00000000000f";
                    drop(store.create(orphan).unwrap());
                    Ok((crashed, orphan.to_owned()))
                })
                .unwrap()
        };
        // The app died: the crashed recording is still `recording`, the
        // orphan has no row.
        let storage = Storage::open_in(dir.path());
        let recording = storage
            .read_now(|connection| recordings::get(connection, &crashed))
            .unwrap();
        assert_eq!(recording.status, recordings::RecordingState::Interrupted);
        assert!(recording.ended_at.unwrap() > 1_000);
        let root = dir.path().join(crate::recording::store::RECORDINGS_DIR);
        assert!(root.join(&crashed).exists());
        assert!(!root.join(orphan).exists());
    }

    /// `call-lifecycle`, "Приложение упало во время звонка".
    #[test]
    fn opening_finishes_the_call_a_crash_left_live() {
        let dir = tempfile::tempdir().unwrap();
        let (call_id, recording_id) = {
            let storage = Storage::open_in(dir.path());
            storage
                .read_now(|connection| {
                    let (call, _) = calls::create(connection, calls::CallCreate::default())?;
                    let links = recordings::RecordingLinks::call(&call.id);
                    let recording = recordings::create(connection, &links, now_ms(), |id| {
                        recordings::RecordingFiles {
                            me: format!("recordings/{id}/me.opus"),
                            others: format!("recordings/{id}/others.opus"),
                        }
                    })?;
                    Ok((call.id, recording))
                })
                .unwrap()
        };
        // The app died mid-call: the call is `live`, its recording `recording`.
        let storage = Storage::open_in(dir.path());
        let (call, recording) = storage
            .read_now(|connection| {
                Ok((
                    calls::get(connection, &call_id)?,
                    recordings::get(connection, &recording_id)?,
                ))
            })
            .unwrap();
        assert_eq!(recording.status, recordings::RecordingState::Interrupted);
        assert_eq!(call.status, calls::CallStatus::Finished);
        assert_eq!(call.ended_at, recording.ended_at);
    }

    /// `call-summary`, "Сбой во время сборки": the call is finished, its
    /// summary reads as interrupted.
    #[test]
    fn opening_interrupts_the_summary_build_a_crash_left() {
        let dir = tempfile::tempdir().unwrap();
        let call_id = {
            let storage = Storage::open_in(dir.path());
            storage
                .read_now(|connection| {
                    let input = calls::CallCreate {
                        status: Some(calls::CallStatus::Finishing),
                        ..calls::CallCreate::default()
                    };
                    let (call, _) = calls::create(connection, input)?;
                    summaries::start_building(connection, &call.id)?;
                    Ok(call.id)
                })
                .unwrap()
        };
        let storage = Storage::open_in(dir.path());
        let (call, summary) = storage
            .read_now(|connection| {
                Ok((
                    calls::get(connection, &call_id)?,
                    summaries::get(connection, &call_id)?,
                ))
            })
            .unwrap();
        assert_eq!(call.status, calls::CallStatus::Finished);
        let summary = summary.unwrap();
        assert_eq!(summary.state, summaries::SummaryState::Failed);
        assert_eq!(summary.error.as_deref(), Some(summaries::INTERRUPTED));
    }

    /// `local-storage`, "Аудио удалено": after a restart the files are gone
    /// (whatever the deletion left is swept), the recording, its transcript,
    /// questions and the call's summary read as before.
    #[test]
    fn deleted_audio_stays_deleted_after_a_restart() {
        use crate::{
            recording::store::RecordingStore,
            storage::call_state::{
                self, CardLens, Evidence, EvidenceSource, GapType, NewQuestion, ValidatedOp,
                ValidatedPatch,
            },
        };

        let dir = tempfile::tempdir().unwrap();
        let read = |storage: &Storage, call_id: &str, recording_id: &str| {
            storage
                .read_now(|connection| {
                    Ok((
                        recordings::get(connection, recording_id)?,
                        transcript::for_recording(connection, recording_id)?,
                        call_state::get(connection, recording_id)?.questions,
                        summaries::get(connection, call_id)?,
                    ))
                })
                .unwrap()
        };
        let (call_id, recording_id, before) = {
            let storage = Storage::open_in(dir.path());
            let store = storage.recording_store().unwrap();
            let (call_id, recording_id) = storage
                .read_now(|connection| {
                    let input = calls::CallCreate {
                        status: Some(calls::CallStatus::Finished),
                        ..calls::CallCreate::default()
                    };
                    let (call, _) = calls::create(connection, input)?;
                    let links = recordings::RecordingLinks::call(&call.id);
                    let id = recordings::create(connection, &links, 1_000, |id| store.files(id))?;
                    drop(store.create(&id).unwrap());
                    store.finish(&id).unwrap();
                    recordings::finish(connection, &id, 60_000)?;
                    let segment = transcript::SegmentInput {
                        channel: transcript::TranscriptChannel::Others,
                        start_ms: 0,
                        end_ms: 900,
                        text: "Двести звонков в день".to_owned(),
                    };
                    transcript::append_live(connection, &id, segment)?;
                    let evidence = vec![Evidence {
                        source: EvidenceSource::Segment,
                        id: "S1".to_owned(),
                        quote: "двести".to_owned(),
                    }];
                    let ops = vec![
                        ValidatedOp::CreateTopic {
                            title: "Очередь".to_owned(),
                        },
                        ValidatedOp::SetCardField {
                            field: CardLens::Goal,
                            value: "Разгрузить".to_owned(),
                            evidence: evidence.clone(),
                        },
                        ValidatedOp::AddQuestion(NewQuestion {
                            text: "Кто отвечает ночью?".to_owned(),
                            description: String::new(),
                            card_field: CardLens::Goal,
                            gap_type: GapType::Empty,
                            priority: 2,
                            evidence,
                        }),
                    ];
                    call_state::apply_patch(connection, &id, &ValidatedPatch { ops })?;
                    let ready = summaries::ReadySummary {
                        title: "Пилот".to_owned(),
                        tldr: "Договорились о пилоте.".to_owned(),
                        transcript_pass: summaries::SummaryTranscriptPass::Live,
                        content: summaries::SummaryContent::default(),
                    };
                    summaries::save_ready(connection, &call.id, &ready)?;
                    Ok((call.id, id))
                })
                .unwrap();
            let before = read(&storage, &call_id, &recording_id);
            // The deletion marked the row; say its files could not all be
            // removed.
            let deleted = storage
                .read_now(|connection| {
                    recordings::mark_audio_deleted(connection, &recording_id, 70_000)
                })
                .unwrap();
            assert_eq!(deleted.audio_deleted_at, Some(70_000));
            (call_id, recording_id, before)
        };

        let storage = Storage::open_in(dir.path());
        let root = dir.path().join(crate::recording::store::RECORDINGS_DIR);
        assert!(!root.join(&recording_id).exists(), "the files are swept");
        let (recording, segments, questions, summary) = read(&storage, &call_id, &recording_id);
        assert_eq!(recording.audio_deleted_at, Some(70_000));
        assert_eq!(recording.status, before.0.status);
        assert_eq!(recording.files, before.0.files);
        assert_eq!(segments, before.1);
        assert_eq!(questions, before.2);
        assert_eq!(summary, before.3);
    }

    #[test]
    fn migrates_an_empty_database() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open(&dir.path().join(DATABASE_FILE), &MIGRATIONS).unwrap();
        assert_eq!(version(&connection), SCHEMA_VERSION as i64);
        assert!(foreign_key_violations(&connection).is_empty());
        // A fresh database has nothing to back up.
        assert!(!backup_path(&dir.path().join(DATABASE_FILE), 0).exists());
    }

    #[test]
    fn migrates_a_database_on_version_zero() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch("CREATE TABLE unrelated (x INTEGER);")
                .unwrap();
            assert_eq!(version(&connection), 0);
        }
        let connection = open(&path, &MIGRATIONS).unwrap();
        assert_eq!(version(&connection), SCHEMA_VERSION as i64);
        assert!(foreign_key_violations(&connection).is_empty());
        let tables: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name IN \
                 ('projects', 'people', 'calls', 'call_participants', 'topics', 'task_cards', \
                  'questions', 'transcript_segments', 'settings')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 9);
    }

    #[test]
    fn migrations_are_valid() {
        MIGRATIONS.validate().unwrap();
    }

    #[test]
    fn refuses_a_newer_database_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch("CREATE TABLE future (x INTEGER); PRAGMA user_version = 99;")
                .unwrap();
        }
        let before = fs::read(&path).unwrap();

        let storage = Storage::from_result(open(&path, &MIGRATIONS));

        let message = storage.error().expect("a newer database must fail");
        assert!(message.contains("v99"), "{message}");
        assert_eq!(fs::read(&path).unwrap(), before, "the file must not change");
        assert!(!backup_path(&path, 99).exists());
        let error = storage.read_now(|_| Ok(())).unwrap_err();
        assert!(matches!(error, CommandError::Storage { .. }));
    }

    #[test]
    fn reopen_retries_a_failed_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        {
            let connection = Connection::open(&path).unwrap();
            connection
                .execute_batch("PRAGMA user_version = 99;")
                .unwrap();
        }
        let storage = Storage::open_in(dir.path());
        assert!(storage.error().is_some());

        // Still newer than the app: the retry fails the same way.
        let error = tauri::async_runtime::block_on(storage.reopen()).unwrap_err();
        assert!(matches!(error, CommandError::Storage { .. }));

        // The user restored a backup (here: an empty file); the retry works.
        fs::remove_file(&path).unwrap();
        tauri::async_runtime::block_on(storage.reopen()).unwrap();
        assert!(storage.error().is_none());
        let version = storage
            .read_now(|connection| Ok(version(connection)))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION as i64);
        // A working database stays as it is.
        tauri::async_runtime::block_on(storage.reopen()).unwrap();
    }

    #[test]
    fn failed_migration_keeps_the_version_and_leaves_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let first = [M::up("CREATE TABLE notes (text TEXT NOT NULL);")];
        {
            let connection = open(&path, &Migrations::from_slice(&first)).unwrap();
            connection
                .execute("INSERT INTO notes VALUES ('keep')", [])
                .unwrap();
        }

        let broken = [
            M::up("CREATE TABLE notes (text TEXT NOT NULL);"),
            M::up("ALTER TABLE notes ADD COLUMN x INTEGER; SELECT * FROM missing_table;"),
        ];
        let error = open(&path, &Migrations::from_slice(&broken)).unwrap_err();
        assert!(error.contains("схему"), "{error}");

        let connection = Connection::open(&path).unwrap();
        assert_eq!(version(&connection), 1);
        let columns: i64 = connection
            .query_row(
                "SELECT count(*) FROM pragma_table_info('notes')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(columns, 1, "the failed migration is rolled back");

        let backup = Connection::open(backup_path(&path, 1)).unwrap();
        let kept: String = backup
            .query_row("SELECT text FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(kept, "keep");
        assert_eq!(version(&backup), 1);
    }

    #[test]
    fn keeps_the_two_newest_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        for version in 1..=3 {
            fs::write(backup_path(&path, version), b"old").unwrap();
        }
        fs::write(dir.path().join("other.bak-v9"), b"other").unwrap();
        prune_backups(&path);
        assert!(!backup_path(&path, 1).exists());
        assert!(backup_path(&path, 2).exists());
        assert!(backup_path(&path, 3).exists());
        assert!(dir.path().join("other.bak-v9").exists());
    }

    #[test]
    fn upgrade_backs_up_and_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let first = [M::up("CREATE TABLE notes (text TEXT NOT NULL);")];
        {
            let connection = open(&path, &Migrations::from_slice(&first)).unwrap();
            connection
                .execute("INSERT INTO notes VALUES ('keep')", [])
                .unwrap();
        }
        let second = [
            M::up("CREATE TABLE notes (text TEXT NOT NULL);"),
            M::up("ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;"),
        ];
        let connection = open(&path, &Migrations::from_slice(&second)).unwrap();
        assert_eq!(version(&connection), 2);
        let kept: String = connection
            .query_row("SELECT text FROM notes WHERE pinned = 0", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(kept, "keep");
        assert!(backup_path(&path, 1).exists());
    }

    fn foreign_key_violations(connection: &Connection) -> Vec<String> {
        let mut statement = connection.prepare("PRAGMA foreign_key_check").unwrap();
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }
}
