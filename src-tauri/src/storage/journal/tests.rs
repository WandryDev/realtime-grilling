use rusqlite::Connection;
use rusqlite_migration::Migrations;

use crate::storage::{DATABASE_FILE, MIGRATION_LIST, MIGRATIONS, SCHEMA_VERSION, open, recordings};

fn count(connection: &Connection, sql: &str) -> i64 {
    connection.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// The rows of `agent_calls` in the columns a v12 database has.
fn calls(connection: &Connection) -> Vec<Vec<String>> {
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
}

/// v12 → v13 (task 1.1): the journal, the questions and the findings stay,
/// the foreign keys hold, and a recording's delete takes its calls, their
/// operations and the events along.
#[test]
fn migration_0013_keeps_the_journal_of_version_12() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(DATABASE_FILE);
    let seed = "INSERT INTO projects (id, name, created_at, updated_at)
         VALUES ('p', 'Обменник', 1, 1);
         INSERT INTO calls (id, project_id, title, status, created_at, updated_at)
         VALUES ('call', 'p', 'KYC', 'finished', 2, 2);
         INSERT INTO recordings
           (id, call_id, status, started_at, me_file, others_file, created_at, updated_at)
         VALUES ('rec', 'call', 'finished', 5, 'a', 'b', 5, 5);
         INSERT INTO questions (id, recording_id, text, evidence, created_at, updated_at)
         VALUES ('q1', 'rec', 'Сколько операторов?', '[]', 6, 6);
         INSERT INTO agent_calls
           (id, recording_id, started_at, duration_ms, outcome, input_tokens, output_tokens,
            cache_read, cache_write, cost_usd, utilization, rejected, error, created_at, kind)
         VALUES ('c1', 'rec', 10, 900, 'ok', 2, 300, 5400, 0, 0.04, 0.5,
                 '[{\"reason\":\"quoteNotFound\"}]', NULL, 11, 'fastLoop'),
                ('c2', 'rec', 20, 400, 'empty', NULL, NULL, NULL, NULL, NULL, NULL,
                 '[]', 'x', 21, 'slowLoop');
         INSERT INTO context_findings
           (id, recording_id, source_kind, source_name, chunk_key, quote, note,
            agent_call_id, created_at)
         VALUES ('f1', 'rec', 'outline', 'Регламент', 's#1', 'три оператора', 'смена',
                 'c2', 22);";
    let before = {
        let connection = open(&path, &Migrations::from_slice(&MIGRATION_LIST[..12])).unwrap();
        connection.execute_batch(seed).unwrap();
        calls(&connection)
    };

    let connection = open(&path, &MIGRATIONS).unwrap();
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION as i64);
    assert_eq!(calls(&connection), before);
    assert_eq!(count(&connection, "SELECT count(*) FROM questions"), 1);
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM context_findings WHERE agent_call_id = 'c2'"
        ),
        1
    );
    assert_eq!(
        count(&connection, "SELECT count(*) FROM pragma_foreign_key_check"),
        0
    );
    for index in [
        "agent_calls_recording",
        "agent_calls_call",
        "agent_calls_project",
    ] {
        assert_eq!(
            count(
                &connection,
                &format!("SELECT count(*) FROM sqlite_master WHERE name = '{index}'")
            ),
            1,
            "{index}"
        );
    }
    // The analytics start now: older calls are never sent.
    let since = count(&connection, "SELECT enabled_since FROM analytics_meta");
    assert!(since > 1_700_000_000_000, "{since}");

    // A call's summary belongs to the call, the brief to the project.
    connection
        .execute_batch(
            "INSERT INTO agent_calls
               (id, call_id, started_at, duration_ms, outcome, created_at, kind)
             VALUES ('s', 'call', 30, 1, 'ok', 30, 'summary');
             INSERT INTO agent_calls
               (id, project_id, started_at, duration_ms, outcome, created_at, kind)
             VALUES ('b', 'p', 31, 1, 'ok', 31, 'brief');",
        )
        .unwrap();
    for wrong in [
        "INSERT INTO agent_calls (id, recording_id, started_at, duration_ms, outcome, \
         created_at, kind) VALUES ('w1', 'rec', 1, 1, 'ok', 1, 'summary')",
        "INSERT INTO agent_calls (id, call_id, recording_id, started_at, duration_ms, \
         outcome, created_at, kind) VALUES ('w2', 'call', 'rec', 1, 1, 'ok', 1, 'fastLoop')",
        "INSERT INTO agent_calls (id, started_at, duration_ms, outcome, created_at, kind) \
         VALUES ('w3', 1, 1, 'ok', 1, 'brief')",
        "INSERT INTO agent_calls (id, recording_id, started_at, duration_ms, outcome, \
         created_at, kind, trigger_reason) VALUES ('w4', 'rec', 1, 1, 'ok', 1, 'fastLoop', \
         'whenever')",
    ] {
        assert!(connection.execute(wrong, []).is_err(), "{wrong}");
    }

    // The journal of a recording, written before its call's row as the loops
    // do (decision 1): the deferred keys are checked at the commit.
    connection
        .execute_batch(
            "BEGIN;
             INSERT INTO prompt_parts (hash, text, bytes, created_at)
             VALUES ('h1', 'Ты помощник', 20, 40);
             INSERT INTO agent_call_parts (agent_call_id, ord, label, hash)
             VALUES ('c3', 0, 'file', 'h1');
             INSERT INTO agent_call_ops (agent_call_id, idx, op, body, applied, subject_kind,
                                         subject_id)
             VALUES ('c3', 0, 'addQuestion', '{}', 1, 'question', 'q1');
             INSERT INTO question_events (id, question_id, recording_id, kind, agent_call_id, at)
             VALUES ('e1', 'q1', 'rec', 'created', 'c3', 40);
             INSERT INTO slow_loop_candidates
               (agent_call_id, label, rank, chunk_key, source_kind, source_name, text)
             VALUES ('c3', 'C1', 1, 's#1', 'outline', 'Регламент', 'три оператора');
             INSERT INTO finding_events (id, finding_id, kind, at) VALUES ('fe', 'f1', 'shown', 41);
             INSERT INTO agent_calls
               (id, recording_id, started_at, duration_ms, outcome, created_at, kind)
             VALUES ('c3', 'rec', 40, 1, 'ok', 40, 'fastLoop');
             COMMIT;",
        )
        .unwrap();
    // A reference to a call that never came fails at the commit.
    let mut dangling = Connection::open(&path).unwrap();
    dangling.pragma_update(None, "foreign_keys", "ON").unwrap();
    let transaction = dangling.transaction().unwrap();
    transaction
        .execute(
            "INSERT INTO agent_call_ops (agent_call_id, idx, op, body, applied)
             VALUES ('nope', 0, 'addQuestion', '{}', 0)",
            [],
        )
        .unwrap();
    assert!(transaction.commit().is_err());

    recordings::delete(&connection, "rec").unwrap();
    for table in [
        "agent_calls WHERE recording_id IS NOT NULL",
        "agent_call_parts",
        "agent_call_ops",
        "slow_loop_candidates",
        "question_events",
        "finding_events",
    ] {
        assert_eq!(
            count(&connection, &format!("SELECT count(*) FROM {table}")),
            0,
            "{table}"
        );
    }
    // The text stays for the retention to clear: other calls may share it.
    assert_eq!(count(&connection, "SELECT count(*) FROM prompt_parts"), 1);
    // A call's delete takes its summary along, a project's its brief.
    connection
        .execute("DELETE FROM calls WHERE id = 'call'", [])
        .unwrap();
    assert_eq!(
        count(
            &connection,
            "SELECT count(*) FROM agent_calls WHERE id = 's'"
        ),
        0
    );
    connection
        .execute("DELETE FROM projects WHERE id = 'p'", [])
        .unwrap();
    assert_eq!(count(&connection, "SELECT count(*) FROM agent_calls"), 0);
}

mod journal {
    use serde_json::json;

    use super::count;
    use crate::{
        agent::fast_loop::testing::{database, recording},
        storage::{
            call_state::{self, AgentCallInput, AgentCallOutcome, CallTrigger},
            journal::{self, CallOp, PromptPart, SubjectKind},
        },
    };

    fn call(connection: &rusqlite::Connection, recording_id: &str, id: &str) {
        call_state::insert_agent_call_at(
            connection,
            &AgentCallInput {
                id: Some(id.to_owned()),
                recording_id: recording_id.to_owned(),
                outcome: Some(AgentCallOutcome::Ok),
                ..AgentCallInput::default()
            },
            100,
        )
        .unwrap();
    }

    /// Task 1.2: two calls with the same prompt file keep its text once.
    #[test]
    fn a_shared_part_of_the_prompt_is_stored_once() {
        let mut connection = database();
        let recording_id = recording(&connection);
        let tx = connection.transaction().unwrap();
        let first = journal::prompt(
            &tx,
            "a",
            &[
                PromptPart::new("file", "Ты помощник на звонке"),
                PromptPart::new("transcript", "Клиент: нужно три оператора"),
            ],
            10,
        )
        .unwrap();
        let second = journal::prompt(
            &tx,
            "b",
            &[
                PromptPart::new("file", "Ты помощник на звонке"),
                PromptPart::new("transcript", "Клиент: и ночная смена"),
            ],
            11,
        )
        .unwrap();
        call(&tx, &recording_id, "a");
        call(&tx, &recording_id, "b");
        tx.commit().unwrap();

        assert_eq!(first.len(), 2);
        // Only the new transcript is a new text.
        assert_eq!(second.len(), 1);
        assert_eq!(count(&connection, "SELECT count(*) FROM prompt_parts"), 3);
        assert_eq!(
            count(&connection, "SELECT count(*) FROM agent_call_parts"),
            4
        );
        let shared: i64 = connection
            .query_row(
                "SELECT count(DISTINCT p.agent_call_id) FROM agent_call_parts p
                  JOIN prompt_parts t ON t.hash = p.hash
                 WHERE t.text = 'Ты помощник на звонке'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(shared, 2);
        let labels: Vec<(i64, String)> = connection
            .prepare(
                "SELECT ord, label FROM agent_call_parts WHERE agent_call_id = 'b' ORDER BY ord",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            labels,
            vec![(0, "file".to_owned()), (1, "transcript".to_owned())]
        );
    }

    /// Task 1.2: the operations keep the reply's order and the reasons.
    #[test]
    fn the_operations_keep_their_order_and_reasons() {
        let mut connection = database();
        let recording_id = recording(&connection);
        let tx = connection.transaction().unwrap();
        journal::call_ops(
            &tx,
            "a",
            &[
                CallOp {
                    op: "addQuestion".to_owned(),
                    body: json!({ "op": "addQuestion", "text": "Сколько операторов?" }),
                    applied: true,
                    reason: None,
                    subject: Some((SubjectKind::Question, "q1".to_owned())),
                },
                CallOp {
                    op: "addQuestion".to_owned(),
                    body: json!({ "op": "addQuestion", "text": "Сколько операторов в смене?" }),
                    applied: false,
                    reason: Some(json!({ "reason": "duplicate", "of": "q1", "similarity": 0.92 })),
                    subject: None,
                },
            ],
        )
        .unwrap();
        call(&tx, &recording_id, "a");
        tx.commit().unwrap();

        let ops: Vec<(i64, i64, Option<String>, Option<String>)> = connection
            .prepare(
                "SELECT idx, applied, json_extract(reason, '$.reason'), subject_id
                   FROM agent_call_ops WHERE agent_call_id = 'a' ORDER BY idx",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            ops,
            vec![
                (0, 1, None, Some("q1".to_owned())),
                (1, 0, Some("duplicate".to_owned()), None),
            ]
        );
    }

    /// Task 1.2: the call keeps the id made before its patch and the
    /// journal's columns.
    #[test]
    fn a_call_is_inserted_with_the_id_made_before() {
        let connection = database();
        let recording_id = recording(&connection);
        let id = call_state::insert_agent_call_at(
            &connection,
            &AgentCallInput {
                id: Some("0193f2a1-7c4e-7b1a-9f02-5d6e8a41c3b7".to_owned()),
                recording_id,
                outcome: Some(AgentCallOutcome::Ok),
                model: Some("sonnet".to_owned()),
                trigger: Some(CallTrigger::TurnEnd),
                trigger_segment_id: Some("seg-9".to_owned()),
                window_segments: Some(vec!["seg-8".to_owned(), "seg-9".to_owned()]),
                raw_reply: Some("{\"type\":\"result\"}".to_owned()),
                reply: Some(json!({ "ops": [] })),
                ..AgentCallInput::default()
            },
            100,
        )
        .unwrap();
        assert_eq!(id, "0193f2a1-7c4e-7b1a-9f02-5d6e8a41c3b7");
        let row: (String, String, String, String) = connection
            .query_row(
                "SELECT model, trigger_reason, trigger_segment_id, window_segments
                   FROM agent_calls WHERE id = ?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "sonnet".to_owned(),
                "turnEnd".to_owned(),
                "seg-9".to_owned(),
                "[\"seg-8\",\"seg-9\"]".to_owned()
            )
        );
    }
}

/// Task 2.5: a finding is shown when added, hidden by «Убрать», evicted when
/// a newer one takes its place.
#[test]
fn a_finding_is_shown_hidden_and_evicted() {
    use crate::{
        agent::fast_loop::testing::{database, recording},
        storage::context_findings::{self, FindingSourceKind, Inserted, MAX_VISIBLE, NewFinding},
    };
    let connection = database();
    let recording_id = recording(&connection);
    let add = |n: usize| -> String {
        let new = NewFinding {
            source_id: None,
            source_kind: FindingSourceKind::Outline,
            source_name: "Регламент".to_owned(),
            source_url: None,
            chunk_key: format!("r#{n}"),
            quote: format!("Цитата номер {n} из регламента смены"),
            note: "Подтверждает".to_owned(),
            question_id: None,
            agent_call_id: None,
        };
        match context_findings::insert_at(&connection, &recording_id, &new, 10 + n as i64).unwrap()
        {
            Inserted::Added { id, .. } => id,
            Inserted::NoRoom => panic!("no room"),
        }
    };
    let first = add(0);
    let second = add(1);
    context_findings::hide(&connection, &recording_id, &second, 50).unwrap();
    for n in 2..=MAX_VISIBLE + 1 {
        add(n);
    }
    let kinds = |id: &str| -> Vec<String> {
        connection
            .prepare("SELECT kind FROM finding_events WHERE finding_id = ?1 ORDER BY at")
            .unwrap()
            .query_map([id], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    };
    assert_eq!(kinds(&first), ["shown", "evicted"]);
    assert_eq!(kinds(&second), ["shown", "hidden"]);
}
