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
    /// `null`: a call without a project ("Звонок без проекта").
    pub project_id: Option<String>,
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
    /// A call without a project when absent; it has no participants then.
    #[specta(optional)]
    pub project_id: Option<String>,
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

/// The call's project (`None` for a call without one); `NotFound` when
/// there is no such call.
pub fn project_of(connection: &Connection, id: &str) -> CommandResult<Option<String>> {
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
    if let Some(project_id) = &input.project_id {
        projects::exists(connection, project_id)?;
    }
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
        insert_participant(connection, &id, input.project_id.as_deref(), &person_id)?;
    }
    let call = get(connection, &id)?;
    let event = DataChanged::new(
        Entity::Call,
        &id,
        call.project_id.as_deref(),
        Change::Created,
    );
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
    let event = DataChanged::new(
        Entity::Call,
        id,
        call.project_id.as_deref(),
        Change::Updated,
    );
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
    let event = DataChanged::new(
        Entity::Call,
        id,
        call.project_id.as_deref(),
        Change::Updated,
    );
    Ok((call, vec![event]))
}

/// Deletes the call with its topics, cards, questions and transcript.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<((), Vec<DataChanged>)> {
    let project_id = project_of(connection, id)?;
    connection.execute("DELETE FROM calls WHERE id = ?1", [id])?;
    let event = DataChanged::new(Entity::Call, id, project_id.as_deref(), Change::Deleted);
    Ok(((), vec![event]))
}

fn insert_participant(
    connection: &Connection,
    call_id: &str,
    project_id: Option<&str>,
    person_id: &str,
) -> CommandResult<()> {
    let person = people::get(connection, person_id)?;
    let Some(project_id) = project_id else {
        return Err(CommandError::invalid(format!(
            "У звонка без проекта нет участников: {} не может быть в нём",
            person.name
        )));
    };
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
    insert_participant(connection, call_id, project_id.as_deref(), person_id)?;
    touch(connection, call_id)?;
    let call = get(connection, call_id)?;
    let event = DataChanged::new(
        Entity::Call,
        call_id,
        project_id.as_deref(),
        Change::Updated,
    );
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
    let event = DataChanged::new(
        Entity::Call,
        call_id,
        project_id.as_deref(),
        Change::Updated,
    );
    Ok((call, vec![event]))
}

/// What a new call starts with when nobody picks (call-lifecycle design.md,
/// decision 7): the project and the people of the last call.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallSetup {
    pub project_id: Option<String>,
    pub participant_ids: Vec<String>,
}

/// The project and participants of the newest call (by its start); none
/// without calls. A deleted project takes its calls along and a deleted
/// person leaves the calls' participants, so both still exist.
pub fn last_setup(connection: &Connection) -> CommandResult<CallSetup> {
    let last = connection
        .query_row(
            &format!(
                "{SELECT} ORDER BY coalesce(c.started_at, c.created_at) DESC, c.id DESC LIMIT 1"
            ),
            [],
            from_row,
        )
        .optional()?;
    Ok(last.map_or_else(CallSetup::default, |call| CallSetup {
        project_id: call.project_id,
        participant_ids: call.participant_ids,
    }))
}

/// At start, after the interrupted recordings are marked (decision 9): a
/// call still `live` or `finishing` was left by a crash or a quit and
/// becomes `finished`, ending when its last recording ended (at its start
/// without recordings). Returns the ids it changed.
pub fn finish_stale(connection: &Connection, now: i64) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "UPDATE calls
            SET status = 'finished',
                ended_at = coalesce(
                  (SELECT max(r.ended_at) FROM recordings r WHERE r.call_id = calls.id),
                  started_at, ended_at, created_at),
                updated_at = MAX(?1, updated_at + 1)
          WHERE status IN ('live', 'finishing')
      RETURNING id",
    )?;
    let rows = statement.query_map([now], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use rusqlite_migration::Migrations;

    use super::*;
    use crate::storage::{
        DATABASE_FILE, MIGRATION_LIST, open, open_in_memory,
        people::PersonCreate,
        projects::ProjectCreate,
        recordings::{self, RecordingFiles, RecordingLinks},
        transcript::{self, SegmentInput, TranscriptChannel},
    };

    fn files(id: &str) -> RecordingFiles {
        RecordingFiles {
            me: format!("recordings/{id}/me.opus"),
            others: format!("recordings/{id}/others.opus"),
        }
    }

    fn project(connection: &Connection, name: &str) -> String {
        let input = ProjectCreate {
            name: name.to_owned(),
            ..ProjectCreate::default()
        };
        projects::create(connection, input).unwrap().0.id
    }

    fn person(connection: &Connection, project_id: &str, name: &str) -> String {
        let input = PersonCreate {
            project_id: project_id.to_owned(),
            name: name.to_owned(),
            ..PersonCreate::default()
        };
        people::create(connection, input).unwrap().0.id
    }

    fn call(
        connection: &Connection,
        project_id: Option<&str>,
        participants: &[&str],
        started_at: i64,
    ) -> String {
        let input = CallCreate {
            project_id: project_id.map(str::to_owned),
            started_at: Some(started_at),
            participant_ids: Some(participants.iter().map(|id| (*id).to_owned()).collect()),
            ..CallCreate::default()
        };
        create(connection, input).unwrap().0.id
    }

    fn recording(connection: &Connection, call_id: &str, started_at: i64) -> String {
        recordings::create(
            connection,
            &RecordingLinks::call(call_id),
            started_at,
            files,
        )
        .unwrap()
    }

    fn foreign_key_violations(connection: &Connection) -> i64 {
        connection
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    /// `local-storage`, "Модель данных": rows of a version 5 database stay,
    /// and every table that refers to `calls` refers to the rebuilt one.
    #[test]
    fn migration_0006_keeps_the_calls_of_version_5() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let (acme, igor, call_id, recording_id) = {
            let v5 = Migrations::from_slice(&MIGRATION_LIST[..5]);
            let connection = open(&path, &v5).unwrap();
            let acme = project(&connection, "Acme");
            let igor = person(&connection, &acme, "Игорь");
            let call_id = call(&connection, Some(&acme), &[&igor], 1_000);
            let recording_id = recording(&connection, &call_id, 1_000);
            recordings::finish(&connection, &recording_id, 5_000).unwrap();
            let segment = SegmentInput {
                channel: TranscriptChannel::Others,
                start_ms: 0,
                end_ms: 10,
                text: "Здравствуйте".to_owned(),
            };
            transcript::append_live(&connection, &recording_id, segment).unwrap();
            connection
                .execute_batch(&format!(
                    "INSERT INTO topics (id, recording_id, call_id, title, position, created_at, updated_at)
                     VALUES ('t1', '{recording_id}', '{call_id}', 'Очередь', 0, 0, 0);
                     INSERT INTO questions (id, recording_id, call_id, topic_id, text, created_at, updated_at)
                     VALUES ('q1', '{recording_id}', '{call_id}', 't1', 'Сколько звонков?', 0, 0);"
                ))
                .unwrap();
            (acme, igor, call_id, recording_id)
        };

        let connection = open(&path, &crate::storage::MIGRATIONS).unwrap();
        assert_eq!(foreign_key_violations(&connection), 0);
        let migrated = get(&connection, &call_id).unwrap();
        assert_eq!(migrated.project_id.as_deref(), Some(acme.as_str()));
        assert_eq!(migrated.participant_ids, vec![igor]);
        assert_eq!(migrated.started_at, Some(1_000));
        assert_eq!(migrated.open_questions, 1);
        assert_eq!(
            recordings::get(&connection, &recording_id).unwrap().call_id,
            Some(call_id.clone())
        );
        assert_eq!(
            transcript::for_recording(&connection, &recording_id)
                .unwrap()
                .len(),
            1
        );
        for table in [
            "call_participants",
            "recordings",
            "transcript_segments",
            "topics",
            "task_cards",
            "questions",
        ] {
            let parent: String = connection
                .query_row(
                    "SELECT \"table\" FROM pragma_foreign_key_list(?1) WHERE \"from\" = 'call_id'",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(parent, "calls", "{table}");
        }

        // The cascades still work on the rebuilt table.
        projects::delete(&connection, &acme).unwrap();
        for table in [
            "calls",
            "call_participants",
            "recordings",
            "questions",
            "topics",
        ] {
            let rows: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(rows, 0, "{table}");
        }
    }

    /// `local-storage`, "Звонок без проекта".
    #[test]
    fn a_call_without_a_project_outlives_every_project() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let loose = call(&connection, None, &[], 1_000);
        let recording_id = recording(&connection, &loose, 1_000);
        let (created, events) = create(&connection, CallCreate::default()).unwrap();
        assert_eq!(created.project_id, None);
        assert_eq!(
            events,
            vec![DataChanged::new(
                Entity::Call,
                &created.id,
                None,
                Change::Created
            )]
        );

        projects::delete(&connection, &acme).unwrap();
        assert_eq!(get(&connection, &loose).unwrap().project_id, None);
        assert_eq!(
            recordings::get(&connection, &recording_id).unwrap().call_id,
            Some(loose.clone())
        );
        assert_eq!(list(&connection, None).unwrap().len(), 2);
        assert_eq!(list(&connection, Some(&acme)).unwrap().len(), 0);
    }

    #[test]
    fn a_call_without_a_project_has_no_participants() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");
        let igor = person(&connection, &acme, "Игорь");
        let input = CallCreate {
            participant_ids: Some(vec![igor.clone()]),
            ..CallCreate::default()
        };
        let error = create(&connection, input).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
        let loose = call(&connection, None, &[], 1_000);
        let error = add_participant(&connection, &loose, &igor).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    }

    #[test]
    fn last_setup_is_the_newest_call_with_the_people_that_still_exist() {
        let connection = open_in_memory().unwrap();
        assert_eq!(last_setup(&connection).unwrap(), CallSetup::default());

        let exchange = project(&connection, "Обменник");
        let igor = person(&connection, &exchange, "Игорь");
        let olga = person(&connection, &exchange, "Ольга");
        let other = project(&connection, "Телемедиа");
        call(&connection, Some(&other), &[], 1_000);
        call(&connection, Some(&exchange), &[&olga, &igor], 2_000);
        // Created later, but started earlier: not the last call.
        call(&connection, Some(&other), &[], 1_500);

        assert_eq!(
            last_setup(&connection).unwrap(),
            CallSetup {
                project_id: Some(exchange.clone()),
                participant_ids: vec![olga.clone(), igor.clone()],
            }
        );

        people::delete(&connection, &olga).unwrap();
        assert_eq!(
            last_setup(&connection).unwrap(),
            CallSetup {
                project_id: Some(exchange.clone()),
                participant_ids: vec![igor],
            }
        );

        // The project is gone with its calls: the last call left is Телемедиа's.
        projects::delete(&connection, &exchange).unwrap();
        assert_eq!(
            last_setup(&connection).unwrap(),
            CallSetup {
                project_id: Some(other),
                participant_ids: Vec::new(),
            }
        );

        call(&connection, None, &[], 3_000);
        assert_eq!(last_setup(&connection).unwrap(), CallSetup::default());
    }

    #[test]
    fn finish_stale_ends_calls_at_their_last_recording() {
        let connection = open_in_memory().unwrap();
        let acme = project(&connection, "Acme");

        let empty = call(&connection, Some(&acme), &[], 1_000);
        let two = call(&connection, Some(&acme), &[], 2_000);
        let first = recording(&connection, &two, 2_000);
        recordings::finish(&connection, &first, 3_000).unwrap();
        let second = recording(&connection, &two, 4_000);
        recordings::mark_interrupted(&connection, &second, 7_000).unwrap();
        let finishing = call(&connection, None, &[], 10_000);
        let only = recording(&connection, &finishing, 10_000);
        recordings::finish(&connection, &only, 12_000).unwrap();
        update(
            &connection,
            &finishing,
            CallUpdate {
                status: Some(CallStatus::Finishing),
                ended_at: Some(Some(12_000)),
                ..CallUpdate::default()
            },
        )
        .unwrap();
        let done = call(&connection, Some(&acme), &[], 20_000);
        update(
            &connection,
            &done,
            CallUpdate {
                status: Some(CallStatus::Finished),
                ended_at: Some(Some(25_000)),
                ..CallUpdate::default()
            },
        )
        .unwrap();

        let mut finished = finish_stale(&connection, 99_000).unwrap();
        finished.sort();
        let mut expected = vec![empty.clone(), two.clone(), finishing.clone()];
        expected.sort();
        assert_eq!(finished, expected);

        let ended = |id: &str| {
            let call = get(&connection, id).unwrap();
            assert_eq!(call.status, CallStatus::Finished, "{id}");
            call.ended_at
        };
        assert_eq!(ended(&empty), Some(1_000), "no recordings: its start");
        assert_eq!(ended(&two), Some(7_000), "the later of two recordings");
        assert_eq!(ended(&finishing), Some(12_000));
        assert_eq!(ended(&done), Some(25_000), "a finished call stays as it is");
        assert!(finish_stale(&connection, 99_000).unwrap().is_empty());
    }
}
