//! Rows of the project's documents (projects-people-brief design.md,
//! decision 1). The files behind them belong to
//! [`crate::projects::sources::files`]; the extracted text never leaves
//! Rust except into the brief.

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::{context_findings::FindingSourceKind, new_id, now_ms, projects};
use crate::{
    connectors::ConnectorKind,
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
    /// Where a connector's document comes from; absent for a file.
    #[specta(optional)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<SourceOrigin>,
}

/// A document of a connector among the project's sources
/// (connectors-outline design.md, decision 3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceOrigin {
    pub connector: ConnectorKind,
    /// The document in the service.
    pub external_id: String,
    /// The document in the service, to open in the browser.
    pub url: Option<String>,
    /// When its text last changed here (a sync brought a new version),
    /// milliseconds since the Unix epoch, UTC.
    pub updated_at: i64,
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
       truncated, created_at, connector, external_id, external_url, updated_at
  FROM project_sources";

fn from_row(row: &Row) -> rusqlite::Result<ProjectSource> {
    let status: String = row.get(5)?;
    let connector: Option<String> = row.get(10)?;
    let origin = match connector {
        None => None,
        Some(name) => Some(SourceOrigin {
            connector: ConnectorKind::parse(&name).ok_or_else(|| {
                rusqlite::Error::FromSqlConversionFailure(
                    10,
                    rusqlite::types::Type::Text,
                    format!("unknown connector {name}").into(),
                )
            })?,
            external_id: row.get(11)?,
            url: row.get(12)?,
            updated_at: row.get(13)?,
        }),
    };
    Ok(ProjectSource {
        origin,
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
            &format!("{SELECT} WHERE project_id = ?1 AND sha256 = ?2 AND kind = 'file'"),
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

/// Deletes a document's row; its file goes after the commit. A
/// connector's document goes only with the selection (`Invalid`).
pub fn delete(connection: &Connection, id: &str) -> CommandResult<(Removed, Vec<DataChanged>)> {
    let (removed, connector) = connection
        .query_row(
            "SELECT project_id, stored_path, connector FROM project_sources WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    Removed {
                        project_id: row.get(0)?,
                        stored_path: row.get(1)?,
                    },
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| not_found(id))?;
    if let Some(kind) = connector.as_deref().and_then(ConnectorKind::parse) {
        return Err(CommandError::invalid(format!(
            "Документ {} убирается из проекта изменением выбора в {}",
            kind.label(),
            kind.label()
        )));
    }
    connection.execute("DELETE FROM project_sources WHERE id = ?1", [id])?;
    let event = projects::changed(&removed.project_id);
    Ok((removed, vec![event]))
}

/// The `sha256` of the project's `ready` files, sorted (the brief's
/// fingerprint, projects-people-brief design.md, decision 7).
pub fn ready_hashes(connection: &Connection, project_id: &str) -> CommandResult<Vec<String>> {
    let mut statement = connection.prepare(
        "SELECT sha256 FROM project_sources
          WHERE project_id = ?1 AND status = 'ready' AND kind = 'file'
          ORDER BY sha256",
    )?;
    let rows = statement.query_map([project_id], |row| row.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A `ready` document of a connector in the brief's fingerprint
/// (connectors-outline design.md, decision 8).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ConnectorHash {
    pub id: String,
    pub external_id: String,
    pub sha256: String,
}

/// The project's `ready` documents of connectors, sorted by id.
pub fn ready_connector_hashes(
    connection: &Connection,
    project_id: &str,
) -> CommandResult<Vec<ConnectorHash>> {
    let mut statement = connection.prepare(
        "SELECT id, external_id, sha256 FROM project_sources
          WHERE project_id = ?1 AND status = 'ready' AND kind = 'connector'
          ORDER BY id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok(ConnectorHash {
            id: row.get(0)?,
            external_id: row.get(1)?,
            sha256: row.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A `ready` document with its text, for the brief.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadySource {
    pub id: String,
    /// A file's name; `Outline: <title>` for a connector's document.
    pub name: String,
    pub extension: String,
    pub sha256: String,
    pub text: String,
    pub truncated: bool,
}

/// The project's `ready` documents with their text, in the order they were
/// added: files and connectors' documents alike.
pub fn ready_texts(connection: &Connection, project_id: &str) -> CommandResult<Vec<ReadySource>> {
    let mut statement = connection.prepare(
        "SELECT id, name, extension, sha256, text, truncated, connector FROM project_sources
          WHERE project_id = ?1 AND status = 'ready'
          ORDER BY created_at, id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        let name: String = row.get(1)?;
        let connector: Option<String> = row.get(6)?;
        let name = match connector.as_deref().and_then(ConnectorKind::parse) {
            Some(kind) => format!("{}: {name}", kind.label()),
            None => name,
        };
        Ok(ReadySource {
            id: row.get(0)?,
            name,
            extension: row.get(2)?,
            sha256: row.get(3)?,
            text: row.get(4)?,
            truncated: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A `ready` document the slow loop searches (agent-slow-loop design.md,
/// decision 2): a file, an Outline document or a ClickUp task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchableSource {
    pub id: String,
    /// The file's name, the document's or the task's title.
    pub name: String,
    pub kind: FindingSourceKind,
    /// The document or the task in its service; `None` for a file.
    pub url: Option<String>,
    pub text: String,
}

/// The project's `ready` files, Outline documents and ClickUp tasks with
/// their text and link, in the order they were added. Other connectors'
/// documents are not searched.
pub fn searchable_texts(
    connection: &Connection,
    project_id: &str,
) -> CommandResult<Vec<SearchableSource>> {
    let mut statement = connection.prepare(
        "SELECT id, name, connector, external_url, text FROM project_sources
          WHERE project_id = ?1 AND status = 'ready'
            AND (kind = 'file' OR connector IN ('outline', 'clickup'))
          ORDER BY created_at, id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        let connector: Option<String> = row.get(2)?;
        let kind = match connector.as_deref() {
            None => Some(FindingSourceKind::File),
            Some(name) => FindingSourceKind::parse(name),
        };
        let kind = kind.ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                2,
                rusqlite::types::Type::Text,
                format!("unsearchable connector {connector:?}").into(),
            )
        })?;
        Ok(SearchableSource {
            id: row.get(0)?,
            name: row.get(1)?,
            kind,
            url: if kind == FindingSourceKind::File {
                None
            } else {
                row.get(3)?
            },
            text: row.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Every stored path and every project id: what the sweep keeps.
pub fn known_files(connection: &Connection) -> CommandResult<(HashSet<String>, HashSet<String>)> {
    let mut statement =
        connection.prepare("SELECT stored_path FROM project_sources WHERE kind = 'file'")?;
    let paths = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let mut statement = connection.prepare("SELECT id FROM projects")?;
    let projects = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok((paths, projects))
}

/* Documents of connectors (connectors-outline design.md, decisions 3–4) */

/// A connector's document of the project, as a sync compares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorSource {
    pub id: String,
    pub external_id: String,
    /// The service's version of the text stored here.
    pub version: String,
    pub title: String,
    pub url: Option<String>,
    /// The team of the service it was synced with.
    pub account_ref: String,
}

/// The project's documents of the connector.
pub fn connector_sources(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
) -> CommandResult<Vec<ConnectorSource>> {
    let mut statement = connection.prepare(
        "SELECT id, external_id, coalesce(external_version, ''), name, external_url,
                coalesce(account_ref, '')
           FROM project_sources
          WHERE project_id = ?1 AND kind = 'connector' AND connector = ?2
          ORDER BY created_at, id",
    )?;
    let rows = statement.query_map(params![project_id, kind.as_str()], |row| {
        Ok(ConnectorSource {
            id: row.get(0)?,
            external_id: row.get(1)?,
            version: row.get(2)?,
            title: row.get(3)?,
            url: row.get(4)?,
            account_ref: row.get(5)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// A connector's document with its text, to add or update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorDocument {
    pub external_id: String,
    pub title: String,
    pub url: Option<String>,
    pub version: String,
    /// The text as read: normalized and capped like a file's.
    pub status: SourceStatus,
    pub text: String,
    pub text_chars: u32,
    pub truncated: bool,
    pub error: Option<String>,
    pub sha256: String,
}

/// What a sync changes in the project's documents of a connector.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConnectorChanges {
    /// The team of the service the upserted documents come from.
    pub account_ref: String,
    /// New documents and new versions; an existing row keeps its id.
    pub upserts: Vec<ConnectorDocument>,
    /// External ids of documents to remove.
    pub removals: Vec<String>,
}

/// Applies a sync's changes under the caller's transaction. `true` when a
/// row changed.
pub fn apply_connector_changes(
    connection: &Connection,
    project_id: &str,
    kind: ConnectorKind,
    changes: &ConnectorChanges,
    now: i64,
) -> CommandResult<bool> {
    projects::exists(connection, project_id)?;
    let mut changed = 0;
    for document in &changes.upserts {
        let name = Some(document.title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or("Без названия");
        let size = i64::try_from(document.text.len()).unwrap_or(i64::MAX);
        let updated = connection.execute(
            "UPDATE project_sources
                SET name = ?4, size = ?5, sha256 = ?6, text = ?7, text_chars = ?8,
                    truncated = ?9, status = ?10, error = ?11, external_url = ?12,
                    external_version = ?13, updated_at = ?14, account_ref = ?15
              WHERE project_id = ?1 AND kind = 'connector' AND connector = ?2
                AND external_id = ?3",
            params![
                project_id,
                kind.as_str(),
                document.external_id,
                name,
                size,
                document.sha256,
                document.text,
                document.text_chars,
                document.truncated,
                document.status.as_str(),
                document.error,
                document.url,
                document.version,
                now,
                changes.account_ref
            ],
        )?;
        if updated == 0 {
            connection.execute(
                "INSERT INTO project_sources
                   (id, project_id, kind, name, extension, size, sha256, stored_path, text,
                    text_chars, truncated, status, error, created_at, updated_at, connector,
                    external_id, external_url, external_version, account_ref)
                 VALUES (?1, ?2, 'connector', ?3, 'md', ?4, ?5, '', ?6, ?7, ?8, ?9, ?10, ?11,
                         ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    new_id(),
                    project_id,
                    name,
                    size,
                    document.sha256,
                    document.text,
                    document.text_chars,
                    document.truncated,
                    document.status.as_str(),
                    document.error,
                    now,
                    kind.as_str(),
                    document.external_id,
                    document.url,
                    document.version,
                    changes.account_ref
                ],
            )?;
        }
        changed += 1;
    }
    for external_id in &changes.removals {
        changed += connection.execute(
            "DELETE FROM project_sources
              WHERE project_id = ?1 AND kind = 'connector' AND connector = ?2
                AND external_id = ?3",
            params![project_id, kind.as_str(), external_id],
        )?;
    }
    Ok(changed > 0)
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

    /// v8 → v9 (connectors-outline task 1.3): every file row is copied as it
    /// is, its text and the brief's fingerprint stay (the brief is still
    /// fresh), and the foreign keys hold.
    #[test]
    fn migration_0009_keeps_the_files_and_the_brief_of_version_8() {
        use crate::{projects::brief_inputs, storage::MIGRATION_LIST};

        let project = "0190d1a0-0000-7000-8000-000000000001";
        let seed = format!(
            "INSERT INTO projects (id, name, description, notes, created_at, updated_at)
               VALUES ('{project}', 'Телемедиа', 'Звонки', 'Заметки', 1, 2);
             INSERT INTO people (id, project_id, name, role, profile, created_at, updated_at)
               VALUES ('person', '{project}', 'Ольга', 'CEO', '{{\"tech\":1}}', 1, 1);
             INSERT INTO project_sources
               (id, project_id, kind, name, extension, size, sha256, stored_path, text,
                text_chars, truncated, status, error, created_at, updated_at)
             VALUES
               ('s1', '{project}', 'file', 'ТЗ.docx', 'docx', 10, '{a}', 'projects/p/sources/s1.docx',
                'Текст ТЗ', 8, 0, 'ready', NULL, 5, 6),
               ('s2', '{project}', 'file', 'скан.pdf', 'pdf', 20, '{b}', 'projects/p/sources/s2.pdf',
                '', 0, 0, 'no_text', 'Нет текста', 7, 7),
               ('s3', '{project}', 'file', 'длинный.md', 'md', 30, '{c}', 'projects/p/sources/s3.md',
                'Очень длинный', 13, 1, 'ready', NULL, 8, 9);",
            a = "a".repeat(64),
            b = "b".repeat(64),
            c = "c".repeat(64),
        );
        // The fingerprint the brief was built from, as v8 computed it: the
        // same data in a database of this build (a project of files only
        // hashes as before).
        let expected = {
            let connection = crate::storage::open_in_memory().unwrap();
            connection.execute_batch(&seed).unwrap();
            brief_inputs::fingerprint(&connection, project).unwrap()
        };
        let rows = |connection: &Connection| -> Vec<Vec<String>> {
            let mut statement = connection
                .prepare(
                    "SELECT id, project_id, kind, name, extension, size, sha256, stored_path, text,
                            text_chars, truncated, status, coalesce(error, '-'), created_at,
                            updated_at
                       FROM project_sources ORDER BY id",
                )
                .unwrap();
            statement
                .query_map([], |row| {
                    (0..15)
                        .map(|index| {
                            row.get::<_, rusqlite::types::Value>(index)
                                .map(|value| format!("{value:?}"))
                        })
                        .collect()
                })
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let before = {
            let connection = open(&path, &Migrations::from_slice(&MIGRATION_LIST[..8])).unwrap();
            connection.execute_batch(&seed).unwrap();
            connection
                .execute(
                    "UPDATE projects SET brief = '{\"product\":\"Колл-центр\"}',
                            brief_built_at = 3, brief_inputs = ?1",
                    [&expected],
                )
                .unwrap();
            rows(&connection)
        };

        let connection = open(&path, &MIGRATIONS).unwrap();
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION as i64);
        assert!(crate::storage::backup_path(&path, 8).exists());
        assert_eq!(rows(&connection), before, "file rows copied as they are");
        assert_eq!(
            count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
            0
        );
        assert_eq!(
            brief_inputs::fingerprint(&connection, project).unwrap(),
            expected
        );
        assert_eq!(
            projects::get(&connection, project).unwrap().brief_state,
            BriefState::Fresh
        );
        let texts = ready_texts(&connection, project).unwrap();
        assert_eq!(
            texts
                .iter()
                .map(|source| source.text.as_str())
                .collect::<Vec<_>>(),
            ["Текст ТЗ", "Очень длинный"]
        );
        assert!(
            list(&connection, project)
                .unwrap()
                .iter()
                .all(|source| source.origin.is_none())
        );
        // The same content is still a file of a project once.
        let twice = insert(&connection, &source(project, 'a')).unwrap_err();
        assert!(matches!(twice, CommandError::Invalid { .. }), "{twice:?}");
    }

    fn document(external_id: &str, text: &str) -> ConnectorDocument {
        ConnectorDocument {
            external_id: external_id.to_owned(),
            title: format!("Документ {external_id}"),
            url: Some(format!("https://wandry.getoutline.com/doc/{external_id}")),
            version: "2026-01-01T00:00:01.000Z".to_owned(),
            status: SourceStatus::Ready,
            text: text.to_owned(),
            text_chars: u32::try_from(text.chars().count()).unwrap(),
            truncated: false,
            error: None,
            sha256: crate::projects::sha256_hex(text.as_bytes()),
        }
    }

    fn upsert(connection: &Connection, project: &str, documents: Vec<ConnectorDocument>) -> bool {
        let changes = ConnectorChanges {
            upserts: documents,
            ..ConnectorChanges::default()
        };
        apply_connector_changes(
            connection,
            project,
            ConnectorKind::Outline,
            &changes,
            now_ms(),
        )
        .unwrap()
    }

    /// Two documents with the same text are fine; a document is in a
    /// project once; a connector's row has no file; deleting the project
    /// takes its selection, sync state and connector sources, but not the
    /// connection.
    #[test]
    fn connector_documents_follow_the_new_constraints() {
        use crate::{
            connectors::{Account, SelectionItem, SelectionItemKind},
            storage::connectors as stored,
        };

        let connection = crate::storage::open_in_memory().unwrap();
        let create = |name: &str| {
            projects::create(
                &connection,
                projects::ProjectCreate {
                    name: name.to_owned(),
                    ..projects::ProjectCreate::default()
                },
            )
            .unwrap()
            .0
            .id
        };
        let (first, second) = (create("Телемедиа"), create("Лапа"));
        assert!(upsert(
            &connection,
            &first,
            vec![document("d1", "Один текст"), document("d2", "Один текст")]
        ));
        // A file with that same text, too.
        let mut file = source(&first, 'x');
        file.sha256 = crate::projects::sha256_hex("Один текст".as_bytes());
        insert(&connection, &file).unwrap();
        assert_eq!(list(&connection, &first).unwrap().len(), 3);

        let twice = connection.execute(
            "INSERT INTO project_sources
               (id, project_id, kind, name, extension, size, sha256, stored_path, status,
                created_at, updated_at, connector, external_id, account_ref)
             VALUES ('x', ?1, 'connector', 'Д', 'md', 0, ?2, '', 'ready', 1, 1, 'outline', 'd1',
                     'team')",
            [&first, &"e".repeat(64)],
        );
        assert!(
            twice.is_err(),
            "a document of a service is in a project once"
        );
        for sql in [
            // A connector's document has no copy of a file.
            "UPDATE project_sources SET stored_path = 'projects/x' WHERE external_id = 'd1'",
            // A file is not a document of a service.
            "UPDATE project_sources SET connector = 'outline' WHERE kind = 'file'",
            "UPDATE project_sources SET connector = 'notion' WHERE external_id = 'd1'",
            // A connector's document knows its team; a file has none.
            "UPDATE project_sources SET account_ref = NULL WHERE external_id = 'd1'",
            "UPDATE project_sources SET account_ref = 'team' WHERE kind = 'file'",
        ] {
            assert!(connection.execute(sql, []).is_err(), "{sql}");
        }
        // The same document in another project is another source.
        assert!(upsert(
            &connection,
            &second,
            vec![document("d1", "Один текст")]
        ));

        // A document of a service is removed with the selection, not here.
        let outline = list(&connection, &first)
            .unwrap()
            .into_iter()
            .find(|source| source.origin.is_some())
            .unwrap();
        assert!(matches!(
            delete(&connection, &outline.id).unwrap_err(),
            CommandError::Invalid { .. }
        ));

        let account = Account {
            host: Some("https://wandry.getoutline.com".to_owned()),
            team_id: "team".to_owned(),
            team_name: "Wandry".to_owned(),
            user_name: None,
        };
        stored::save_connected(&connection, ConnectorKind::Outline, &account, 1).unwrap();
        let items = [SelectionItem {
            item_kind: SelectionItemKind::Container,
            external_id: "tm".to_owned(),
            title: "Телемедиа".to_owned(),
            url: None,
        }];
        for project in [&first, &second] {
            stored::replace_selection(
                &connection,
                project,
                ConnectorKind::Outline,
                Some("team"),
                &items,
                1,
            )
            .unwrap();
            stored::record_sync_ok(&connection, project, ConnectorKind::Outline, 0, 1).unwrap();
        }

        projects::delete(&connection, &first).unwrap();
        for table in ["connector_selections", "project_connector_sync"] {
            assert_eq!(
                count(
                    &connection,
                    &format!("SELECT count(*) FROM {table} WHERE project_id = '{first}'")
                ),
                0,
                "{table}"
            );
            assert_eq!(
                count(
                    &connection,
                    &format!("SELECT count(*) FROM {table} WHERE project_id = '{second}'")
                ),
                1,
                "{table}"
            );
        }
        assert_eq!(
            count(&connection, "SELECT count(*) FROM project_sources"),
            1
        );
        assert_eq!(count(&connection, "SELECT count(*) FROM connections"), 1);
    }

    /// Applying a sync: new rows, then an update keeps the id, a removal
    /// goes; `ready_texts` names them `Outline: <title>` and the fingerprint
    /// follows their text.
    #[test]
    fn connector_changes_apply_and_feed_the_brief() {
        use crate::projects::brief_inputs;

        let connection = crate::storage::open_in_memory().unwrap();
        let (project, _) = projects::create(
            &connection,
            projects::ProjectCreate {
                name: "Телемедиа".to_owned(),
                ..projects::ProjectCreate::default()
            },
        )
        .unwrap();
        let id = project.id;
        insert(&connection, &source(&id, 'a')).unwrap();
        let files_only = brief_inputs::fingerprint(&connection, &id).unwrap();
        upsert(
            &connection,
            &id,
            vec![document("d1", "Первый"), document("d2", "Второй")],
        );
        let with_outline = brief_inputs::fingerprint(&connection, &id).unwrap();
        assert_ne!(files_only, with_outline);
        let before = connector_sources(&connection, &id, ConnectorKind::Outline).unwrap();
        assert_eq!(before.len(), 2);

        let texts = ready_texts(&connection, &id).unwrap();
        assert_eq!(
            texts
                .iter()
                .map(|source| source.name.as_str())
                .collect::<Vec<_>>(),
            ["ТЗ.md", "Outline: Документ d1", "Outline: Документ d2"]
        );
        let listed = list(&connection, &id).unwrap();
        let origin = listed[1].origin.clone().unwrap();
        assert_eq!(origin.connector, ConnectorKind::Outline);
        assert_eq!(origin.external_id, "d1");
        assert_eq!(
            origin.url.as_deref(),
            Some("https://wandry.getoutline.com/doc/d1")
        );
        assert_eq!(listed[1].extension, "md");
        assert_eq!(listed[1].size, "Первый".len() as i64);

        // A new version of d1: same row, new text, new fingerprint.
        let mut changed = document("d1", "Первый, исправленный");
        changed.version = "2026-01-01T00:00:02.000Z".to_owned();
        upsert(&connection, &id, vec![changed]);
        let after = connector_sources(&connection, &id, ConnectorKind::Outline).unwrap();
        assert_eq!(after[0].id, before[0].id);
        assert_eq!(after[0].version, "2026-01-01T00:00:02.000Z");
        assert_ne!(
            brief_inputs::fingerprint(&connection, &id).unwrap(),
            with_outline
        );

        // Removing every document of Outline gives the files' fingerprint.
        let removals = ConnectorChanges {
            removals: vec!["d1".to_owned(), "d2".to_owned()],
            ..ConnectorChanges::default()
        };
        assert!(
            apply_connector_changes(&connection, &id, ConnectorKind::Outline, &removals, 11)
                .unwrap()
        );
        assert_eq!(
            brief_inputs::fingerprint(&connection, &id).unwrap(),
            files_only
        );
        assert!(
            !apply_connector_changes(&connection, &id, ConnectorKind::Outline, &removals, 12)
                .unwrap(),
            "nothing left to remove"
        );
    }

    /// Task 1.2: a file, an Outline document and a ClickUp task come with
    /// their kind and link; what is not ready, and GitHub, does not.
    #[test]
    fn searchable_texts_have_their_kind_and_link() {
        use crate::agent::fast_loop::testing::{add_source, database, recording};

        let db = database();
        let recording_id = recording(&db);
        let file = add_source(&db, &recording_id, None, "ТЗ.docx", "Текст ТЗ", true);
        add_source(&db, &recording_id, None, "скан.pdf", "", false);
        let outline = add_source(
            &db,
            &recording_id,
            Some("outline"),
            "Регламент смены",
            "# Регламент",
            true,
        );
        add_source(&db, &recording_id, Some("outline"), "Черновик", "x", false);
        let task = add_source(
            &db,
            &recording_id,
            Some("clickup"),
            "Задача",
            "# Задача",
            true,
        );
        add_source(
            &db,
            &recording_id,
            Some("github"),
            "README",
            "# Readme",
            true,
        );
        let project_id = crate::storage::recordings::get(&db, &recording_id)
            .unwrap()
            .project_id
            .unwrap();

        let found = searchable_texts(&db, &project_id).unwrap();
        let seen: Vec<(&str, &str, FindingSourceKind, Option<&str>, &str)> = found
            .iter()
            .map(|source| {
                (
                    source.id.as_str(),
                    source.name.as_str(),
                    source.kind,
                    source.url.as_deref(),
                    source.text.as_str(),
                )
            })
            .collect();
        let outline_url = format!("https://outline.example/{outline}");
        let task_url = format!("https://clickup.example/{task}");
        let mut expected = vec![
            (
                file.as_str(),
                "ТЗ.docx",
                FindingSourceKind::File,
                None,
                "Текст ТЗ",
            ),
            (
                outline.as_str(),
                "Регламент смены",
                FindingSourceKind::Outline,
                Some(outline_url.as_str()),
                "# Регламент",
            ),
            (
                task.as_str(),
                "Задача",
                FindingSourceKind::ClickUp,
                Some(task_url.as_str()),
                "# Задача",
            ),
        ];
        // Same `created_at`: by id.
        expected.sort_by_key(|row| row.0);
        assert_eq!(seen, expected);
    }
}
