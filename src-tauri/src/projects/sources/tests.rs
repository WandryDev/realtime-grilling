//! Scenarios of `specs/project-sources` on a real data folder.

use std::{fs, path::Path};

use super::{extract::fixtures, *};
use crate::{
    events::{Change, DataChanged, Entity, testing::RecordingSink},
    projects::brief_inputs,
    storage::{
        projects::{Project, ProjectCreate},
        sources::SourceStatus,
    },
};

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

struct Fixture {
    data: tempfile::TempDir,
    /// Where the manager's originals are.
    desk: tempfile::TempDir,
    storage: Storage,
    sink: RecordingSink,
}

impl Fixture {
    fn new() -> Self {
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(data.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        Self {
            data,
            desk: tempfile::tempdir().unwrap(),
            storage,
            sink: RecordingSink::default(),
        }
    }

    fn project(&self, name: &str) -> Project {
        let input = ProjectCreate {
            name: name.to_owned(),
            ..ProjectCreate::default()
        };
        block_on(
            self.storage
                .write(&self.sink, move |db| projects::create(db, input)),
        )
        .unwrap()
    }

    /// A file on the manager's desk.
    fn original(&self, name: &str, bytes: &[u8]) -> String {
        let path = self.desk.path().join(name);
        fs::write(&path, bytes).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn add(&self, project: &Project, paths: &[&str]) -> Vec<SourceAddResult> {
        let paths = paths.iter().map(|path| (*path).to_owned()).collect();
        block_on(add(&self.storage, &self.sink, &project.id, paths)).unwrap()
    }

    fn add_one(&self, project: &Project, path: &str) -> SourceAddOutcome {
        self.add(project, &[path]).remove(0).result
    }

    fn list(&self, project: &Project) -> Vec<ProjectSource> {
        let id = project.id.clone();
        block_on(self.storage.read(move |db| sources::list(db, &id))).unwrap()
    }

    fn copy_of(&self, source: &ProjectSource) -> std::path::PathBuf {
        self.data
            .path()
            .join("projects")
            .join(&source.project_id)
            .join("sources")
            .join(format!("{}.{}", source.id, source.extension))
    }

    fn fingerprint(&self, project: &Project) -> String {
        let id = project.id.clone();
        block_on(
            self.storage
                .read(move |db| brief_inputs::fingerprint(db, &id)),
        )
        .unwrap()
    }
}

fn added(outcome: SourceAddOutcome) -> ProjectSource {
    match outcome {
        SourceAddOutcome::Added { source } => source,
        other => panic!("not added: {other:?}"),
    }
}

fn project_updated(project: &Project) -> DataChanged {
    DataChanged::new(
        Entity::Project,
        &project.id,
        Some(&project.id),
        Change::Updated,
    )
}

#[test]
fn adds_a_copy_with_its_text() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let path = fx.original("ТЗ.md", "# ТЗ\n\nОчередь звонков".as_bytes());

    let results = fx.add(&project, &[&path]);

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].path, path);
    assert_eq!(results[0].name, "ТЗ.md");
    let source = added(results[0].result.clone());
    assert!(uuid::Uuid::parse_str(&source.id).is_ok());
    assert_eq!(source.project_id, project.id);
    assert_eq!(source.name, "ТЗ.md");
    assert_eq!(source.extension, "md");
    assert_eq!(source.size, "# ТЗ\n\nОчередь звонков".len() as i64);
    assert_eq!(source.status, SourceStatus::Ready);
    assert_eq!(source.error, None);
    assert_eq!(source.text_chars, 21);
    assert!(!source.truncated);
    assert_eq!(
        fs::read(fx.copy_of(&source)).unwrap(),
        fs::read(&path).unwrap()
    );
    assert_eq!(fx.list(&project), vec![source]);
    assert_eq!(fx.sink.events().last(), Some(&project_updated(&project)));
    // The record never carries the text.
    let json = serde_json::to_value(&results[0]).unwrap();
    assert_eq!(json["result"]["outcome"], "added");
    assert!(json["result"]["source"].get("text").is_none());
    assert_eq!(json["result"]["source"]["textChars"], 21);
}

/// «Тот же файл второй раз».
#[test]
fn the_same_content_twice_is_a_duplicate() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let first = fx.original("ТЗ.txt", b"same content");
    let renamed = fx.original("ТЗ (копия).txt", b"same content");
    let source = added(fx.add_one(&project, &first));
    let events = fx.sink.events().len();

    let results = fx.add(&project, &[&first, &renamed]);

    for result in results {
        assert_eq!(
            result.result,
            SourceAddOutcome::Duplicate {
                source: source.clone()
            }
        );
    }
    assert_eq!(fx.list(&project).len(), 1);
    assert_eq!(
        fx.sink.events().len(),
        events,
        "a duplicate changes nothing"
    );
    // Another project may have the same file.
    let other = fx.project("Другой");
    added(fx.add_one(&other, &first));
}

/// «Неподдерживаемый файл», too large, unreadable: nothing is stored, the
/// other files of the batch still go.
#[test]
fn rejects_other_types_large_and_unreadable_files() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let sheet = fx.original("смета.xlsx", b"PK");
    let no_extension = fx.original("README", b"text");
    let large = fx.original("архив.txt", b"");
    fs::File::options()
        .write(true)
        .open(&large)
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    let folder = fx.desk.path().join("папка.md");
    fs::create_dir(&folder).unwrap();
    let missing = fx.desk.path().join("нет.pdf");
    let good = fx.original("ok.txt", b"fine");

    let results = fx.add(
        &project,
        &[
            &sheet,
            &no_extension,
            &large,
            &folder.to_string_lossy(),
            &missing.to_string_lossy(),
            &good,
        ],
    );

    let reasons: Vec<Option<RejectReason>> = results
        .iter()
        .map(|result| match &result.result {
            SourceAddOutcome::Rejected { reason, .. } => Some(*reason),
            _ => None,
        })
        .collect();
    assert_eq!(
        reasons,
        [
            Some(RejectReason::UnsupportedType),
            Some(RejectReason::UnsupportedType),
            Some(RejectReason::TooLarge),
            Some(RejectReason::Unreadable),
            Some(RejectReason::Unreadable),
            None,
        ]
    );
    let SourceAddOutcome::Rejected { message, .. } = &results[0].result else {
        unreachable!()
    };
    assert_eq!(message, "Поддерживаются .md, .txt, .pdf и .docx");
    assert_eq!(fx.list(&project).len(), 1);
    let json = serde_json::to_value(&results[2]).unwrap();
    assert_eq!(json["result"]["outcome"], "rejected");
    assert_eq!(json["result"]["reason"], "tooLarge");
}

#[test]
fn every_format_and_its_state() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let (cp1251, _, _) = encoding_rs::WINDOWS_1251.encode("Переписка с Одессой");
    let files = [
        fx.original(
            "ТЗ.docx",
            &fixtures::docx("<w:p><w:r><w:t>Модули</w:t></w:r></w:p>"),
        ),
        fx.original("переписка.txt", &cp1251),
        fx.original(
            "договор.PDF",
            &fixtures::pdf(&[Some("Contract between the parties, page one")]),
        ),
        fx.original("скан.pdf", &fixtures::pdf(&[None])),
        fx.original("битый.docx", b"not a zip at all"),
    ];
    let paths: Vec<&str> = files.iter().map(String::as_str).collect();

    let sources: Vec<ProjectSource> = fx
        .add(&project, &paths)
        .into_iter()
        .map(|r| added(r.result))
        .collect();

    let states: Vec<_> = sources
        .iter()
        .map(|source| (source.extension.as_str(), source.status))
        .collect();
    assert_eq!(
        states,
        [
            ("docx", SourceStatus::Ready),
            ("txt", SourceStatus::Ready),
            ("pdf", SourceStatus::Ready),
            ("pdf", SourceStatus::NoText),
            ("docx", SourceStatus::Failed),
        ]
    );
    assert_eq!(
        sources[3].error.as_deref(),
        Some("Нет текста: похоже на скан")
    );
    assert!(sources[4].error.is_some());
    // Only the readable ones go to the brief.
    let id = project.id.clone();
    let inputs = block_on(fx.storage.read(move |db| brief_inputs::read(db, &id))).unwrap();
    let texts: Vec<&str> = inputs
        .sources
        .iter()
        .map(|source| source.text.as_str())
        .collect();
    assert_eq!(texts.len(), 3);
    assert_eq!(texts[0], "Модули");
    assert_eq!(texts[1], "Переписка с Одессой");
    assert!(texts[2].contains("Contract"), "{texts:?}");
}

/// «Оригинал удалён».
#[test]
fn the_copy_outlives_the_original() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let path = fx.original("ТЗ.txt", "Медэлемент".as_bytes());
    let source = added(fx.add_one(&project, &path));
    fs::remove_file(&path).unwrap();

    assert_eq!(fx.list(&project), vec![source.clone()]);
    assert!(fx.copy_of(&source).exists());
    let id = project.id.clone();
    let inputs = block_on(fx.storage.read(move |db| brief_inputs::read(db, &id))).unwrap();
    assert_eq!(inputs.sources[0].text, "Медэлемент");
}

/// «Удалить документ»: the row and the copy go, the inputs of the brief
/// change.
#[test]
fn removing_a_document_removes_its_copy() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let before = fx.fingerprint(&project);
    let source = added(fx.add_one(&project, &fx.original("ТЗ.md", b"text")));
    let with_document = fx.fingerprint(&project);
    assert_ne!(before, with_document);

    block_on(remove(&fx.storage, &fx.sink, source.id.clone())).unwrap();

    assert!(fx.list(&project).is_empty());
    assert!(!fx.copy_of(&source).exists());
    assert_eq!(fx.sink.events().last(), Some(&project_updated(&project)));
    assert_eq!(fx.fingerprint(&project), before);
    let error = block_on(remove(&fx.storage, &fx.sink, source.id.clone())).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }));
}

#[test]
fn a_scan_does_not_change_the_inputs_of_the_brief() {
    let fx = Fixture::new();
    let project = fx.project("Телемедиа");
    let before = fx.fingerprint(&project);
    let scan = added(fx.add_one(&project, &fx.original("скан.pdf", &fixtures::pdf(&[None]))));
    assert_eq!(scan.status, SourceStatus::NoText);
    assert_eq!(fx.fingerprint(&project), before);
}

#[test]
fn unknown_projects_are_not_found() {
    let fx = Fixture::new();
    let path = fx.original("ТЗ.md", b"text");
    let error = block_on(add(
        &fx.storage,
        &fx.sink,
        "0190d1a0-0000-7000-8000-000000000001",
        vec![path],
    ))
    .unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }));
    let error = block_on(fx.storage.read(|db| sources::list(db, "nope"))).unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }));
}

/// Deleting a project deletes its documents' rows (cascade) and folder;
/// the next start sweeps copies without a row and folders without a
/// project.
#[test]
fn project_delete_and_the_sweep_at_start_remove_the_files() {
    let fx = Fixture::new();
    let deleted = fx.project("Удаляемый");
    let kept = fx.project("Оставшийся");
    let gone = added(fx.add_one(&deleted, &fx.original("a.md", b"a")));
    let stays = added(fx.add_one(&kept, &fx.original("b.md", b"b")));
    let id = deleted.id.clone();
    block_on(
        fx.storage
            .write(&fx.sink, move |db| projects::delete(db, &id)),
    )
    .unwrap();
    remove_project_files(&fx.storage, &deleted.id);
    let rows: i64 = block_on(fx.storage.read(|db| {
        Ok(db.query_row("SELECT count(*) FROM project_sources", [], |row| row.get(0))?)
    }))
    .unwrap();
    assert_eq!(rows, 1);
    assert!(!fx.copy_of(&gone).exists());
    assert!(!fx.data.path().join("projects").join(&deleted.id).exists());

    // A crash left a copy without a row and a folder of a deleted project.
    let orphan = fx
        .copy_of(&stays)
        .with_file_name("0190d1a0-0000-7000-8000-0000000000ff.md");
    fs::write(&orphan, b"x").unwrap();
    let stale = fx
        .data
        .path()
        .join("projects")
        .join(&deleted.id)
        .join("sources");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("x.md"), b"x").unwrap();
    let Fixture { data, storage, .. } = fx;
    let copy_of_stays = data
        .path()
        .join("projects")
        .join(&kept.id)
        .join("sources")
        .join(format!("{}.md", stays.id));
    drop(storage);

    let reopened = Storage::open_in(data.path());
    assert!(reopened.error().is_none());
    assert!(!orphan.exists());
    assert!(!data.path().join("projects").join(&deleted.id).exists());
    assert!(Path::new(&copy_of_stays).exists());
}
