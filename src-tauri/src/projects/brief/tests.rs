//! The brief's shape, its message, its export and `brief_prepare`, without
//! a process. The build itself runs against a fake CLI in
//! `fake_cli_tests.rs`.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use serde_json::{Value, json};

use super::{
    input::{BUDGET_CHARS, compose, compose_within},
    run::{AgentLookup, BriefHost, prepare},
    *,
};
use crate::{
    agent::claude_cli::Agent,
    events::{DataChanged, EventSink, testing::RecordingSink},
    projects::{
        brief_inputs::{self, BriefInputs, BriefPerson},
        builds::BriefBuilds,
    },
    storage::{
        Storage, new_id, people,
        projects::{self, BriefState, Project, ProjectCreate, ProjectUpdate},
        sources::{self, NewSource, ReadySource, SourceStatus},
    },
};

pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// A brief as the agent gives it.
pub fn reply() -> Value {
    json!({
        "product": "Единая система приёма звонков для сети клиник «Медэлемент»",
        "stack": ["amoCRM API v4", "Mango Office"],
        "modules": [{ "name": "Очередь", "description": "Распределяет звонки по операторам" }],
        "glossary": [
            { "term": "Медэлемент", "definition": "Сеть клиник, клиент" },
            { "term": "Первичка", "definition": "Пациент без карты" }
        ],
        "keyDocuments": [{ "sourceId": "F1", "title": "ТЗ", "why": "Требования к очереди" }]
    })
}

/* Schema and serde */

fn validator() -> jsonschema::Validator {
    jsonschema::validator_for(&serde_json::from_str::<Value>(BRIEF_SCHEMA).unwrap()).unwrap()
}

#[test]
fn the_schema_argument_is_one_short_line_of_the_same_schema() {
    let argument = schema_argument();
    assert!(argument.len() < 4 * 1024, "{} bytes", argument.len());
    assert!(!argument.contains('\n'));
    assert!(!argument.contains("  "));
    assert_eq!(
        serde_json::from_str::<Value>(argument).unwrap(),
        serde_json::from_str::<Value>(BRIEF_SCHEMA).unwrap()
    );
}

#[test]
fn schema_and_serde_agree() {
    let schema = validator();
    let with = |patch: &dyn Fn(&mut Value)| {
        let mut value = reply();
        patch(&mut value);
        value
    };
    let valid = [
        reply(),
        json!({ "product": "", "stack": [], "modules": [], "glossary": [], "keyDocuments": [] }),
    ];
    let invalid = [
        with(&|value| {
            value.as_object_mut().unwrap().remove("glossary");
        }),
        with(&|value| value["extra"] = json!(1)),
        with(&|value| value["stack"] = json!("amoCRM")),
        with(&|value| value["product"] = json!(["a"])),
        with(&|value| value["glossary"][0] = json!({ "term": "x" })),
        with(&|value| value["glossary"][0]["note"] = json!("x")),
        with(&|value| value["modules"][0] = json!({ "name": "x", "description": 1 })),
        with(&|value| value["keyDocuments"][0] = json!({ "sourceId": "F1", "title": "x" })),
        json!(null),
        json!([]),
    ];
    for example in valid {
        assert!(schema.is_valid(&example), "schema on {example}");
        let brief = Brief::from_reply(example.clone()).unwrap();
        let written = serde_json::to_value(&brief).unwrap();
        assert!(schema.is_valid(&written), "written {written}");
    }
    for example in invalid {
        assert!(!schema.is_valid(&example), "schema on {example}");
        assert!(
            Brief::from_reply(example.clone()).is_err(),
            "serde on {example}"
        );
    }
    // Only the schema holds the agent to `F…` ids; the build drops the rest.
    let foreign = with(&|value| value["keyDocuments"][0]["sourceId"] = json!("doc-1"));
    assert!(!schema.is_valid(&foreign));
    let mut brief = Brief::from_reply(foreign).unwrap();
    brief.resolve_documents(&HashMap::from([("F1".to_owned(), "id-1".to_owned())]));
    assert!(brief.key_documents.is_empty());
}

#[test]
fn a_reply_is_trimmed_and_its_documents_get_real_ids() {
    let mut value = reply();
    value["stack"] = json!([" amoCRM ", " "]);
    value["glossary"][1]["term"] = json!("  ");
    value["keyDocuments"] = json!([
        { "sourceId": "F2", "title": "Договор", "why": "Сроки" },
        { "sourceId": "F7", "title": "Выдуман", "why": "—" },
        { "sourceId": "F1", "title": "ТЗ", "why": "Очередь" },
        { "sourceId": "F2", "title": "Дубль", "why": "—" }
    ]);
    let mut brief = Brief::from_reply(value).unwrap();
    assert_eq!(brief.stack, ["amoCRM"]);
    assert_eq!(brief.glossary.len(), 1);
    let ids = HashMap::from([
        ("F1".to_owned(), "id-1".to_owned()),
        ("F2".to_owned(), "id-2".to_owned()),
    ]);
    brief.resolve_documents(&ids);
    let named: Vec<(&str, &str)> = brief
        .key_documents
        .iter()
        .map(|document| (document.source_id.as_str(), document.title.as_str()))
        .collect();
    assert_eq!(named, [("id-2", "Договор"), ("id-1", "ТЗ")]);
    // Saving keeps only the project's ready documents.
    brief.keep_documents(&["id-1".to_owned()]);
    assert_eq!(brief.key_documents.len(), 1);
    assert_eq!(brief.key_documents[0].source_id, "id-1");
}

/* Who reads the brief: recognition and the fast loop */

fn saved_brief() -> Value {
    let mut brief = Brief::from_reply(reply()).unwrap();
    brief.key_documents[0].source_id = new_id();
    serde_json::to_value(brief).unwrap()
}

#[test]
fn the_glossary_and_the_fast_loop_read_a_built_brief() {
    use crate::{
        agent::fast_loop::{
            assembly::{brief_items, build_prefix},
            testing::{database, recording},
        },
        speech::{context, glossary::Glossary},
    };
    let brief = saved_brief();
    let glossary = Glossary::build(Some("Телемедиа"), &[], &[], Some(&brief));
    assert_eq!(
        glossary.full(),
        "Телемедиа, Медэлемент, Первичка, amoCRM API v4, Mango Office"
    );
    let items = brief_items(&brief);
    assert!(items.contains(&"Медэлемент — Сеть клиник, клиент".to_owned()));
    assert!(items.contains(&"Очередь — Распределяет звонки по операторам".to_owned()));
    assert!(
        !items
            .iter()
            .any(|item| item.contains("Требования к очереди")),
        "key documents only point at sources: {items:?}"
    );

    // Spec «Термин из брифа»: saved by the build, in the stable prefix and
    // in the recording's glossary.
    let db = database();
    let recording_id = recording(&db);
    let project_id = crate::storage::recordings::get(&db, &recording_id)
        .unwrap()
        .project_id
        .unwrap();
    let inputs = brief_inputs::read(&db, &project_id).unwrap();
    projects::save_brief(&db, &project_id, &brief, &inputs.fingerprint, false).unwrap();
    let terms = context::load(&db, &recording_id).unwrap().glossary;
    assert!(
        terms.terms().contains(&"Медэлемент".to_owned()),
        "{terms:?}"
    );
    let prefix = build_prefix(&db, &recording_id).unwrap();
    assert!(prefix.text.contains("Медэлемент"), "{}", prefix.text);
}

/* The message */

fn source(id: &str, name: &str, text: String) -> ReadySource {
    ReadySource {
        id: id.to_owned(),
        name: name.to_owned(),
        extension: "md".to_owned(),
        sha256: "0".repeat(64),
        text,
        truncated: false,
    }
}

fn inputs(sources: Vec<ReadySource>) -> BriefInputs {
    BriefInputs {
        project_id: "p".to_owned(),
        project_name: "Телемедиа".to_owned(),
        description: "Приём звонков".to_owned(),
        notes: "Клиент просит без IVR".to_owned(),
        people: vec![BriefPerson {
            id: "a".to_owned(),
            name: "Ольга Демченко".to_owned(),
            role: "CEO".to_owned(),
            profile: json!({ "portrait": "Решает быстро", "tech": 1, "initials": "ОД" }),
        }],
        sources,
        fingerprint: "f".repeat(64),
    }
}

#[test]
fn the_message_has_the_materials_and_numbers_the_documents() {
    let message = compose(&inputs(vec![
        source("id-1", "ТЗ.docx", "Очередь звонков".to_owned()),
        source("id-2", "Договор.pdf", "Сроки: март".to_owned()),
    ]));
    for part in [
        "Название: Телемедиа",
        "## Описание\n\nПриём звонков",
        "## Заметки менеджера\n\nКлиент просит без IVR",
        "- Ольга Демченко — CEO. Портрет: Решает быстро. Технический уровень (1–5): 1.",
        "### F1. ТЗ.docx\n\nОчередь звонков",
        "### F2. Договор.pdf\n\nСроки: март",
        "StructuredOutput",
    ] {
        assert!(
            message.text.contains(part),
            "no «{part}» in\n{}",
            message.text
        );
    }
    assert!(!message.text.contains("ОД"));
    assert!(!message.text.contains("сокращен"));
    assert!(!message.truncated);
    assert_eq!(message.documents["F1"], "id-1");
    assert_eq!(message.documents["F2"], "id-2");

    let empty = compose(&BriefInputs {
        people: Vec::new(),
        ..inputs(Vec::new())
    });
    assert!(empty.text.contains("Документов нет."));
    assert!(empty.text.contains("Неизвестны."));
}

#[test]
fn materials_over_the_budget_are_shortened_in_proportion_keeping_heads() {
    // Twice the budget: one document three times the other.
    let big = format!("НАЧАЛО-1 {}", "а".repeat(BUDGET_CHARS * 3 / 2));
    let small = format!("НАЧАЛО-2 {}", "б".repeat(BUDGET_CHARS / 2));
    let message = compose(&inputs(vec![
        source("id-1", "Переписка.txt", big),
        source("id-2", "ТЗ.md", small),
    ]));
    assert!(message.truncated);
    let length = message.text.chars().count();
    assert!(length <= BUDGET_CHARS, "{length}");
    assert!(length > BUDGET_CHARS - 1_000, "{length}");
    assert!(message.text.contains("Материалы сокращены"));
    assert!(
        message
            .text
            .contains("### F1. Переписка.txt (сокращён)\n\nНАЧАЛО-1")
    );
    assert!(
        message
            .text
            .contains("### F2. ТЗ.md (сокращён)\n\nНАЧАЛО-2")
    );
    let kept = |letter: char| message.text.chars().filter(|char| *char == letter).count();
    let ratio = kept('а') as f64 / kept('б') as f64;
    assert!((ratio - 3.0).abs() < 0.01, "{ratio}");

    // Within the budget nothing is cut; a document cut when it was read
    // still marks the brief.
    let mut cut_on_read = source("id-1", "ТЗ.md", "текст".to_owned());
    cut_on_read.truncated = true;
    let message = compose_within(&inputs(vec![cut_on_read]), BUDGET_CHARS);
    assert!(message.truncated);
    assert!(message.text.contains("### F1. ТЗ.md (сокращён)\n\nтекст"));
    assert!(!message.text.contains("Материалы сокращены"));
}

/* Export */

#[test]
fn the_file_name_drops_what_windows_and_macos_forbid() {
    assert_eq!(export::file_name("Телемедиа"), "Телемедиа — бриф.md");
    assert_eq!(
        export::file_name("A/B: \"C\" <D>|E?*\\F\u{7}. "),
        "AB C DEF — бриф.md"
    );
    assert_eq!(export::file_name(" ..?? "), "Проект — бриф.md");
}

#[test]
fn the_markdown_has_the_sections_of_the_page() {
    let brief = saved_brief();
    let id = brief["keyDocuments"][0]["sourceId"]
        .as_str()
        .unwrap()
        .to_owned();
    let markdown = export::markdown("Телемедиа", &brief, &[(id, "ТЗ.docx".to_owned())]);
    assert_eq!(
        markdown,
        "# Телемедиа — бриф\n\
         \n## Продукт\n\nЕдиная система приёма звонков для сети клиник «Медэлемент»\n\
         \n## Стек\n\n- amoCRM API v4\n- Mango Office\n\
         \n## Модули\n\n- **Очередь** — Распределяет звонки по операторам\n\
         \n## Глоссарий\n\n- **Медэлемент** — Сеть клиник, клиент\n- **Первичка** — Пациент без карты\n\
         \n## Ключевые документы\n\n- **ТЗ.docx** — ТЗ. Требования к очереди\n"
    );
    // A loose brief (not built by the agent) still exports.
    let loose = export::markdown("X", &json!({ "product": "Звонки" }), &[]);
    assert!(loose.contains("## Продукт\n\nЗвонки\n"));
    assert!(loose.contains("## Ключевые документы\n\n—\n"));
}

/* A host without the app */

/// Storage in a temp folder, the events it was sent, and an agent that is
/// ready (`Some`) or not.
pub struct TestHost {
    pub data: tempfile::TempDir,
    storage: Storage,
    pub sink: RecordingSink,
    pub progress: Mutex<Vec<BriefProgress>>,
    pub agent: Mutex<Option<Arc<dyn Agent>>>,
    pub lookups: AtomicUsize,
}

impl TestHost {
    pub fn new(agent: Option<Arc<dyn Agent>>) -> Arc<Self> {
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(data.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        Arc::new(Self {
            data,
            storage,
            sink: RecordingSink::default(),
            progress: Mutex::new(Vec::new()),
            agent: Mutex::new(agent),
            lookups: AtomicUsize::new(0),
        })
    }

    pub fn storage(&self) -> &Storage {
        &self.storage
    }

    pub fn progress(&self) -> Vec<BriefProgress> {
        self.progress.lock().unwrap().clone()
    }

    /// A project with a description, a person and a ready document.
    pub fn project(&self) -> Project {
        let project = block_on(self.storage.write(&self.sink, |db| {
            projects::create(
                db,
                ProjectCreate {
                    name: "Телемедиа".to_owned(),
                    description: Some("Единая система приёма звонков".to_owned()),
                    ..ProjectCreate::default()
                },
            )
        }))
        .unwrap();
        let id = project.id.clone();
        block_on(self.storage.write(&self.sink, move |db| {
            people::create(
                db,
                people::PersonCreate {
                    project_id: id.clone(),
                    name: "Ольга Демченко".to_owned(),
                    role: Some("CEO".to_owned()),
                    profile: None,
                },
            )?;
            let text = "Очередь звонков, перезвон через 5 минут".to_owned();
            sources::insert(
                db,
                &NewSource {
                    id: new_id(),
                    project_id: id.clone(),
                    name: "ТЗ.md".to_owned(),
                    extension: "md".to_owned(),
                    size: 64,
                    sha256: "1".repeat(64),
                    stored_path: format!("projects/{id}/sources/x.md"),
                    status: SourceStatus::Ready,
                    text_chars: 40,
                    text,
                    truncated: false,
                    error: None,
                },
            )
        }))
        .unwrap();
        self.get(&project.id)
    }

    pub fn get(&self, project_id: &str) -> Project {
        let id = project_id.to_owned();
        block_on(self.storage.read(move |db| projects::get(db, &id))).unwrap()
    }

    pub fn source_ids(&self, project_id: &str) -> Vec<String> {
        let id = project_id.to_owned();
        block_on(self.storage.read(move |db| sources::list(db, &id)))
            .unwrap()
            .into_iter()
            .map(|source| source.id)
            .collect()
    }

    /// Saves `brief` as a build would: fresh.
    pub fn save(&self, project_id: &str, brief: &Value) {
        let (id, brief) = (project_id.to_owned(), brief.clone());
        block_on(self.storage.write(&self.sink, move |db| {
            let inputs = brief_inputs::read(db, &id)?;
            projects::save_brief(db, &id, &brief, &inputs.fingerprint, false)
        }))
        .unwrap();
    }

    pub fn update(&self, project_id: &str, patch: ProjectUpdate) {
        let id = project_id.to_owned();
        block_on(
            self.storage
                .write(&self.sink, move |db| projects::update(db, &id, patch)),
        )
        .unwrap();
    }
}

impl EventSink for TestHost {
    fn data_changed(&self, event: DataChanged) {
        self.sink.data_changed(event);
    }
}

impl BriefHost for TestHost {
    fn storage(&self) -> Option<&Storage> {
        Some(&self.storage)
    }

    fn progress(&self, progress: BriefProgress) {
        self.progress.lock().unwrap().push(progress);
    }

    fn agent(&self) -> AgentLookup<'_> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let agent = self.agent.lock().unwrap().clone();
        Box::pin(async move { agent.ok_or_else(|| "Нужен вход в Claude Code".to_owned()) })
    }

    fn prompt_dir(&self) -> std::path::PathBuf {
        self.data.path().join("agent/briefs")
    }
}

/* brief_prepare without an agent call */

#[test]
fn prepare_is_a_no_op_for_a_fresh_brief_and_without_a_ready_agent() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();

    // Not ready: `none` with materials, then `outdated`; nothing starts and
    // nothing is sent.
    assert_eq!(project.brief_state, BriefState::None);
    assert!(!block_on(prepare(&host, &builds, &project.id)).unwrap());
    host.save(&project.id, &saved_brief());
    host.update(
        &project.id,
        ProjectUpdate {
            notes: Some("Новая заметка".to_owned()),
            ..ProjectUpdate::default()
        },
    );
    assert_eq!(host.get(&project.id).brief_state, BriefState::Outdated);
    let events = host.sink.events().len();
    assert!(!block_on(prepare(&host, &builds, &project.id)).unwrap());
    assert_eq!(
        host.lookups.load(Ordering::SeqCst),
        2,
        "the agent was asked"
    );
    assert!(host.progress().is_empty());
    assert_eq!(host.sink.events().len(), events);
    assert!(!builds.is_building(&project.id));

    // Fresh: the agent is not even asked.
    host.save(&project.id, &saved_brief());
    assert_eq!(host.get(&project.id).brief_state, BriefState::Fresh);
    assert!(!block_on(prepare(&host, &builds, &project.id)).unwrap());
    assert_eq!(host.lookups.load(Ordering::SeqCst), 2);

    // `none` without materials: nothing to build from.
    let empty = block_on(host.storage().write(&host.sink, |db| {
        projects::create(
            db,
            ProjectCreate {
                name: "Пустой".to_owned(),
                ..ProjectCreate::default()
            },
        )
    }))
    .unwrap();
    assert!(!block_on(prepare(&host, &builds, &empty.id)).unwrap());
    assert_eq!(host.lookups.load(Ordering::SeqCst), 2);

    // Unknown project.
    assert!(block_on(prepare(&host, &builds, "nope")).is_err());
}

#[test]
fn prepare_is_a_no_op_while_a_build_runs() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let _running = builds.start(&project.id).unwrap();
    assert!(!block_on(prepare(&host, &builds, &project.id)).unwrap());
    assert_eq!(host.lookups.load(Ordering::SeqCst), 0);
    assert!(host.progress().is_empty());
}

#[test]
fn export_writes_the_brief_into_the_folder() {
    let host = TestHost::new(None);
    let project = host.project();
    let folder = tempfile::tempdir().unwrap();
    let folder_text = folder.path().to_string_lossy().into_owned();

    let error = block_on(export::export(host.storage(), &project.id, &folder_text)).unwrap_err();
    assert!(matches!(error, crate::error::CommandError::Invalid { .. }));

    let mut brief = saved_brief();
    let source = host.source_ids(&project.id).remove(0);
    brief["keyDocuments"][0]["sourceId"] = json!(source);
    host.save(&project.id, &brief);
    let path = block_on(export::export(host.storage(), &project.id, &folder_text)).unwrap();
    assert_eq!(
        std::path::Path::new(&path),
        folder.path().join("Телемедиа — бриф.md")
    );
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(written.starts_with("# Телемедиа — бриф\n"));
    assert!(written.contains("- **ТЗ.md** — ТЗ. Требования к очереди"));

    let missing = folder.path().join("нет");
    let error = block_on(export::export(
        host.storage(),
        &project.id,
        &missing.to_string_lossy(),
    ))
    .unwrap_err();
    assert!(matches!(error, crate::error::CommandError::Invalid { .. }));
    let error = block_on(export::export(host.storage(), "nope", &folder_text)).unwrap_err();
    assert!(matches!(error, crate::error::CommandError::NotFound { .. }));
}
