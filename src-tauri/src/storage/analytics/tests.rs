//! The queue on a database where it is on, without a network
//! (call-analytics task 4.1).

use rusqlite::Connection;
use serde_json::Value;

use super::enable_on;
use crate::{
    agent::fast_loop::testing::{database, recording, say},
    storage::{
        call_state::{
            self, AgentCallInput, AgentCallOutcome, CardLens, Evidence, EvidenceSource, GapType,
            NewQuestion, ValidatedOp, ValidatedPatch,
        },
        journal::PromptPart,
        projects::{self, ProjectCreate, ProjectUpdate},
        transcript::TranscriptChannel,
    },
};

/// The queued events: their kind and body.
fn queued(connection: &Connection) -> Vec<(String, Value)> {
    connection
        .prepare("SELECT kind, body FROM analytics_outbox ORDER BY seq")
        .unwrap()
        .query_map([], |row| {
            let body: String = row.get(1)?;
            Ok((row.get(0)?, serde_json::from_str::<Value>(&body).unwrap()))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn kinds(connection: &Connection) -> Vec<String> {
    queued(connection)
        .into_iter()
        .map(|(kind, _)| kind)
        .collect()
}

fn on() -> Connection {
    let connection = database();
    enable_on(&connection).unwrap();
    connection
}

fn question(text: &str, evidence: Vec<Evidence>) -> ValidatedOp {
    ValidatedOp::AddQuestion(NewQuestion {
        text: text.to_owned(),
        description: String::new(),
        card_field: CardLens::Goal,
        gap_type: GapType::Empty,
        priority: 2,
        evidence,
    })
}

/// Spec «Debug-сборка», the tests: with the queue off nothing is queued.
#[test]
fn nothing_is_queued_while_off() {
    let connection = database();
    let id = recording(&connection);
    say(
        &connection,
        &id,
        TranscriptChannel::Others,
        0,
        "Двести звонков в день",
    );
    assert!(kinds(&connection).is_empty());
}

/// A recording's entities are queued as they are written, each a snapshot
/// in the envelope.
#[test]
fn a_call_is_queued_as_it_goes() {
    let connection = on();
    let id = recording(&connection);
    let segment = say(
        &connection,
        &id,
        TranscriptChannel::Others,
        0,
        "Двести звонков в день",
    );
    call_state::apply_patch(
        &connection,
        &id,
        &ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Очередь".to_owned(),
                },
                question(
                    "Кто отвечает ночью?",
                    vec![Evidence {
                        source: EvidenceSource::Segment,
                        id: segment.id.clone(),
                        quote: "двести звонков".to_owned(),
                    }],
                ),
            ],
        },
    )
    .unwrap();
    let queued = queued(&connection);
    let kinds: Vec<&str> = queued.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "project",
            "recording",
            "segment",
            "topic",
            "card",
            "questionEvent",
            "question",
            "questionEvent",
            "question"
        ]
    );
    let (_, segment_event) = &queued[2];
    assert_eq!(segment_event["v"], 1);
    assert_eq!(segment_event["body"]["id"], Value::from(segment.id));
    assert_eq!(queued[5].1["body"]["step"], "created");
    assert_eq!(queued[7].1["body"]["step"], "shown");
    assert!(queued[8].1["body"]["shownAt"].is_number());
}

/// Spec «Откат изменения»: a write that rolled back queues nothing.
#[test]
fn a_rolled_back_question_is_not_queued() {
    let connection = on();
    let id = recording(&connection);
    let before = kinds(&connection).len();
    let failed = call_state::apply_patch(
        &connection,
        &id,
        &ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Очередь".to_owned(),
                },
                question("Кто отвечает ночью?", Vec::new()),
                // An unknown question: the whole patch rolls back.
                ValidatedOp::MarkAnswered {
                    question_id: "nope".to_owned(),
                    evidence: Vec::new(),
                },
            ],
        },
    );
    assert!(failed.is_err());
    assert_eq!(kinds(&connection).len(), before);
}

/// Spec «Повтор брифа»: a part 50 calls share goes once; each call refers
/// to it by its hash.
#[test]
fn a_shared_part_is_queued_once() {
    let mut connection = on();
    let id = recording(&connection);
    for n in 0..50 {
        let tx = connection.transaction().unwrap();
        call_state::insert_agent_call_at(
            &tx,
            &AgentCallInput {
                recording_id: id.clone(),
                outcome: Some(AgentCallOutcome::Ok),
                prompt: vec![
                    PromptPart::new("file", "# Бриф проекта: обменник, KYC для юрлиц"),
                    PromptPart::new("transcript", format!("Клиент: фраза {n}")),
                ],
                ..AgentCallInput::default()
            },
            1_000 + n,
        )
        .unwrap();
        tx.commit().unwrap();
    }
    let queued = queued(&connection);
    let parts: Vec<&Value> = queued
        .iter()
        .filter(|(kind, _)| kind == "promptPart")
        .map(|(_, event)| &event["body"])
        .collect();
    let briefs = parts
        .iter()
        .filter(|part| part["text"].as_str().unwrap().starts_with("# Бриф"))
        .count();
    assert_eq!(briefs, 1);
    assert_eq!(parts.len(), 51);
    let calls: Vec<&Value> = queued
        .iter()
        .filter(|(kind, _)| kind == "agentCall")
        .map(|(_, event)| &event["body"])
        .collect();
    assert_eq!(calls.len(), 50);
    let brief_hash = &parts[0]["hash"];
    assert!(
        calls
            .iter()
            .all(|call| &call["parts"][0]["hash"] == brief_hash)
    );
}

/// Spec «Первая версия с аналитикой»: a recording from before the update is
/// not sent; one after it is; the projects always are.
#[test]
fn only_what_came_after_the_update_is_sent() {
    let connection = on();
    connection
        .execute("UPDATE analytics_meta SET enabled_since = 9e15", [])
        .unwrap();
    let old = recording(&connection);
    say(
        &connection,
        &old,
        TranscriptChannel::Others,
        0,
        "Старый звонок",
    );
    assert_eq!(kinds(&connection), ["project"], "the project goes anyway");
    connection
        .execute("UPDATE analytics_meta SET enabled_since = 0", [])
        .unwrap();
    let new = recording(&connection);
    say(
        &connection,
        &new,
        TranscriptChannel::Others,
        0,
        "Новый звонок",
    );
    let segments: Vec<Value> = queued(&connection)
        .into_iter()
        .filter(|(kind, _)| kind == "segment")
        .map(|(_, event)| event["body"]["recordingId"].clone())
        .collect();
    assert_eq!(segments, [Value::from(new)]);
}

/// Spec «Проект старше аналитики»: a project made while the queue was off
/// is sent when it turns on, so its new calls land in it and not in «Без
/// проекта».
#[test]
fn a_project_from_before_is_sent_when_the_queue_turns_on() {
    let connection = database();
    let (project, _) = projects::create(
        &connection,
        ProjectCreate {
            name: "Обменник".to_owned(),
            ..ProjectCreate::default()
        },
    )
    .unwrap();
    assert!(kinds(&connection).is_empty());
    enable_on(&connection).unwrap();
    let queued = queued(&connection);
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0].0, "project");
    assert_eq!(queued[0].1["body"]["localId"], Value::from(project.id));
    assert_eq!(queued[0].1["body"]["name"], "Обменник");
}

/// A rename sends the project again; another change of it does not.
#[test]
fn a_rename_sends_the_project() {
    let connection = on();
    let (project, _) = projects::create(
        &connection,
        ProjectCreate {
            name: "Обменник".to_owned(),
            ..ProjectCreate::default()
        },
    )
    .unwrap();
    projects::update(
        &connection,
        &project.id,
        ProjectUpdate {
            notes: Some("Заметка".to_owned()),
            ..ProjectUpdate::default()
        },
    )
    .unwrap();
    projects::update(
        &connection,
        &project.id,
        ProjectUpdate {
            name: Some("Обменник 2".to_owned()),
            ..ProjectUpdate::default()
        },
    )
    .unwrap();
    let names: Vec<Value> = queued(&connection)
        .into_iter()
        .map(|(_, event)| event["body"]["name"].clone())
        .collect();
    assert_eq!(names, ["Обменник", "Обменник 2"]);
}

/// Spec «Аудио»: not a byte of the audio, nor its files, in any event.
#[test]
fn no_event_carries_the_audio() {
    let connection = on();
    let id = recording(&connection);
    say(
        &connection,
        &id,
        TranscriptChannel::Others,
        0,
        "Двести звонков в день",
    );
    for (_, event) in queued(&connection) {
        let text = event.to_string();
        for audio in [".opus", "me_file", "others_file", "meFile", "othersFile"] {
            assert!(!text.contains(audio), "{audio} in {text}");
        }
    }
}
