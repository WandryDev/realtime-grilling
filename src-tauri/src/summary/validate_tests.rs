//! The checks of decision 4 on hand-made messages.

use std::collections::HashMap;

use serde_json::json;

use super::{
    input::{SegmentRef, SummaryMessage},
    reply::{ProposalsReply, SummaryReply},
    validate::{self, Knowledge, MAX_NEXT, MAX_PROPOSALS, MAX_TOPICS},
};
use crate::storage::{
    people::Person, proposals::ProposalKind, summaries::SummaryTranscriptPass,
    transcript::TranscriptChannel,
};

const SAID: &str = "Клиенты платят картой и наличными в кассе";

fn message() -> SummaryMessage {
    let segment = |number: usize, channel| SegmentRef {
        number,
        recording_id: "r".to_owned(),
        segment_id: format!("seg-{number}"),
        channel,
        start_ms: i64::try_from(number).unwrap() * 1_000,
        end_ms: i64::try_from(number).unwrap() * 1_000 + 900,
        text: SAID.to_owned(),
    };
    SummaryMessage {
        text: String::new(),
        nonce: "n".to_owned(),
        shortened: false,
        segments: HashMap::from([
            ("S1".to_owned(), segment(1, TranscriptChannel::Others)),
            ("S2".to_owned(), segment(2, TranscriptChannel::Me)),
        ]),
        topics: HashMap::new(),
        questions: HashMap::new(),
        people: HashMap::from([("H1".to_owned(), "igor".to_owned())]),
        project_items: HashMap::new(),
        segment_count: 2,
    }
}

fn point() -> serde_json::Value {
    json!({ "text": "Платят картой", "status": "fact", "evidence": [{ "id": "[S1]", "quote": "платят картой и наличными" }] })
}

#[test]
fn the_limits_hold() {
    let topics: Vec<_> = (0..15)
        .map(|index| {
            json!({
                "refs": [], "title": format!("Тема {index}"), "from": "S1", "to": "S1",
                "points": [point()], "card": { "title": "", "fields": [] }
            })
        })
        .collect();
    let next: Vec<_> = (0..8)
        .map(|index| json!({ "text": format!("Вопрос {index}"), "topic": null, "field": null, "gap": "empty" }))
        .collect();
    let reply = SummaryReply::from_reply(json!({
        "title": " ", "tldr": "", "topics": topics, "answered": [], "next": next
    }))
    .unwrap();
    let checked = validate::summary(reply, &message(), SummaryTranscriptPass::Live);
    assert_eq!(checked.summary.content.topics.len(), MAX_TOPICS);
    assert_eq!(checked.summary.content.cards.len(), MAX_TOPICS);
    assert_eq!(checked.summary.content.next.len(), MAX_NEXT);
    // No title from the agent: the first topic's.
    assert_eq!(checked.summary.title, "Тема 0");
    // `[S1]` as copied reads as `S1`.
    assert_eq!(
        checked.summary.content.topics[0].points[0].evidence[0].segment_id,
        "seg-1"
    );

    let proposals: Vec<_> = (0..15)
        .map(|index| {
            json!({ "target": "brief", "field": "stack", "after": format!("Сервис {index}"), "kind": "inferred", "evidence": [] })
        })
        .collect();
    let reply = ProposalsReply::from_reply(json!({ "proposals": proposals })).unwrap();
    let knowledge = Knowledge {
        brief: None,
        people: &[],
    };
    let kept = validate::proposals(reply, &message(), true, &knowledge, &mut Vec::new());
    assert_eq!(kept.len(), MAX_PROPOSALS);
}

/// A contradiction on one phrase of the client, and on a phrase of the
/// manager, is not one.
#[test]
fn a_contradiction_needs_two_phrases_of_the_client() {
    let reply = SummaryReply::from_reply(json!({
        "title": "", "tldr": "", "answered": [], "next": [],
        "topics": [{
            "refs": [], "title": "Оплата", "from": "S9", "to": "S9",
            "points": [{
                "text": "Карта или наличные?", "status": "contradiction",
                "evidence": [
                    { "id": "S1", "quote": "платят картой и наличными" },
                    { "id": "S2", "quote": "платят картой и наличными" }
                ]
            }],
            "card": { "title": "", "fields": [] }
        }]
    }))
    .unwrap();
    let checked = validate::summary(reply, &message(), SummaryTranscriptPass::Live);
    let topic = &checked.summary.content.topics[0];
    assert_eq!(
        topic.points[0].status,
        crate::storage::summaries::PointStatus::Assumption
    );
    // An unknown range falls back to the points' phrases.
    assert_eq!(topic.from.segment_id, "seg-1");
    assert!(!checked.dropped.is_empty());
}

fn igor(profile: serde_json::Value) -> Person {
    Person {
        id: "igor".to_owned(),
        project_id: "p".to_owned(),
        name: "Игорь".to_owned(),
        role: "CTO".to_owned(),
        profile,
        created_at: 0,
        updated_at: 0,
    }
}

/// `before` is the data's: the entry of a list field the proposal updates,
/// the profile's field; equal values and unknown fields go.
#[test]
fn before_comes_from_the_brief_and_the_profile() {
    let brief = json!({
        "product": "Обменник",
        "stack": ["Monobank API"],
        "modules": [{ "name": "Курсы", "description": "Показывает курс" }],
        "glossary": [{ "term": "МІКС", "definition": "Корзина валют" }]
    });
    let people = [igor(
        json!({ "tech": 3, "portrait": { "Характер": "Спокойный" } }),
    )];
    let knowledge = Knowledge {
        brief: Some(&brief),
        people: &people,
    };
    let reply = ProposalsReply::from_reply(json!({ "proposals": [
        { "target": "brief", "field": "stack", "after": "monobank api", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "glossary", "after": "МІКС — корзина валют", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "glossary", "after": "МІКС — корзина доллара и гривны", "kind": "said", "evidence": [{ "id": "S1", "quote": "платят картой и наличными" }] },
        { "target": "brief", "field": "modules", "after": "Курсы: показывает курс трёх банков", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "price", "after": "100", "kind": "inferred", "evidence": [] },
        { "target": "H1", "field": "role", "after": "CTO", "kind": "inferred", "evidence": [] },
        { "target": "H1", "field": "portrait:Характер", "after": "Вспыльчивый", "kind": "said", "evidence": [{ "id": "S2", "quote": "платят картой и наличными" }] },
        { "target": "H1", "field": "portrait:Рост", "after": "Высокий", "kind": "inferred", "evidence": [] },
        { "target": "H1", "field": "tech", "after": "3", "kind": "inferred", "evidence": [] },
        { "target": "H1", "field": "project", "after": "пять", "kind": "inferred", "evidence": [] }
    ]}))
    .unwrap();
    let mut dropped = Vec::new();
    let kept = validate::proposals(reply, &message(), true, &knowledge, &mut dropped);
    let made: Vec<(&str, Option<&str>, &str, ProposalKind)> = kept
        .iter()
        .map(|p| {
            (
                p.field.as_str(),
                p.before.as_deref(),
                p.after.as_str(),
                p.kind,
            )
        })
        .collect();
    assert_eq!(
        made,
        vec![
            (
                "glossary",
                Some("МІКС — Корзина валют"),
                "МІКС — корзина доллара и гривны",
                ProposalKind::Said
            ),
            (
                "modules",
                Some("Курсы — Показывает курс"),
                "Курсы: показывает курс трёх банков",
                ProposalKind::Inferred
            ),
            // The manager's words are no basis: «вывод агента».
            (
                "portrait:Характер",
                Some("Спокойный"),
                "Вспыльчивый",
                ProposalKind::Inferred
            ),
        ]
    );
    assert_eq!(dropped.len(), 8, "{dropped:#?}");
    // A call without a project gets none.
    let reply = ProposalsReply::from_reply(json!({ "proposals": [
        { "target": "brief", "field": "stack", "after": "Redis", "kind": "inferred", "evidence": [] }
    ]}))
    .unwrap();
    assert!(validate::proposals(reply, &message(), false, &knowledge, &mut dropped).is_empty());
}
