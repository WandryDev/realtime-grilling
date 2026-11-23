//! The topic check's prompt, schema, message and checks
//! (question-volume task 4.1).

use serde_json::json;

use super::*;
use crate::{
    agent::fast_loop::testing::{database, recording, say},
    storage::call_state::{
        CardLens, Evidence, EvidenceSource, ValidatedOp, ValidatedPatch, apply_patch,
    },
};

const MINUTE: i64 = 60_000;
const OTHERS: TranscriptChannel = TranscriptChannel::Others;
const ME: TranscriptChannel = TranscriptChannel::Me;

/// A recording on «Бронь через бот» with its goal, and phrases at 1, 9, 12
/// and 13 minutes (the last two of the operators).
fn call(connection: &Connection) -> (String, Vec<TranscriptSegment>) {
    let id = recording(connection);
    apply_patch(
        connection,
        &id,
        &ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Бронь через бот".to_owned(),
                },
                ValidatedOp::SetCardField {
                    field: CardLens::Goal,
                    value: "Клиент бронирует обмен в Телеграме".to_owned(),
                    evidence: vec![Evidence {
                        source: EvidenceSource::Segment,
                        id: "S1".to_owned(),
                        quote: "бронирует обмен".to_owned(),
                    }],
                },
            ],
        },
    )
    .unwrap();
    let segments = vec![
        say(
            connection,
            &id,
            OTHERS,
            MINUTE,
            "Клиент выбирает кассу и бронирует",
        ),
        say(
            connection,
            &id,
            OTHERS,
            9 * MINUTE,
            "Бронь держим семьдесят минут",
        ),
        say(
            connection,
            &id,
            OTHERS,
            12 * MINUTE,
            "Операторы колл-центра сидят все под одним номером телефона",
        ),
        say(
            connection,
            &id,
            ME,
            13 * MINUTE,
            "А как они делят чаты между собой?",
        ),
    ];
    (id, segments)
}

#[test]
fn the_schema_and_the_prompt() {
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(
        schema["properties"]["decision"]["enum"],
        json!(["same", "new", "switch"])
    );
    assert_eq!(
        schema["properties"]["title"]["maxLength"],
        json!(TITLE_CHARS)
    );
    // Small next to the fast loop's prefix: it is sent with every check.
    assert!(PROMPT.chars().count() < 2_500, "{}", PROMPT.chars().count());
    assert!(PROMPT.ends_with("StructuredOutput.\n"));
}

#[test]
fn a_reply_off_the_schema_is_an_error() {
    assert_eq!(parse(&json!({ "decision": "same" })), Ok(Decision::Same));
    for reply in [
        json!({}),
        json!({ "decision": "maybe" }),
        json!({ "decision": "new", "evidence": { "id": "s", "quote": "q" } }),
        json!({ "decision": "new", "title": "Операторы" }),
        json!({ "decision": "switch", "evidence": { "id": "s", "quote": "q" } }),
        json!({ "decision": "new", "title": "Операторы", "evidence": { "id": "s" } }),
    ] {
        assert!(parse(&reply).is_err(), "{reply}");
    }
    // Prefixes go, a long title is cut.
    let long = "Очень длинное название ".repeat(5);
    assert_eq!(
        parse(&json!({
            "decision": "new",
            "title": long,
            "evidence": { "id": "S:seg-3", "quote": "под одним номером" },
        })),
        Ok(Decision::New {
            title: long.chars().take(TITLE_CHARS).collect(),
            segment_id: "seg-3".to_owned(),
            quote: "под одним номером".to_owned(),
        })
    );
}

/// The message has the topics, the current one and how long it goes, and
/// only the last 6 minutes of the transcript; not the card.
#[test]
fn the_message_reads_the_last_six_minutes() {
    let connection = database();
    let (id, segments) = call(&connection);
    let assembled = assemble(&connection, &id, 12, WINDOW).unwrap();
    let message = &assembled.user_message;
    for part in [
        "Бронь через бот (текущая)",
        "# Текущая тема: Бронь через бот, идёт 12 мин",
        &segments[1].id,
        &segments[2].id,
        &segments[3].id,
    ] {
        assert!(message.contains(part), "no «{part}» in\n{message}");
    }
    assert!(!message.contains(&segments[0].id), "{message}");
    assert!(!message.contains("Клиент бронирует обмен"), "{message}");
    assert!(message.ends_with("StructuredOutput."));
    // Only the client's phrases can be quoted.
    let ids: Vec<&str> = assembled
        .client_phrases
        .iter()
        .map(|(id, _)| id.as_str())
        .collect();
    assert_eq!(ids, [segments[1].id.as_str(), segments[2].id.as_str()]);
}

#[test]
fn a_new_topic_needs_its_quote_in_a_client_phrase() {
    let connection = database();
    let (id, segments) = call(&connection);
    let assembled = assemble(&connection, &id, 12, WINDOW).unwrap();
    let state = call_state::get(&connection, &id).unwrap();
    let new = |segment_id: &str, quote: &str| Decision::New {
        title: "Работа операторов в чатах".to_owned(),
        segment_id: segment_id.to_owned(),
        quote: quote.to_owned(),
    };

    assert_eq!(
        check(
            &new(&segments[2].id, "сидят все под одним номером"),
            &assembled,
            &state
        ),
        Ok(Some(ValidatedOp::CreateTopic {
            title: "Работа операторов в чатах".to_owned()
        }))
    );
    // «Цитата не найдена».
    assert_eq!(
        check(
            &new(&segments[2].id, "у каждого свой номер"),
            &assembled,
            &state
        ),
        Err(TopicRejectReason::QuoteNotFound {
            segment_id: segments[2].id.clone(),
            quote: "у каждого свой номер".to_owned(),
        })
    );
    // The manager's words, or a phrase out of the window, are no ground.
    assert!(
        check(
            &new(&segments[3].id, "делят чаты между собой"),
            &assembled,
            &state
        )
        .is_err()
    );
    assert!(
        check(
            &new(&segments[0].id, "выбирает кассу и бронирует"),
            &assembled,
            &state
        )
        .is_err()
    );
    assert_eq!(check(&Decision::Same, &assembled, &state), Ok(None));
}

#[test]
fn a_switch_goes_to_another_known_topic() {
    let connection = database();
    let (id, segments) = call(&connection);
    let assembled = assemble(&connection, &id, 12, WINDOW).unwrap();
    let state = call_state::get(&connection, &id).unwrap();
    let current = state.current_topic_id.clone().unwrap();
    let switch = |topic_id: &str| Decision::Switch {
        topic_id: topic_id.to_owned(),
        segment_id: segments[2].id.clone(),
        quote: "сидят все под одним номером".to_owned(),
    };
    assert_eq!(
        check(&switch("unknown"), &assembled, &state),
        Err(TopicRejectReason::UnknownTopic {
            topic_id: "unknown".to_owned()
        })
    );
    // To the current topic: nothing to do.
    assert_eq!(check(&switch(&current), &assembled, &state), Ok(None));
}

#[test]
fn the_prompt_file_is_not_a_recordings_prefix() {
    let dir = tempfile::tempdir().unwrap();
    let path = write_prompt(dir.path()).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), PROMPT);
    let removed = crate::agent::fast_loop::assembly::sweep_prompts(dir.path(), |_| false).unwrap();
    assert_eq!(removed, 0);
    assert!(path.is_file());
}

/// Call-analytics task 2.1: the message stays byte for byte.
#[test]
fn the_message_snapshot() {
    let connection = database();
    let (id, _) = call(&connection);
    crate::agent::fast_loop::testing::assert_snapshot(
        "topic_check_message.txt",
        &assemble(&connection, &id, 12, WINDOW).unwrap().user_message,
    );
}
