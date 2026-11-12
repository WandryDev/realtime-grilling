use rusqlite_migration::Migrations;
use serde_json::json;

use super::*;
use crate::{
    agent::fast_loop::testing::{add_source, database, recording},
    storage::{
        DATABASE_FILE, MIGRATION_LIST, MIGRATIONS, SCHEMA_VERSION,
        call_state::{
            self, AgentCallInput, AgentCallKind, AgentCallOutcome, CardLens, Evidence,
            EvidenceSource, GapType, NewQuestion, ValidatedOp, ValidatedPatch,
        },
        open, recordings,
    },
};

fn finding(chunk: &str, quote: &str) -> NewFinding {
    NewFinding {
        source_id: None,
        source_kind: FindingSourceKind::Outline,
        source_name: "Регламент смены".to_owned(),
        source_url: Some("https://outline.example/doc/1".to_owned()),
        chunk_key: chunk.to_owned(),
        quote: quote.to_owned(),
        note: "Подтверждает: смена из трёх операторов".to_owned(),
        question_id: None,
        agent_call_id: None,
    }
}

fn added(inserted: Inserted) -> String {
    match inserted {
        Inserted::Added { id, .. } => id,
        Inserted::NoRoom => panic!("no room"),
    }
}

fn count(connection: &Connection, sql: &str) -> i64 {
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// v9 → v10 (task 1.1): the journal and the questions stay, `slowLoop`
/// is a kind of call, the foreign keys hold.
#[test]
fn migration_0010_keeps_the_journal_and_the_questions_of_version_9() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATABASE_FILE);
    let seed = "INSERT INTO recordings
           (id, status, started_at, me_file, others_file, created_at, updated_at)
         VALUES ('rec', 'finished', 5, 'a', 'b', 5, 5);
         INSERT INTO questions (id, recording_id, text, evidence, created_at, updated_at)
         VALUES ('q1', 'rec', 'Сколько операторов?', '[]', 6, 6);
         INSERT INTO agent_calls
           (id, recording_id, started_at, duration_ms, outcome, input_tokens, output_tokens,
            cache_read, cache_write, cost_usd, utilization, rejected, error, created_at, kind)
         VALUES ('c1', 'rec', 10, 900, 'ok', 2, 300, 5400, 0, 0.04, 0.5,
                 '[{\"reason\":\"quoteNotFound\"}]', NULL, 11, 'fastLoop'),
                ('c2', 'rec', 20, 400, 'empty', NULL, NULL, NULL, NULL, NULL, NULL,
                 '[]', 'x', 21, 'topicCheck');";
    let rows = |connection: &Connection| -> Vec<Vec<String>> {
        let mut statement = connection
            .prepare(
                "SELECT id, recording_id, started_at, duration_ms, outcome, input_tokens,
                        output_tokens, cache_read, cache_write, cost_usd, utilization, rejected,
                        error, created_at, kind
                   FROM agent_calls ORDER BY id",
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
    let before = {
        let connection = open(&path, &Migrations::from_slice(&MIGRATION_LIST[..9])).unwrap();
        connection.execute_batch(seed).unwrap();
        // A v9 database refuses the new kind.
        assert!(
            connection
                .execute(
                    "UPDATE agent_calls SET kind = 'slowLoop' WHERE id = 'c2'",
                    []
                )
                .is_err()
        );
        rows(&connection)
    };

    let connection = open(&path, &MIGRATIONS).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION as i64);
    assert_eq!(rows(&connection), before);
    assert_eq!(count(&connection, "SELECT count(*) FROM questions"), 1);
    assert_eq!(
        count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM sqlite_master WHERE name = 'agent_calls_recording'"
        ),
        1
    );

    let calls = call_state::agent_calls(&connection, "rec").unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].kind, AgentCallKind::TopicCheck);
    call_state::insert_agent_call(
        &connection,
        &AgentCallInput {
            recording_id: "rec".to_owned(),
            kind: AgentCallKind::SlowLoop,
            outcome: Some(AgentCallOutcome::Empty),
            ..AgentCallInput::default()
        },
    )
    .unwrap();
    assert_eq!(
        call_state::agent_calls(&connection, "rec").unwrap()[0].kind,
        AgentCallKind::SlowLoop
    );
    assert!(
        connection
            .execute("UPDATE agent_calls SET kind = 'other'", [])
            .is_err()
    );
    // A recording's delete still takes its journal along.
    recordings::delete(&connection, "rec").unwrap();
    assert_eq!(count(&connection, "SELECT count(*) FROM agent_calls"), 0);
}

/// Deleting the recording deletes its findings; deleting the source leaves
/// the finding's snapshot without `source_id`.
#[test]
fn findings_go_with_the_recording_and_outlive_their_source() {
    let db = database();
    let id = recording(&db);
    let source = add_source(&db, &id, None, "ТЗ.docx", "Текст", true);
    let new = NewFinding {
        source_id: Some(source.clone()),
        source_kind: FindingSourceKind::File,
        source_name: "ТЗ.docx".to_owned(),
        source_url: None,
        ..finding(&format!("{source}#0"), "в смене три оператора")
    };
    let finding_id = added(insert_at(&db, &id, &new, 100).unwrap());

    db.execute("DELETE FROM project_sources WHERE id = ?1", [&source])
        .unwrap();
    let left: Option<String> = db
        .query_row(
            "SELECT source_id FROM context_findings WHERE id = ?1",
            [&finding_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(left, None);
    let shown = visible(&db, &id).unwrap();
    assert_eq!(
        shown,
        vec![ContextFinding {
            id: finding_id,
            source_kind: FindingSourceKind::File,
            source_name: "ТЗ.docx".to_owned(),
            source_url: None,
            quote: "в смене три оператора".to_owned(),
            note: "Подтверждает: смена из трёх операторов".to_owned(),
            question_id: None,
            created_at: 100,
        }]
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );

    recordings::delete(&db, &id).unwrap();
    assert_eq!(count(&db, "SELECT count(*) FROM context_findings"), 0);
}

/// Twelve visible at most: the thirteenth evicts the oldest one that no
/// question is about or cites; when there is none, it is not added.
#[test]
fn the_thirteenth_evicts_the_oldest_without_a_question() {
    let db = database();
    let id = recording(&db);
    let ids: Vec<String> = (0..MAX_VISIBLE)
        .map(|n| {
            let at = i64::try_from(n).unwrap() * 10;
            added(
                insert_at(
                    &db,
                    &id,
                    &finding(&format!("s#{n}"), &format!("цитата {n}")),
                    at,
                )
                .unwrap(),
            )
        })
        .collect();
    assert_eq!(visible(&db, &id).unwrap().len(), MAX_VISIBLE);

    // The oldest is about a question; the second is cited by one.
    call_state::apply_patch(
        &db,
        &id,
        &ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Смены".to_owned(),
                },
                ValidatedOp::AddQuestion(NewQuestion {
                    text: "Сколько операторов в смене?".to_owned(),
                    description: String::new(),
                    card_field: CardLens::Users,
                    gap_type: GapType::Empty,
                    priority: 2,
                    evidence: vec![Evidence {
                        source: EvidenceSource::Document,
                        id: ids[1].clone(),
                        quote: "цитата 1".to_owned(),
                    }],
                }),
            ],
        },
    )
    .unwrap();
    let question = call_state::get(&db, &id).unwrap().questions[0].id.clone();
    db.execute(
        "UPDATE context_findings SET question_id = ?2 WHERE id = ?1",
        [&ids[0], &question],
    )
    .unwrap();
    // A new question that cites a finding links it, so the second one is
    // about it now too; the link is not what keeps it here, the citation
    // is: drop the link.
    db.execute(
        "UPDATE context_findings SET question_id = NULL WHERE id = ?1",
        [&ids[1]],
    )
    .unwrap();

    let Inserted::Added {
        id: newest,
        evicted,
    } = insert_at(&db, &id, &finding("s#new", "новая цитата"), 1_000).unwrap()
    else {
        panic!("no room");
    };
    assert_eq!(evicted.as_deref(), Some(ids[2].as_str()));
    let shown = visible(&db, &id).unwrap();
    assert_eq!(shown.len(), MAX_VISIBLE);
    assert_eq!(shown[0].id, newest, "the newest first");
    assert!(shown.iter().all(|finding| finding.id != ids[2]));
    let evicted_at: Option<i64> = db
        .query_row(
            "SELECT evicted_at FROM context_findings WHERE id = ?1",
            [&ids[2]],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(evicted_at, Some(1_000));
    // The repeat check still knows it.
    assert_eq!(known(&db, &id).unwrap().len(), MAX_VISIBLE + 1);

    // Every visible one is about a question: no room.
    db.execute(
        "UPDATE context_findings SET question_id = ?2 WHERE recording_id = ?1",
        [&id, &question],
    )
    .unwrap();
    assert_eq!(
        insert_at(&db, &id, &finding("s#late", "поздняя цитата"), 2_000).unwrap(),
        Inserted::NoRoom
    );
    assert_eq!(visible(&db, &id).unwrap().len(), MAX_VISIBLE);
    assert_eq!(known(&db, &id).unwrap().len(), MAX_VISIBLE + 1);
}

#[test]
fn hidden_findings_are_not_visible_and_a_new_question_links_one() {
    let db = database();
    let id = recording(&db);
    let first = added(insert_at(&db, &id, &finding("a#0", "первая цитата тут"), 10).unwrap());
    let second = added(insert_at(&db, &id, &finding("a#1", "вторая цитата тут"), 20).unwrap());

    hide(&db, &id, &first, 30).unwrap();
    hide(&db, &id, &first, 40).unwrap();
    let hidden_at: Option<i64> = db
        .query_row(
            "SELECT hidden_at FROM context_findings WHERE id = ?1",
            [&first],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(hidden_at, Some(30), "hiding again changes nothing");
    let shown: Vec<String> = visible(&db, &id)
        .unwrap()
        .into_iter()
        .map(|f| f.id)
        .collect();
    assert_eq!(shown, [second.clone()]);
    assert!(matches!(
        hide(&db, &id, "missing", 50),
        Err(CommandError::NotFound { .. })
    ));
    let other = recording(&db);
    assert!(matches!(
        hide(&db, &other, &second, 50),
        Err(CommandError::NotFound { .. })
    ));

    link_question(&db, &id, &second, "q-missing").unwrap_err();
    call_state::apply_patch(
        &db,
        &id,
        &ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Смены".to_owned(),
                },
                ValidatedOp::AddQuestion(NewQuestion {
                    text: "Кто старший смены?".to_owned(),
                    description: String::new(),
                    card_field: CardLens::Users,
                    gap_type: GapType::Empty,
                    priority: 2,
                    evidence: vec![Evidence {
                        source: EvidenceSource::Document,
                        id: second.clone(),
                        quote: "вторая цитата тут".to_owned(),
                    }],
                }),
            ],
        },
    )
    .unwrap();
    let state = call_state::get(&db, &id).unwrap();
    let question = state.questions[0].id.clone();
    assert_eq!(
        state.findings[0].question_id.as_deref(),
        Some(question.as_str())
    );
    let json = serde_json::to_value(&state.findings[0]).unwrap();
    assert_eq!(json["questionId"], json!(question));
    assert_eq!(json["sourceKind"], json!("outline"));
    assert_eq!(json["createdAt"], json!(20));
}

#[test]
fn the_sources_are_counted_by_kind() {
    let db = database();
    let id = recording(&db);
    assert_eq!(source_counts(&db, &id).unwrap(), ContextSources::default());
    add_source(&db, &id, None, "ТЗ.docx", "т", true);
    add_source(&db, &id, None, "скан.pdf", "", false);
    add_source(&db, &id, Some("outline"), "Регламент", "т", true);
    add_source(&db, &id, Some("outline"), "Схема", "т", true);
    add_source(&db, &id, Some("clickup"), "Задача", "т", true);
    add_source(&db, &id, Some("github"), "README", "т", true);
    assert_eq!(
        source_counts(&db, &id).unwrap(),
        ContextSources {
            files: 1,
            outline: 2,
            clickup: 1
        }
    );
    assert_eq!(
        serde_json::to_value(call_state::get(&db, &id).unwrap().context_sources).unwrap(),
        json!({ "files": 1, "outline": 2, "clickup": 1 })
    );
}
