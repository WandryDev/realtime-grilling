//! The data of «Общие» and «Приватность» (settings-real tasks 3.1, 3.3) on
//! a temp database and a fake secret store.

use serde_json::json;

use super::*;
use crate::{
    connectors::{Account, Credential, secrets::MemoryStore},
    events::testing::RecordingSink,
    recording::store::RecordingStore,
    storage::{
        calls::{self, CallCreate, CallStatus},
        connectors,
        people::{self, PersonCreate},
        projects::{self, ProjectCreate},
        recordings::{self, RecordingLinks},
        settings::SettingsMap,
    },
};

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

struct Fixture {
    dir: tempfile::TempDir,
    storage: Storage,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(dir.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        Self { dir, storage }
    }

    fn now<T>(&self, work: impl FnOnce(&Connection) -> CommandResult<T>) -> T {
        self.storage.read_now(work).unwrap()
    }

    /// A finished call (of `project`, if given) with one recording whose
    /// files hold `bytes` bytes each.
    fn call_with_audio(&self, project: Option<&str>, bytes: usize) -> (String, String) {
        let store = self.storage.recording_store().unwrap();
        self.now(|db| {
            let (call, _) = calls::create(
                db,
                CallCreate {
                    project_id: project.map(str::to_owned),
                    status: Some(CallStatus::Finished),
                    ..CallCreate::default()
                },
            )?;
            let id = recordings::create(db, &RecordingLinks::call(&call.id), 1_000, |id| {
                store.files(id)
            })?;
            let mut writers = store.create(&id).unwrap();
            writers.me.write_all(&vec![1; bytes]).unwrap();
            writers.others.write_all(&vec![2; bytes]).unwrap();
            writers.me.sync().unwrap();
            writers.others.sync().unwrap();
            drop(writers);
            store.finish(&id).unwrap();
            recordings::finish(db, &id, 2_000)?;
            Ok((call.id, id))
        })
    }

    fn count(&self, table: &str) -> i64 {
        let sql = format!("SELECT count(*) FROM {table}");
        self.now(move |db| Ok(db.query_row(&sql, [], |row| row.get(0))?))
    }

    fn recordings_dir(&self) -> std::path::PathBuf {
        recordings_dir(self.dir.path())
    }
}

use std::io::Write as _;

/// `app-settings`, «Папка записей и место».
#[test]
fn recordings_info_counts_the_files_and_the_calls_with_audio() {
    let fx = Fixture::new();
    let empty = block_on(recordings_info(&fx.storage)).unwrap();
    assert_eq!(
        empty,
        RecordingsInfo {
            path: fx.recordings_dir().to_string_lossy().into_owned(),
            bytes: 0,
            calls: 0,
        },
        "no folder yet"
    );

    let (_, first) = fx.call_with_audio(None, 1_000);
    fx.call_with_audio(None, 500);
    let (deleted_call, deleted) = fx.call_with_audio(None, 300);
    // A call without recordings has no audio.
    fx.now(|db| calls::create(db, CallCreate::default()).map(|_| ()));
    // «Удалить запись» on the third: marked, files gone.
    fx.now(|db| recordings::mark_audio_deleted(db, &deleted, 3_000).map(|_| ()));
    fx.storage
        .recording_store()
        .unwrap()
        .delete(&deleted)
        .unwrap();
    // A stray file in the folder counts as what the folder takes.
    std::fs::write(fx.recordings_dir().join("stray.txt"), [0; 7]).unwrap();

    let info = block_on(recordings_info(&fx.storage)).unwrap();
    assert_eq!(info.calls, 2, "{deleted_call} has no audio any more");
    assert_eq!(info.bytes, 2 * 1_000 + 2 * 500 + 7);
    assert!(fx.recordings_dir().join(&first).exists());
}

/// `app-settings`, «Удалить всё»: the summary's numbers.
#[test]
fn data_summary_counts_projects_calls_and_bytes() {
    let fx = Fixture::new();
    assert_eq!(
        block_on(summary(&fx.storage)).unwrap(),
        DataSummary {
            projects: 0,
            calls: 0,
            bytes: 0
        }
    );
    let project = fx.now(|db| {
        projects::create(
            db,
            ProjectCreate {
                name: "Пилот".to_owned(),
                ..ProjectCreate::default()
            },
        )
        .map(|(project, _)| project.id)
    });
    fx.now(|db| {
        projects::create(
            db,
            ProjectCreate {
                name: "Второй".to_owned(),
                ..ProjectCreate::default()
            },
        )
        .map(|_| ())
    });
    fx.call_with_audio(Some(&project), 100);
    fx.call_with_audio(None, 50);
    assert_eq!(
        block_on(summary(&fx.storage)).unwrap(),
        DataSummary {
            projects: 2,
            calls: 2,
            bytes: 300
        }
    );
}

/// `app-settings`, «Удалить всё»: no rows, no files, no secrets, the
/// default settings (onboarding again).
#[test]
fn delete_everything_leaves_nothing() {
    let fx = Fixture::new();
    let project = fx.now(|db| {
        let (project, _) = projects::create(
            db,
            ProjectCreate {
                name: "Пилот".to_owned(),
                ..ProjectCreate::default()
            },
        )?;
        people::create(
            db,
            PersonCreate {
                project_id: project.id.clone(),
                name: "Ольга".to_owned(),
                ..PersonCreate::default()
            },
        )?;
        let account = Account {
            host: None,
            team_id: "t".to_owned(),
            team_name: "Команда".to_owned(),
            user_name: None,
        };
        connectors::save_connected(db, ConnectorKind::Outline, &account, 1)?;
        let patch = SettingsMap::from([
            (settings::ONBOARDING_COMPLETED.to_owned(), json!(true)),
            (
                settings::AGENT_PATH.to_owned(),
                json!("/usr/local/bin/claude"),
            ),
            (settings::MICROPHONE.to_owned(), json!("USB Mic")),
            (settings::HIDE_ON_SHARE.to_owned(), json!(false)),
        ]);
        settings::put(db, &patch)?;
        Ok(project.id)
    });
    let (project_call, _) = fx.call_with_audio(Some(&project), 100);
    let (loose_call, _) = fx.call_with_audio(None, 100);
    let secrets = MemoryStore::default();
    for kind in [ConnectorKind::Outline, ConnectorKind::ClickUp] {
        secrets
            .set(
                kind,
                &Credential::ApiKey {
                    key: "secret".to_owned(),
                },
            )
            .unwrap();
    }
    let documents = fx.dir.path().join("projects").join(&project);
    std::fs::create_dir_all(&documents).unwrap();
    std::fs::write(documents.join("brief.md"), "x").unwrap();

    let sink = RecordingSink::default();
    block_on(delete_everything(&fx.storage, &sink, &secrets)).unwrap();

    let tables = fx.now(tables);
    assert!(tables.contains(&"calls".to_owned()));
    for table in &tables {
        assert_eq!(fx.count(table), 0, "{table} is empty");
    }
    let left: Vec<_> = std::fs::read_dir(fx.recordings_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "{left:?}");
    assert!(!documents.exists(), "the project's documents are gone");
    assert!(secrets.raw().is_empty(), "no secrets");
    let stored = fx.now(settings::get);
    assert_eq!(stored, settings::defaults());
    assert!(!settings::flag(&stored, settings::ONBOARDING_COMPLETED));
    assert!(!stored.contains_key(settings::AGENT_PATH));

    let events = sink.events();
    assert!(events.contains(&DataChanged::new(
        Entity::Project,
        &project,
        Some(&project),
        Change::Deleted
    )));
    assert!(events.contains(&DataChanged::new(
        Entity::Call,
        &loose_call,
        None,
        Change::Deleted
    )));
    assert!(
        !events.iter().any(|event| event.id == project_call),
        "a project's call goes with its project's event"
    );
    assert!(events.contains(&DataChanged::new(
        Entity::Connections,
        "outline",
        None,
        Change::Deleted
    )));
    assert_eq!(events.last().unwrap().entity, Entity::Settings);

    // The database still works: a new project after it.
    fx.now(|db| {
        projects::create(
            db,
            ProjectCreate {
                name: "Заново".to_owned(),
                ..ProjectCreate::default()
            },
        )
        .map(|_| ())
    });
}

#[test]
fn a_secret_that_cannot_go_is_reported_after_the_rest() {
    struct Refusing;

    impl SecretStore for Refusing {
        fn get(
            &self,
            _kind: ConnectorKind,
        ) -> Result<Credential, crate::connectors::secrets::SecretError> {
            Err(crate::connectors::secrets::SecretError::Missing)
        }

        fn set(
            &self,
            _kind: ConnectorKind,
            _credential: &Credential,
        ) -> Result<(), crate::connectors::secrets::SecretError> {
            Ok(())
        }

        fn delete(
            &self,
            _kind: ConnectorKind,
        ) -> Result<(), crate::connectors::secrets::SecretError> {
            Err(crate::connectors::secrets::SecretError::Store(
                "Keychain заблокирован".to_owned(),
            ))
        }
    }

    let fx = Fixture::new();
    fx.call_with_audio(None, 10);
    let sink = RecordingSink::default();
    let error = block_on(delete_everything(&fx.storage, &sink, &Refusing)).unwrap_err();
    assert!(matches!(error, CommandError::External { .. }), "{error:?}");
    assert!(error.to_string().contains("Keychain"), "{error}");
    assert_eq!(fx.count("calls"), 0);
}
