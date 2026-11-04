//! Rows of the project's documents (projects-people-brief design.md,
//! decision 1). The files behind them belong to
//! [`crate::projects::sources::files`]; the extracted text never leaves
//! Rust except into the brief.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{now_ms, projects};
use crate::{
    error::{CommandError, CommandResult},
    events::DataChanged,
};

/// Whether the text of a document could be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SourceStatus {
    /// The text was read; the brief is built from it.
    Ready,
    /// Nothing to read, e.g. a scanned PDF. Kept, never sent to the agent.
    NoText,
    /// The file could not be read; `error` says why.
    Failed,
}

impl SourceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::NoText => "no_text",
            Self::Failed => "failed",
        }
    }

    fn parse(text: &str) -> rusqlite::Result<Self> {
        match text {
            "ready" => Ok(Self::Ready),
            "no_text" => Ok(Self::NoText),
            "failed" => Ok(Self::Failed),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                5,
                rusqlite::types::Type::Text,
                format!("unknown source status {other}").into(),
            )),
        }
    }
}

/// A document of a project, as the screens see it: no text, no path.
#[derive(Debug, Clone, PartialEq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSource {
    pub id: String,
    pub project_id: String,
    /// The file name as it was added, e.g. `ТЗ.docx`.
    pub name: String,
    /// Lower case, without the dot: `md`, `txt`, `pdf` or `docx`.
    pub extension: String,
    /// Bytes.
    pub size: i64,
    pub status: SourceStatus,
    /// Why the text could not be read (`failed`) or why there is none
    /// (`noText`).
    pub error: Option<String>,
    /// Characters of the stored text.
    pub text_chars: u32,
    /// The text was cut at the limit.
    pub truncated: bool,
    /// Milliseconds since the Unix epoch, UTC.
    pub created_at: i64,
}

/// A document to insert; its id and copy are made by the caller.
#[derive(Debug, Clone, PartialEq)]
pub struct NewSource {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub extension: String,
    pub size: i64,
    pub sha256: String,
    /// Relative to the app data folder.
    pub stored_path: String,
    pub status: SourceStatus,
    pub text: String,
    pub text_chars: u32,
    pub truncated: bool,
    pub error: Option<String>,
}

const SELECT: &str = "SELECT id, project_id, name, extension, size, status, error, text_chars,
       truncated, created_at
  FROM project_sources";

fn from_row(row: &Row) -> rusqlite::Result<ProjectSource> {
    let status: String = row.get(5)?;
    Ok(ProjectSource {
        id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        extension: row.get(3)?,
        size: row.get(4)?,
        status: SourceStatus::parse(&status)?,
        error: row.get(6)?,
        text_chars: row.get(7)?,
        truncated: row.get(8)?,
        created_at: row.get(9)?,
    })
}

pub(crate) fn not_found(id: &str) -> CommandError {
    CommandError::not_found(format!("Документ {id} не найден"))
}

/// The project's documents in the order they were added. `NotFound` for an
/// unknown project.
pub fn list(connection: &Connection, project_id: &str) -> CommandResult<Vec<ProjectSource>> {
    projects::exists(connection, project_id)?;
    let mut statement = connection.prepare(&format!(
        "{SELECT} WHERE project_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = statement.query_map([project_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn get(connection: &Connection, id: &str) -> CommandResult<ProjectSource> {
    connection
        .query_row(&format!("{SELECT} WHERE id = ?1"), [id], from_row)
        .optional()?
        .ok_or_else(|| not_found(id))
}

/// The document of the project with this content, if there is one.
pub fn find_by_sha256(
    connection: &Connection,
    project_id: &str,
    sha256: &str,
) -> CommandResult<Option<ProjectSource>> {
    Ok(connection
        .query_row(
            &format!("{SELECT} WHERE project_id = ?1 AND sha256 = ?2"),
            [project_id, sha256],
            from_row,
        )
        .optional()?)
}

/// Inserts a document. A UNIQUE violation (the same content raced in) is
/// `Invalid`; the caller looks the existing one up.
pub fn insert(
    connection: &Connection,
    source: &NewSource,
) -> CommandResult<(ProjectSource, Vec<DataChanged>)> {
    projects::exists(connection, &source.project_id)?;
    let now = now_ms();
    connection.execute(
        "INSERT INTO project_sources
           (id, project_id, kind, name, extension, size, sha256, stored_path, text, text_chars,
            truncated, status, error, created_at, updated_at)
         VALUES (?1, ?2, 'file', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            source.id,
            source.project_id,
            source.name,
            source.extension,
            source.size,
            source.sha256,
            source.stored_path,
            source.text,
            source.text_chars,
            source.truncated,
            source.status.as_str(),
            source.error,
            now
        ],
    )?;
    let inserted = get(connection, &source.id)?;
    Ok((inserted, vec![projects::changed(&source.project_id)]))
}

/// What a deleted document leaves to clean up after the commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Removed {
    pub project_id: String,
    pub stored_path: String,
}

/// Deletes a document's row; its file goes after the commit.
pub fn delete(connection: &Connection, id: &str) -> CommandResult<(Removed, Vec<DataChanged>)> {
    let removed = connection
        .query_row(
            "SELECT project_id, stored_path FROM project_sources WHERE id = ?1",
            [id],
            |row| {
                Ok(Removed {
                    project_id: row.get(0)?,
                    stored_path: row.get(1)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| not_found(id))?;
    connection.execute("DELETE FROM project_sources WHERE id = ?1", [id])?;
    let event = projects::changed(&removed.project_id);
    Ok((removed, vec![event]))
}

/// The `sha256` of the project's `ready` documents, sorted (the brief's
/// fingerprint, decision 7).
pub fn ready_hashes(connection: &Connection, project_id: &str) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT sha256 FROM project_sources
          WHERE project_id = ?1 AND status = 'ready'
          ORDER BY sha256",
    )?;
    let rows = statement.query_map([project_id], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A `ready` document with its text, for the brief.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadySource {
    pub id: String,
    pub name: String,
    pub extension: String,
    pub sha256: String,
    pub text: String,
    pub truncated: bool,
}

/// The project's `ready` documents with their text, in the order they were
/// added.
pub fn ready_texts(connection: &Connection, project_id: &str) -> CommandResult<Vec<ReadySource>> {
    let mut statement = connection.prepare(
        "SELECT id, name, extension, sha256, text, truncated FROM project_sources
          WHERE project_id = ?1 AND status = 'ready'
          ORDER BY created_at, id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok(ReadySource {
            id: row.get(0)?,
            name: row.get(1)?,
            extension: row.get(2)?,
            sha256: row.get(3)?,
            text: row.get(4)?,
            truncated: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every stored path and every project id: what the sweep keeps.
pub fn known_files(connection: &Connection) -> CommandResult<(HashSet<String>, HashSet<String>)> {
    let mut statement = connection.prepare("SELECT stored_path FROM project_sources")?;
    let paths = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let mut statement = connection.prepare("SELECT id FROM projects")?;
    let projects = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok((paths, projects))
}

#[cfg(test)]
mod tests {
    use rusqlite_migration::{M, Migrations};
    use serde_json::json;

    use super::*;
    use crate::storage::{
        DATABASE_FILE, MIGRATIONS, SCHEMA_VERSION, open, people, projects::BriefState,
    };

    fn source(project_id: &str, sha: char) -> NewSource {
        let id = crate::storage::new_id();
        NewSource {
            stored_path: format!("projects/{project_id}/sources/{id}.md"),
            id,
            project_id: project_id.to_owned(),
            name: "ТЗ.md".to_owned(),
            extension: "md".to_owned(),
            size: 4,
            sha256: sha.to_string().repeat(64),
            status: SourceStatus::Ready,
            text: "text".to_owned(),
            text_chars: 4,
            truncated: false,
            error: None,
        }
    }

    fn count(connection: &Connection, sql: &str) -> i64 {
        connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    /// v4 → v5: projects, people, calls and recordings stay; projects get
    /// empty notes and no brief provenance; documents cascade with their
    /// project.
    #[test]
    fn migration_0005_keeps_the_data_of_0004() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let before = [
            M::up(include_str!("../../migrations/0001_init.sql")),
            M::up(include_str!("../../migrations/0002_recordings.sql")),
            M::up(include_str!(
                "../../migrations/0003_transcript_by_recording.sql"
            )),
            M::up(include_str!(
                "../../migrations/0004_call_state_by_recording.sql"
            )),
        ];
        let (with_brief, plain) = (
            "0190d1a0-0000-7000-8000-000000000001",
            "0190d1a0-0000-7000-8000-000000000002",
        );
        {
            let connection = open(&path, &Migrations::from_slice(&before)).unwrap();
            connection
                .execute_batch(&format!(
                    "INSERT INTO projects (id, name, description, brief, created_at, updated_at)
                       VALUES ('{with_brief}', 'Телемедиа', 'Звонки', '{{\"product\":\"Колл-центр\"}}', 1, 2),
                              ('{plain}', 'Лапа', '', NULL, 3, 3);
                     INSERT INTO people (id, project_id, name, role, profile, created_at, updated_at)
                       VALUES ('person', '{with_brief}', 'Ольга', 'CEO', '{{\"tech\":1}}', 1, 1);
                     INSERT INTO calls (id, project_id, title, status, created_at, updated_at)
                       VALUES ('call', '{with_brief}', 'Звонок', 'finished', 1, 1);
                     INSERT INTO recordings
                       (id, call_id, project_id, status, started_at, ended_at, me_file,
                        others_file, created_at, updated_at)
                       VALUES ('rec', 'call', '{with_brief}', 'finished', 5, 10, 'a', 'b', 5, 5);"
                ))
                .unwrap();
        }

        let connection = open(&path, &MIGRATIONS).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION as i64);
        assert!(crate::storage::backup_path(&path, 4).exists());
        let project = projects::get(&connection, with_brief).unwrap();
        assert_eq!(project.name, "Телемедиа");
        assert_eq!(project.description, "Звонки");
        assert_eq!(project.brief, Some(json!({ "product": "Колл-центр" })));
        assert_eq!((project.created_at, project.updated_at), (1, 2));
        assert_eq!(project.notes, "");
        assert_eq!(project.brief_built_at, None);
        assert!(!project.brief_truncated);
        // Built before fingerprints existed: may be outdated.
        assert_eq!(project.brief_state, BriefState::Outdated);
        assert_eq!(
            projects::get(&connection, plain).unwrap().brief_state,
            BriefState::None
        );
        assert_eq!(
            people::list(&connection, with_brief).unwrap()[0].name,
            "Ольга"
        );
        assert_eq!(count(&connection, "SELECT count(*) FROM recordings"), 1);
        assert_eq!(
            count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
            0
        );

        // Documents: one per content and project, gone with the project.
        insert(&connection, &source(with_brief, 'a')).unwrap();
        insert(&connection, &source(plain, 'a')).unwrap();
        let twice = insert(&connection, &source(with_brief, 'a')).unwrap_err();
        assert!(matches!(twice, CommandError::Invalid { .. }), "{twice:?}");
        insert(&connection, &source(with_brief, 'b')).unwrap();
        assert_eq!(list(&connection, with_brief).unwrap().len(), 2);
        projects::delete(&connection, with_brief).unwrap();
        assert_eq!(
            count(&connection, "SELECT count(*) FROM project_sources"),
            1
        );
        assert_eq!(count(&connection, "SELECT count(*) FROM recordings"), 0);
        assert_eq!(
            count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
            0
        );
    }

    #[test]
    fn rejects_an_unknown_status_and_kind() {
        let connection = crate::storage::open_in_memory().unwrap();
        let (project, _) = projects::create(
            &connection,
            projects::ProjectCreate {
                name: "Телемедиа".to_owned(),
                ..projects::ProjectCreate::default()
            },
        )
        .unwrap();
        let row = source(&project.id, 'c');
        insert(&connection, &row).unwrap();
        for sql in [
            "UPDATE project_sources SET status = 'scan'",
            "UPDATE project_sources SET kind = 'outline'",
            "UPDATE project_sources SET sha256 = 'short'",
        ] {
            assert!(connection.execute(sql, []).is_err(), "{sql}");
        }
        assert_eq!(
            get(&connection, &row.id).unwrap().status,
            SourceStatus::Ready
        );
    }
}
