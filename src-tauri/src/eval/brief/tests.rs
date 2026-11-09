//! `grill-eval brief` against a fake `claude`: the app's brief call, from
//! the corpus's materials.

use serde_json::json;

use super::*;
use crate::{
    eval::{
        corpus::{Person, SourceText},
        testing::{block_on, corpus, fake::Fake},
    },
    projects::brief::PROMPT,
};

fn reply() -> Value {
    json!({
        "product": "Единая очередь звонков для сети клиник",
        "stack": ["Mango Office"],
        "modules": [],
        "glossary": [{ "term": "Первичка", "definition": "Пациент без карты" }],
        "keyDocuments": [{ "sourceId": "F1", "title": "Схема телефонии", "why": "Очереди" }],
        "gaps": [
            { "lens": "users", "text": "Не сказано, кто принимает звонки ночью" },
            { "lens": "acceptance", "text": "Нет критериев, когда очередь готова" },
        ],
    })
}

#[test]
fn the_brief_is_rebuilt_from_the_corpus_and_the_old_one_kept() {
    let mut corpus = corpus(Vec::new());
    let old = corpus.project.as_ref().unwrap().brief.clone();
    {
        let project = corpus.project.as_mut().unwrap();
        project.notes = "Клиент торопится к лету".to_owned();
        project.sources = vec![SourceText {
            name: "telephony.md".to_owned(),
            text: "Звонки идут через Mango Office в три очереди".to_owned(),
        }];
    }
    corpus.people = vec![Person {
        id: "olga".to_owned(),
        name: "Ольга Демченко".to_owned(),
        role: "CEO".to_owned(),
        profile: json!({ "tech": 1 }),
    }];
    let fake = Fake::new(&[reply()]);
    let dir = tempfile::tempdir().unwrap();
    let usage = block_on(run(&mut corpus, fake.agent(), dir.path())).unwrap();

    assert_eq!(fake.runs(), 1);
    assert_eq!(usage.cost_usd, Some(0.12));
    let project = corpus.project.as_ref().unwrap();
    assert_eq!(project.brief_previous, old);
    let brief = project.brief.as_ref().unwrap();
    assert_eq!(brief["gaps"][0]["lens"], "users");
    assert_eq!(brief["gaps"].as_array().unwrap().len(), 2);
    // A key document points at the document's name.
    assert_eq!(brief["keyDocuments"][0]["sourceId"], "telephony.md");

    let stdin = fake.read("stdin-1");
    for part in [
        "Название: Телемедиа",
        "Единая система приёма звонков для сети клиник",
        "Клиент торопится к лету",
        "Ольга Демченко",
        "name=\"telephony.md\"",
        "Звонки идут через Mango Office в три очереди",
    ] {
        assert!(stdin.contains(part), "no «{part}» in\n{stdin}");
    }
    let args = fake.read("args-1");
    for arg in ["claude-sonnet-5-5", "medium", "\"gaps\""] {
        assert!(args.contains(arg), "no {arg} in {args:?}");
    }
    // The rules are the app's prompt, and their file is gone.
    assert!(PROMPT.contains("gaps"));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn a_corpus_without_materials_is_an_error_without_a_call() {
    let fake = Fake::new(&[reply()]);
    let dir = tempfile::tempdir().unwrap();

    let mut without_project = corpus(Vec::new());
    without_project.project = None;
    let error = block_on(run(&mut without_project, fake.agent(), dir.path())).unwrap_err();
    assert!(error.contains("нет проекта"), "{error}");

    let mut empty = corpus(Vec::new());
    let project = empty.project.as_mut().unwrap();
    project.description = "  ".to_owned();
    let error = block_on(run(&mut empty, fake.agent(), dir.path())).unwrap_err();
    assert!(error.contains("Не из чего собирать бриф"), "{error}");
    assert_eq!(fake.runs(), 0);
}

#[test]
fn a_reply_not_by_the_brief_schema_keeps_the_corpus() {
    let mut corpus = corpus(Vec::new());
    let before = corpus.clone();
    let fake = Fake::new(&[json!({ "product": "x" })]);
    let dir = tempfile::tempdir().unwrap();
    let error = block_on(run(&mut corpus, fake.agent(), dir.path())).unwrap_err();
    assert!(error.contains("не по схеме брифа"), "{error}");
    assert_eq!(corpus, before);
}
