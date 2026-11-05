//! Rows of the call recordings (audio-capture design.md, decision 13).
//!
//! Only the recorder writes them; windows learn about a recording from the
//! recorder's own events, so nothing here sends `DataChanged`. The files
//! behind a row belong to a [`RecordingStore`]: a row's files are removed by
//! [`sweep`] once the row is gone.

use std::{collections::HashSet, path::Path, time::UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{calls, now_ms, people, projects};
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

/// Where the second pass over a recording is (speech-recognition design.md,
/// decision 12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum TranscriptState {
    /// Only the live pass, the second has not started.
    Live,
    /// The second pass runs (or ran when the app stopped).
    Refining,
    /// The refined segments are stored.
    Refined,
    Failed,
    /// Recorded before speech recognition (migration 0003): never refined.
    Skipped,
}

impl TranscriptState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Refining => "refining",
            Self::Refined => "refined",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "live" => Ok(Self::Live),
            "refining" => Ok(Self::Refining),
            "refined" => Ok(Self::Refined),
            "failed" => Ok(Self::Failed),
            "skipped" => Ok(Self::Skipped),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                11,
                rusqlite::types::Type::Text,
                format!("unknown transcript state {other}").into(),
            )),
        }
    }
}

/// What a recording is of, given at its start: the call (if there is one
/// yet), the project and the client's people on it (the glossary of the
/// speech recognition).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RecordingLinks {
    pub call_id: Option<String>,
    /// Defaults to the call's project.
    pub project_id: Option<String>,
    /// People of the project.
    pub participant_ids: Vec<String>,
}

impl RecordingLinks {
    /// A recording of a call (its project comes from the call).
    pub fn call(call_id: &str) -> Self {
        Self {
            call_id: Some(call_id.to_owned()),
            ..Self::default()
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
    /// The call's project, or the project given at the start.
    pub project_id: Option<String>,
    /// People of `project_id` on the recording, in the order given.
    pub participant_ids: Vec<String>,
    pub status: RecordingState,
    /// Milliseconds since the Unix epoch, UTC.
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub files: RecordingFiles,
    pub transcript_state: TranscriptState,
    /// When the audio files were deleted ("Удалить запись"); the row, its
    /// transcript and its questions stay. `None` while the files are there.
    /// The second pass and the files' sweep skip such a recording.
    pub audio_deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

const SELECT: &str = "SELECT id, call_id, status, started_at, ended_at, me_file, others_file,
       created_at, updated_at, project_id, participant_ids, transcript_state, audio_deleted_at
  FROM recordings";

fn from_row(row: &Row) -> rusqlite::Result<Recording> {
    let status: String = row.get(2)?;
    let participant_ids: String = row.get(10)?;
    let transcript_state: String = row.get(11)?;
    Ok(Recording {
        id: row.get(0)?,
        call_id: row.get(1)?,
        project_id: row.get(9)?,
        participant_ids: serde_json::from_str(&participant_ids).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(10, rusqlite::types::Type::Text, error.into())
        })?,
        status: RecordingState::parse(&status)?,
        started_at: row.get(3)?,
        ended_at: row.get(4)?,
        files: RecordingFiles {
            me: row.get(5)?,
            others: row.get(6)?,
        },
        transcript_state: TranscriptState::parse(&transcript_state)?,
        audio_deleted_at: row.get(12)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub(super) fn not_found(id: &str) -> CommandError {
    CommandError::not_found(format!("Запись {id} не найдена"))
}

/// Adds a row in the `recording` state and returns its new id (UUID v7).
/// `files` names the channel files for that id (see
/// [`RecordingStore::files`]).
///
/// `NotFound` when the call doesn't exist. The project and the
/// participants only feed the glossary, which is best-effort: a project or
/// person deleted meanwhile, a project other than the call's (the call's
/// wins), a participant of another project or participants without a
/// project are dropped and logged, and the recording starts. A participant
/// given twice is stored once.
///
/// Insert the row before creating the files: a sweep deletes every folder
/// without a row.
pub fn create(
    connection: &Connection,
    links: &RecordingLinks,
    started_at: i64,
    files: impl FnOnce(&str) -> RecordingFiles,
) -> CommandResult<String> {
    let (project_id, participant_ids) = checked_links(connection, links)?;
    let id = super::new_id();
    let files = files(&id);
    let now = now_ms();
    connection.execute(
        "INSERT INTO recordings
           (id, call_id, project_id, participant_ids, status, started_at, ended_at,
            me_file, others_file, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?9)",
        params![
            id,
            links.call_id,
            project_id,
            serde_json::to_string(&participant_ids)?,
            RecordingState::Recording.as_str(),
            started_at,
            files.me,
            files.others,
            now
        ],
    )?;
    Ok(id)
}

/// The project (given or the call's) and the participants without repeats;
/// links that don't fit are dropped (see [`create`]).
fn checked_links(
    connection: &Connection,
    links: &RecordingLinks,
) -> CommandResult<(Option<String>, Vec<String>)> {
    let call_project = match &links.call_id {
        Some(call_id) => calls::project_of(connection, call_id)?,
        None => None,
    };
    let given = match &links.project_id {
        Some(project_id) => match projects::exists(connection, project_id) {
            Ok(()) => Some(project_id.clone()),
            Err(CommandError::NotFound { .. }) => {
                eprintln!("grill: recording without the unknown project {project_id}");
                None
            }
            Err(error) => return Err(error),
        },
        None => None,
    };
    let project_id = match (given, call_project) {
        (Some(given), Some(of_call)) if given != of_call => {
            eprintln!("grill: recording of a call of {of_call}, not of the project {given}");
            Some(of_call)
        }
        (given, of_call) => given.or(of_call),
    };
    let mut participant_ids: Vec<String> = Vec::with_capacity(links.participant_ids.len());
    for person_id in &links.participant_ids {
        let Some(project_id) = &project_id else {
            eprintln!("grill: recording without project: participants dropped");
            break;
        };
        let person = match people::get(connection, person_id) {
            Ok(person) => person,
            Err(CommandError::NotFound { .. }) => {
                eprintln!("grill: recording without the unknown participant {person_id}");
                continue;
            }
            Err(error) => return Err(error),
        };
        if person.project_id != *project_id {
            eprintln!("grill: recording without {person_id}, a person of another project");
            continue;
        }
        if !participant_ids.contains(person_id) {
            participant_ids.push(person_id.clone());
        }
    }
    Ok((project_id, participant_ids))
}

/// Records where the second pass is. `NotFound` for an unknown id.
pub fn set_transcript_state(
    connection: &Connection,
    id: &str,
    state: TranscriptState,
) -> CommandResult<()> {
    let changed = connection.execute(
        "UPDATE recordings SET transcript_state = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, state.as_str(), now_ms()],
    )?;
    if changed == 0 {
        return Err(not_found(id));
    }
    Ok(())
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<Recording> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| not_found(id))
}

/// The recordings of a call in the order they started. `NotFound` for an
/// unknown call.
pub fn for_call(connection: &Connection, call_id: &str) -> CommandResult<Vec<Recording>> {
    calls::project_of(connection, call_id)?;
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE call_id = ?1 ORDER BY started_at, id"
    ))?;
    let rows = statement.query_map([call_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Ids of every recording, oldest first.
pub fn list_ids(connection: &Connection) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare("SELECT id FROM recordings ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Ids of the recordings whose audio files are kept, oldest first: what the
/// files' sweep keeps. A recording being written has its files until it
/// ends, so it is among them.
pub fn ids_with_audio(connection: &Connection) -> CommandResult<Vec<String>> {
    let mut statement = connection
        .prepare("SELECT id FROM recordings WHERE audio_deleted_at IS NULL ORDER BY id")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Records that the audio of a stopped recording was deleted (post-call
/// design.md, decision 10): the row, its transcript, topics, cards and
/// questions stay. Deleting it again keeps the first time. Delete the files
/// first: the sweep removes whatever is left of them. `NotFound` for an
/// unknown id, `Invalid` while it is being written.
pub fn mark_audio_deleted(connection: &Connection, id: &str, at: i64) -> CommandResult<Recording> {
    let recording = get(connection, id)?;
    if recording.status == RecordingState::Recording {
        return Err(CommandError::invalid(
            "Аудио записи, которая идёт, удалить нельзя",
        ));
    }
    connection.execute(
        "UPDATE recordings
            SET audio_deleted_at = coalesce(audio_deleted_at, ?2), updated_at = ?3
          WHERE id = ?1",
        params![id, at, now_ms()],
    )?;
    get(connection, id)
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
/// neither file exists (or its audio was deleted). `data_dir` is what the
/// file paths are relative to.
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
            .filter(|_| recording.audio_deleted_at.is_none())
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
/// call or project, or left by a failed start) and what is left of the files
/// of a recording whose audio was deleted. Returns the removed ids.
///
/// Runs under the caller's connection: holding the database lock keeps a
/// recording from being created between the read of the ids and the sweep.
pub fn sweep(connection: &Connection, store: &dyn RecordingStore) -> CommandResult<Vec<String>> {
    let known: HashSet<String> = ids_with_audio(connection)?.into_iter().collect();
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
            people::{self, PersonCreate},
            projects,
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

    /// A project row with the columns of 0001, so it works on every schema
    /// version the migration tests start from.
    fn project(connection: &Connection, name: &str) -> String {
        let id = crate::storage::new_id();
        connection
            .execute(
                "INSERT INTO projects (id, name, description, created_at, updated_at)
                 VALUES (?1, ?2, '', 0, 0)",
                params![id, name],
            )
            .unwrap();
        id
    }

    fn call(connection: &Connection, project_id: &str) -> String {
        let input = CallCreate {
            project_id: Some(project_id.into()),
            ..Default::default()
        };
        calls::create(connection, input).unwrap().0.id
    }

    fn person(connection: &Connection, project_id: &str, name: &str) -> String {
        let input = PersonCreate {
            project_id: project_id.into(),
            name: name.into(),
            ..Default::default()
        };
        people::create(connection, input).unwrap().0.id
    }

    fn links(project_id: Option<&str>, participant_ids: &[&str]) -> RecordingLinks {
        RecordingLinks {
            call_id: None,
            project_id: project_id.map(str::to_owned),
            participant_ids: participant_ids.iter().map(|id| (*id).to_owned()).collect(),
        }
    }

    #[test]
    fn stores_the_project_and_its_people() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let olga = person(&connection, &acme, "Ольга");
        let ivan = person(&connection, &acme, "Иван");

        let id = create(
            &connection,
            &links(Some(&acme), &[&ivan, &olga, &ivan]),
            0,
            files,
        )
        .unwrap();
        let recording = get(&connection, &id).unwrap();
        assert_eq!(recording.project_id.as_deref(), Some(acme.as_str()));
        assert_eq!(
            recording.participant_ids,
            vec![ivan.clone(), olga],
            "once each, in order"
        );
        assert_eq!(recording.call_id, None);
        assert_eq!(recording.transcript_state, TranscriptState::Live);

        // A call gives its project.
        let call_id = call(&connection, &acme);
        let id = create(&connection, &RecordingLinks::call(&call_id), 0, files).unwrap();
        let recording = get(&connection, &id).unwrap();
        assert_eq!(recording.project_id.as_deref(), Some(acme.as_str()));
        assert!(recording.participant_ids.is_empty());
        let with_people = RecordingLinks {
            participant_ids: vec![ivan.clone()],
            ..RecordingLinks::call(&call_id)
        };
        let id = create(&connection, &with_people, 0, files).unwrap();
        assert_eq!(get(&connection, &id).unwrap().participant_ids, vec![ivan]);

        let loose = create(&connection, &RecordingLinks::default(), 0, files).unwrap();
        let loose = get(&connection, &loose).unwrap();
        assert_eq!(
            (loose.project_id, loose.participant_ids),
            (None, Vec::new())
        );
    }

    #[test]
    fn links_that_dont_fit_are_dropped_and_the_recording_starts() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let globex = project(&connection, "Globex");
        let olga = person(&connection, &acme, "Ольга");
        let marina = person(&connection, &globex, "Марина");
        let globex_call = call(&connection, &globex);
        let missing = "0190d1a0-0000-7000-8000-000000000000";

        let stored = |links: RecordingLinks| {
            let id = create(&connection, &links, 0, files).unwrap();
            let recording = get(&connection, &id).unwrap();
            (recording.project_id, recording.participant_ids)
        };
        // A project deleted meanwhile, and its people with it.
        assert_eq!(stored(links(Some(missing), &[missing])), (None, Vec::new()));
        // A person deleted meanwhile, a person of another project.
        assert_eq!(
            stored(links(Some(&acme), &[missing, &olga, &marina])),
            (Some(acme.clone()), vec![olga.clone()])
        );
        // People without a project.
        assert_eq!(stored(links(None, &[&olga])), (None, Vec::new()));
        // A project other than the call's: the call's wins.
        assert_eq!(
            stored(RecordingLinks {
                project_id: Some(acme.clone()),
                participant_ids: vec![olga.clone(), marina.clone()],
                ..RecordingLinks::call(&globex_call)
            }),
            (Some(globex.clone()), vec![marina.clone()])
        );

        // The call itself is still checked.
        let error = create(&connection, &RecordingLinks::call(missing), 0, files).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
        assert_eq!(list_ids(&connection).unwrap().len(), 4);
    }

    #[test]
    fn deleting_a_project_deletes_the_recordings_started_for_it() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let globex = project(&connection, "Globex");
        let of_acme = create(&connection, &links(Some(&acme), &[]), 0, files).unwrap();
        let of_globex = create(&connection, &links(Some(&globex), &[]), 0, files).unwrap();
        let loose = create(&connection, &RecordingLinks::default(), 0, files).unwrap();

        projects::delete(&connection, &acme).unwrap();

        assert!(get(&connection, &of_acme).is_err());
        assert_eq!(list_ids(&connection).unwrap(), vec![of_globex, loose]);
    }

    #[test]
    fn deleting_a_person_keeps_the_recording() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let olga = person(&connection, &acme, "Ольга");
        let id = create(&connection, &links(Some(&acme), &[&olga]), 0, files).unwrap();
        people::delete(&connection, &olga).unwrap();
        // The id stays in the list; readers skip people that are gone.
        assert_eq!(get(&connection, &id).unwrap().participant_ids, vec![olga]);
    }

    #[test]
    fn transcript_state_changes() {
        let connection = open_in_memory().unwrap();
        let id = create(&connection, &RecordingLinks::default(), 0, files).unwrap();
        for state in [
            TranscriptState::Refining,
            TranscriptState::Failed,
            TranscriptState::Refined,
        ] {
            set_transcript_state(&connection, &id, state).unwrap();
            assert_eq!(get(&connection, &id).unwrap().transcript_state, state);
        }
        let error = set_transcript_state(&connection, "nope", TranscriptState::Live).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }));
    }

    #[test]
    fn creates_finishes_and_lists() {
        let connection = open_in_memory().unwrap();
        let project_id = project(&connection, "Acme");
        let call_id = call(&connection, &project_id);

        let id = create(&connection, &RecordingLinks::call(&call_id), 1_000, files).unwrap();
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

        let loose = create(&connection, &RecordingLinks::default(), 2_000, files).unwrap();
        assert_eq!(list_ids(&connection).unwrap(), vec![id, loose]);
    }

    #[test]
    fn rejects_unknown_ids() {
        let connection = open_in_memory().unwrap();
        let missing = "0190d1a0-0000-7000-8000-000000000000";
        let error = create(&connection, &RecordingLinks::call(missing), 0, files).unwrap_err();
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
        let id = create(&connection, &RecordingLinks::default(), 5_000, files).unwrap();
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

        let of_acme = create(&connection, &RecordingLinks::call(&acme_call), 0, files).unwrap();
        let of_globex = create(&connection, &RecordingLinks::call(&globex_call), 0, files).unwrap();
        let of_other = create(&connection, &RecordingLinks::call(&other_call), 0, files).unwrap();
        let loose = create(&connection, &RecordingLinks::default(), 0, files).unwrap();

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
            Some(project_id)
        );
        let id = create(&connection, &RecordingLinks::call(&call_id), 0, files).unwrap();
        assert_eq!(list_ids(&connection).unwrap(), vec![id]);
    }

    #[test]
    fn migration_0003_keeps_the_recordings_of_0002_and_drops_the_old_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let before = [
            M::up(include_str!("../../migrations/0001_init.sql")),
            M::up(include_str!("../../migrations/0002_recordings.sql")),
        ];
        let (project_id, call_id, of_call, loose) = {
            let connection = open(&path, &Migrations::from_slice(&before)).unwrap();
            let project_id = project(&connection, "Acme");
            let call_id = call(&connection, &project_id);
            let insert = |id: &str, call_id: Option<&str>| {
                connection
                    .execute(
                        "INSERT INTO recordings
                           (id, call_id, status, started_at, ended_at, me_file, others_file,
                            created_at, updated_at)
                         VALUES (?1, ?2, 'finished', 0, 10, 'a', 'b', 0, 0)",
                        params![id, call_id],
                    )
                    .unwrap();
            };
            let of_call = "0190d1a0-0000-7000-8000-000000000001".to_owned();
            let loose = "0190d1a0-0000-7000-8000-000000000002".to_owned();
            insert(&of_call, Some(&call_id));
            insert(&loose, None);
            connection
                .execute(
                    "INSERT INTO transcript_segments
                       (id, call_id, channel, start_ms, end_ms, text, created_at, updated_at)
                     VALUES ('old', ?1, 'me', 0, 1, 'старый', 0, 0)",
                    [&call_id],
                )
                .unwrap();
            assert!(super::super::has_call_transcript(&connection));
            assert_eq!(super::super::call_transcript_rows(&connection), Some(1));
            (project_id, call_id, of_call, loose)
        };

        let connection = open(&path, &MIGRATIONS).unwrap();
        assert!(!super::super::has_call_transcript(&connection));
        assert_eq!(super::super::call_transcript_rows(&connection), None);
        let segments: i64 = connection
            .query_row("SELECT count(*) FROM transcript_segments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(segments, 0, "the old rows had no recording");

        let recording = get(&connection, &of_call).unwrap();
        assert_eq!(recording.call_id.as_deref(), Some(call_id.as_str()));
        assert_eq!(
            recording.project_id.as_deref(),
            Some(project_id.as_str()),
            "from the call"
        );
        assert!(recording.participant_ids.is_empty());
        assert_eq!(
            recording.transcript_state,
            TranscriptState::Skipped,
            "recorded before speech recognition: no second pass"
        );
        assert_eq!(recording.status, RecordingState::Finished);
        let loose = get(&connection, &loose).unwrap();
        assert_eq!(loose.project_id, None);
        let violations: i64 = connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);

        // The new transcript works on the migrated rows.
        let segment = crate::storage::transcript::SegmentInput {
            channel: crate::storage::transcript::TranscriptChannel::Me,
            start_ms: 0,
            end_ms: 1,
            text: "новый".to_owned(),
        };
        let (added, _) =
            crate::storage::transcript::append_live(&connection, &recording.id, segment).unwrap();
        assert_eq!(added.call_id.as_deref(), Some(call_id.as_str()));
        projects::delete(&connection, &project_id).unwrap();
        assert_eq!(list_ids(&connection).unwrap(), vec![loose.id]);
        let segments: i64 = connection
            .query_row("SELECT count(*) FROM transcript_segments", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(segments, 0);
    }

    #[test]
    fn migration_0004_keeps_the_recordings_and_transcript_of_0003() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let before = [
            M::up(include_str!("../../migrations/0001_init.sql")),
            M::up(include_str!("../../migrations/0002_recordings.sql")),
            M::up(include_str!(
                "../../migrations/0003_transcript_by_recording.sql"
            )),
        ];
        let of_call = "0190d1a0-0000-7000-8000-000000000001";
        let loose = "0190d1a0-0000-7000-8000-000000000002";
        let (project_id, call_id) = {
            let connection = open(&path, &Migrations::from_slice(&before)).unwrap();
            let project_id = project(&connection, "Acme");
            let call_id = call(&connection, &project_id);
            for (id, call) in [(of_call, Some(call_id.as_str())), (loose, None)] {
                connection
                    .execute(
                        "INSERT INTO recordings
                           (id, call_id, project_id, status, started_at, ended_at, me_file,
                            others_file, created_at, updated_at, transcript_state)
                         VALUES (?1, ?2, ?3, 'finished', 0, 10, 'a', 'b', 0, 0, 'refined')",
                        params![id, call, call.map(|_| project_id.as_str())],
                    )
                    .unwrap();
                connection
                    .execute(
                        "INSERT INTO transcript_segments
                           (id, recording_id, call_id, pass, channel, start_ms, end_ms, text,
                            created_at, updated_at)
                         VALUES (?1 || '-s', ?1, ?2, 'live', 'others', 0, 1, 'алло', 0, 0)",
                        params![id, call],
                    )
                    .unwrap();
            }
            // The old tables by call: never filled by the app, dropped by 0004.
            connection
                .execute_batch(&format!(
                    "INSERT INTO topics (id, call_id, title, position, created_at, updated_at)
                       VALUES ('t', '{call_id}', 'Тема', 0, 0, 0);
                     INSERT INTO questions (id, call_id, topic_id, text, created_at, updated_at)
                       VALUES ('q', '{call_id}', 't', 'Вопрос', 0, 0);"
                ))
                .unwrap();
            assert!(super::super::has_call_state(&connection));
            assert_eq!(super::super::call_state_rows(&connection), Some(2));
            (project_id, call_id)
        };

        let connection = open(&path, &MIGRATIONS).unwrap();
        assert!(!super::super::has_call_state(&connection));
        assert_eq!(super::super::call_state_rows(&connection), None);
        let count = |table: &str| -> i64 {
            connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap()
        };
        assert_eq!((count("topics"), count("questions")), (0, 0));

        // The recordings and their transcript are as they were.
        let recording = get(&connection, of_call).unwrap();
        assert_eq!(recording.call_id.as_deref(), Some(call_id.as_str()));
        assert_eq!(recording.project_id.as_deref(), Some(project_id.as_str()));
        assert_eq!(recording.transcript_state, TranscriptState::Refined);
        assert_eq!(recording.status, RecordingState::Finished);
        assert_eq!(get(&connection, loose).unwrap().call_id, None);
        for id in [of_call, loose] {
            let segments = crate::storage::transcript::for_recording(&connection, id).unwrap();
            assert_eq!(segments.len(), 1);
            assert_eq!(segments[0].text, "алло");
        }
        let violations: i64 = connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);

        // The new tables work on the migrated rows; deleting a recording
        // deletes its topics, cards, questions and agent calls.
        use crate::storage::call_state::{
            self, AgentCallInput, AgentCallOutcome, CardLens, Evidence, EvidenceSource, GapType,
            NewQuestion, ValidatedOp, ValidatedPatch,
        };
        let evidence = vec![Evidence {
            source: EvidenceSource::Segment,
            id: format!("{of_call}-s"),
            quote: "алло".to_owned(),
        }];
        let patch = ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Тема".to_owned(),
                },
                ValidatedOp::SetCardField {
                    field: CardLens::Goal,
                    value: "Цель".to_owned(),
                    evidence: evidence.clone(),
                },
                ValidatedOp::AddQuestion(NewQuestion {
                    text: "Вопрос".to_owned(),
                    description: String::new(),
                    card_field: CardLens::Goal,
                    gap_type: GapType::Empty,
                    priority: 1,
                    evidence,
                }),
            ],
        };
        for id in [of_call, loose] {
            call_state::apply_patch(&connection, id, &patch).unwrap();
            call_state::insert_agent_call(
                &connection,
                &AgentCallInput {
                    recording_id: id.to_owned(),
                    outcome: Some(AgentCallOutcome::Ok),
                    ..AgentCallInput::default()
                },
            )
            .unwrap();
        }
        let state = call_state::get(&connection, of_call).unwrap();
        assert_eq!(state.topics[0].call_id.as_deref(), Some(call_id.as_str()));
        assert_eq!(
            state.questions[0].call_id.as_deref(),
            Some(call_id.as_str())
        );
        assert_eq!(calls::get(&connection, &call_id).unwrap().open_questions, 1);
        delete(&connection, of_call).unwrap();
        for table in ["topics", "task_cards", "questions", "agent_calls"] {
            assert_eq!(count(table), 1, "{table}: only the loose recording's");
        }
        assert_eq!(
            call_state::get(&connection, loose).unwrap().questions.len(),
            1
        );
        let violations: i64 = connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(violations, 0);
    }

    #[test]
    fn rejects_an_unknown_status() {
        let connection = open_in_memory().unwrap();
        let error = connection
            .execute(
                "INSERT INTO recordings
                   (id, status, started_at, me_file, others_file, created_at, updated_at)
                 VALUES ('x', 'paused', 0, 'a', 'b', 0, 0)",
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
        let crashed = create(&connection, &RecordingLinks::default(), started_at, |id| {
            store.files(id)
        })
        .unwrap();
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
        let empty = create(&connection, &RecordingLinks::default(), started_at, |id| {
            store.files(id)
        })
        .unwrap();
        // Finished properly: left alone.
        let done = create(&connection, &RecordingLinks::default(), started_at, |id| {
            store.files(id)
        })
        .unwrap();
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

    /// Post-call decision 10: the row stays without its audio; the sweep
    /// keeps only the recordings that have it.
    #[test]
    fn marks_the_audio_deleted_and_sweeps_what_is_left() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open_in_memory().unwrap();
        let store = LocalStore::new(dir.path());
        let live = create(&connection, &RecordingLinks::default(), 0, |id| {
            store.files(id)
        })
        .unwrap();
        let error = mark_audio_deleted(&connection, &live, 10).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");

        let mut ids = Vec::new();
        for _ in 0..2 {
            let id = create(&connection, &RecordingLinks::default(), 0, |id| {
                store.files(id)
            })
            .unwrap();
            drop(store.create(&id).unwrap());
            store.finish(&id).unwrap();
            finish(&connection, &id, 50).unwrap();
            ids.push(id);
        }
        let [kept, deleted] = [ids[0].clone(), ids[1].clone()];
        let marked = mark_audio_deleted(&connection, &deleted, 100).unwrap();
        assert_eq!(marked.audio_deleted_at, Some(100));
        assert_eq!(marked.status, RecordingState::Finished);
        let again = mark_audio_deleted(&connection, &deleted, 200).unwrap();
        assert_eq!(again.audio_deleted_at, Some(100), "the first time stays");
        assert_eq!(get(&connection, &kept).unwrap().audio_deleted_at, None);
        assert_eq!(
            ids_with_audio(&connection).unwrap(),
            vec![live, kept.clone()]
        );
        assert_eq!(list_ids(&connection).unwrap().len(), 3);

        assert_eq!(sweep(&connection, &store).unwrap(), vec![deleted.clone()]);
        assert!(!dir.path().join("recordings").join(&deleted).exists());
        assert!(dir.path().join(store.files(&kept).me).exists());
        assert!(get(&connection, &deleted).is_ok(), "the row stays");
        let error = mark_audio_deleted(&connection, "nope", 0).unwrap_err();
        assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    }

    #[test]
    fn sweep_removes_the_files_of_deleted_recordings() {
        let dir = tempfile::tempdir().unwrap();
        let connection = open_in_memory().unwrap();
        let store = LocalStore::new(dir.path());
        let project_id = project(&connection, "Acme");
        let call_id = call(&connection, &project_id);

        let live = create(&connection, &RecordingLinks::default(), 0, |id| {
            store.files(id)
        })
        .unwrap();
        drop(store.create(&live).unwrap());
        store.finish(&live).unwrap();
        let of_call = create(&connection, &RecordingLinks::call(&call_id), 0, |id| {
            store.files(id)
        })
        .unwrap();
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
