//! The checks of decision 4 on hand-made messages.

use std::collections::HashMap;

use serde_json::json;

use super::{
    input::{SegmentRef, SummaryMessage},
    reply::{ProposalsReply, SummaryReply},
    validate::{self, Knowledge, MAX_NEXT, MAX_PROPOSALS, MAX_TOPICS},
};
use crate::storage::{
    call_state::{CardLens, GapType},
    people::Person,
    proposals::{Proposal, ProposalDecision, ProposalKind, ProposalTarget},
    summaries::SummaryTranscriptPass,
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
        project_name: Some("Обменник".to_owned()),
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
        notes: "",
        people: &[],
        proposals: &[],
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
        notes: "",
        people: &people,
        proposals: &[],
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
    assert_eq!(dropped.len(), 9, "{dropped:#?}");
    // A call without a project gets none.
    let reply = ProposalsReply::from_reply(json!({ "proposals": [
        { "target": "brief", "field": "stack", "after": "Redis", "kind": "inferred", "evidence": [] }
    ]}))
    .unwrap();
    assert!(validate::proposals(reply, &message(), false, &knowledge, &mut dropped).is_empty());
}

/// A message of these segments, `S1…` in order, `P1` the project's notes.
fn message_of(segments: &[(TranscriptChannel, &str)]) -> SummaryMessage {
    let mut message = message();
    message.segments = segments
        .iter()
        .enumerate()
        .map(|(index, (channel, text))| {
            let number = index + 1;
            let at = i64::try_from(number).unwrap() * 1_000;
            let segment = SegmentRef {
                number,
                recording_id: "r".to_owned(),
                segment_id: format!("seg-{number}"),
                channel: *channel,
                start_ms: at,
                end_ms: at + 900,
                text: (*text).to_owned(),
            };
            (format!("S{number}"), segment)
        })
        .collect();
    message.project_items = HashMap::from([("P1".to_owned(), "Нужен модуль возвратов".to_owned())]);
    message
}

fn topic(points: serde_json::Value, fields: serde_json::Value) -> serde_json::Value {
    json!({
        "refs": [], "title": "Интеграции", "from": "S1", "to": "S1",
        "points": points, "card": { "title": "", "fields": fields }
    })
}

fn summary_of(
    topics: Vec<serde_json::Value>,
    next: serde_json::Value,
    message: &SummaryMessage,
) -> validate::CheckedSummary {
    let reply = SummaryReply::from_reply(json!({
        "title": "", "tldr": "", "topics": topics, "answered": [], "next": next
    }))
    .unwrap();
    validate::summary(reply, message, SummaryTranscriptPass::Refined)
}

const REFUSED: &str = "Нет, мы не будем подключать 1С в этом году.";

/// H1: a quote that drops «не» or changes a number backs nothing, and what
/// is kept is the client's own words.
#[test]
fn a_quote_without_the_negation_backs_nothing() {
    let message = message_of(&[
        (TranscriptChannel::Others, REFUSED),
        (TranscriptChannel::Others, "У нас 50 операторов в смену."),
    ]);
    let point = |text: &str, id: &str, quote: &str| json!({ "text": text, "status": "fact", "evidence": [{ "id": id, "quote": quote }] });
    let checked = summary_of(
        vec![topic(
            json!([
                point(
                    "Подключат 1С в этом году",
                    "S1",
                    "мы будем подключать 1С в этом году"
                ),
                point("Пять операторов", "S2", "у нас 5 операторов в смену"),
                point(
                    "1С не в этом году",
                    "S1",
                    "мы не будем подключать 1с в этом году"
                ),
            ]),
            json!([{ "field": "integrations", "facts": [
                { "text": "1С подключат", "status": "confirmed",
                  "evidence": [{ "id": "S1", "quote": "будем подключать 1С в этом году" }] }
            ]}]),
        )],
        json!([]),
        &message,
    );
    let topic = &checked.summary.content.topics[0];
    assert_eq!(topic.points.len(), 1, "{:#?}", checked.dropped);
    assert_eq!(topic.points[0].text, "1С не в этом году");
    assert_eq!(
        topic.points[0].evidence[0].quote,
        "мы не будем подключать 1С в этом году"
    );
    // The fact lost its quote: «вывод агента», not «сказал клиент».
    let fact = &checked.summary.content.cards[0].fields[0].facts[0];
    assert_eq!(
        (fact.source, fact.status),
        (
            crate::storage::summaries::FactSource::Agent,
            crate::storage::summaries::FactStatus::Assumption
        )
    );
}

/// L14, L15, L16, L17: a topic without points goes (and a reply of only
/// such topics leaves nothing), drops are logged, the caps hold, and «Да.»
/// backs no point.
#[test]
fn what_does_not_hold_is_dropped_and_logged() {
    let message = message_of(&[
        (TranscriptChannel::Others, "Да."),
        (TranscriptChannel::Me, SAID),
        (TranscriptChannel::Others, SAID),
    ]);
    let yes = json!({ "text": "Согласен", "status": "fact", "evidence": [{ "id": "S1", "quote": "Да." }] });
    let manager = json!({ "text": "Менеджер", "status": "fact", "evidence": [{ "id": "S2", "quote": "платят картой и наличными" }] });
    let only_bad = topic(json!([yes, manager]), json!([]));
    let checked = summary_of(vec![only_bad.clone()], json!([]), &message);
    assert!(checked.nothing_left);
    assert!(checked.summary.content.topics.is_empty());
    let log = checked.dropped.join("\n");
    assert!(log.contains("слишком короткая"), "{log}");
    assert!(log.contains("S2 — реплика «Вы»"), "{log}");
    assert!(log.contains("ни один пункт не прошёл проверку"), "{log}");

    let good = json!({ "text": "Картой", "status": "fact", "evidence": [{ "id": "S3", "quote": "платят картой и наличными" }] });
    let many: Vec<_> = (0..9).map(|_| good.clone()).collect();
    let facts: Vec<_> = (0..6)
        .map(|n| json!({ "text": format!("Факт {n}"), "status": "confirmed", "evidence": [{ "id": "S3", "quote": "платят картой и наличными" }] }))
        .collect();
    let mut long = topic(json!(many), json!([{ "field": "goal", "facts": facts }]));
    long["from"] = json!("S99");
    long["title"] = json!("Т".repeat(300));
    let reply = SummaryReply::from_reply(json!({
        "title": "Н".repeat(500), "tldr": "Т".repeat(2_000),
        "topics": [only_bad, long], "answered": [], "next": []
    }))
    .unwrap();
    let checked = validate::summary(reply, &message, SummaryTranscriptPass::Refined);
    assert!(!checked.nothing_left);
    let summary = &checked.summary;
    assert_eq!(summary.content.topics.len(), 1);
    assert_eq!(summary.content.topics[0].points.len(), validate::MAX_POINTS);
    assert_eq!(
        summary.content.cards[0].fields[0].facts.len(),
        validate::MAX_FACTS
    );
    assert_eq!(summary.title.chars().count(), validate::MAX_TITLE_CHARS);
    assert!(summary.title.ends_with('…'));
    assert_eq!(summary.tldr.chars().count(), validate::MAX_TLDR_CHARS);
    assert_eq!(
        summary.content.topics[0].title.chars().count(),
        validate::MAX_TITLE_CHARS
    );
    let log = checked.dropped.join("\n");
    assert!(log.contains("начала S99 не было во входе"), "{log}");
    assert!(log.contains("больше 6 пунктов"), "{log}");
    assert!(log.contains("больше 4 фактов"), "{log}");
}

/// M7: a question for the next call has its field's gap; one on a
/// confirmed field goes; without a question about an empty field, the code
/// adds one (`call-task-cards`, «Пустое поле»).
#[test]
fn questions_for_next_time_follow_the_card() {
    let message = message_of(&[(TranscriptChannel::Others, SAID)]);
    let said = json!([{ "id": "S1", "quote": "платят картой и наличными" }]);
    let fields = json!([
        { "field": "goal", "facts": [{ "text": "Касса", "status": "confirmed", "evidence": said }] },
        { "field": "users", "facts": [{ "text": "Кассиры?", "status": "assumption", "evidence": said }] },
        { "field": "acceptance", "facts": [{ "text": "Неизвестно, когда готово", "status": "empty", "evidence": [] }] }
    ]);
    let point = json!({ "text": "Картой", "status": "fact", "evidence": said });
    let next = json!([
        { "text": "Зачем касса?", "topic": 1, "field": "goal", "gap": "empty" },
        { "text": "Кто пользуется?", "topic": 1, "field": "users", "gap": "contradiction" },
        { "text": "Что ещё?", "topic": null, "field": null, "gap": "assumption" }
    ]);
    let checked = summary_of(vec![topic(json!([point]), fields)], next, &message);
    let next = &checked.summary.content.next;
    let made: Vec<(&str, Option<CardLens>, GapType)> = next
        .iter()
        .map(|question| (question.text.as_str(), question.field, question.gap))
        .collect();
    let card = &checked.summary.content.cards[0];
    let added = format!(
        "«{}»: по каким критериям считать задачу готовой?",
        card.title
    );
    assert_eq!(
        made,
        [
            (
                "Кто пользуется?",
                Some(CardLens::Users),
                GapType::Assumption
            ),
            ("Что ещё?", None, GapType::Assumption),
            (added.as_str(), Some(CardLens::Acceptance), GapType::Empty),
        ]
    );
    assert_eq!(next[2].topic_id.as_deref(), Some(card.topic_id.as_str()));
    let log = checked.dropped.join("\n");
    assert!(log.contains("поле goal подтверждено"), "{log}");
    assert!(log.contains("не contradiction, а assumption"), "{log}");
}

/// M8: no title and no topics: the project's name.
#[test]
fn a_summary_without_title_or_topics_is_named_after_the_project() {
    let message = message_of(&[(TranscriptChannel::Others, SAID)]);
    let checked = summary_of(Vec::new(), json!([]), &message);
    assert!(!checked.nothing_left);
    assert_eq!(checked.summary.title, "Обменник");
    let mut loose = message.clone();
    loose.project_name = None;
    assert_eq!(summary_of(Vec::new(), json!([]), &loose).summary.title, "");
}

fn decided(field: &str, after: &str, decision: ProposalDecision) -> Proposal {
    Proposal {
        id: format!("{field}-{after}"),
        call_id: "c".to_owned(),
        target: ProposalTarget::Brief,
        person_id: None,
        field: field.to_owned(),
        before: None,
        after: after.to_owned(),
        kind: ProposalKind::Said,
        evidence: Vec::new(),
        decision,
        edited: None,
        applied: None,
        decided_at: Some(1),
        created_at: 0,
        updated_at: 0,
    }
}

/// M2, M6, L19, L39: what the manager decided or the notes hold is not
/// proposed again; «said» on the project alone is the agent's inference;
/// an inference keeps the client's quotes; «1С» in Cyrillic is «1C».
#[test]
fn proposals_respect_what_is_decided_and_said() {
    let message = message_of(&[(TranscriptChannel::Others, SAID)]);
    let brief = json!({ "stack": ["1C"], "glossary": [{ "term": "МІКС", "definition": "Корзина — микс" }] });
    let known = [
        decided("glossary", "USD МІКС — касса", ProposalDecision::Rejected),
        decided("modules", "Возвраты", ProposalDecision::Accepted),
        decided("modules", "Отчёты", ProposalDecision::Pending),
    ];
    let notes = "## Из звонков\n- 04.11.2026 (стек): Redis";
    let knowledge = Knowledge {
        brief: Some(&brief),
        notes,
        people: &[],
        proposals: &known,
    };
    let reply = ProposalsReply::from_reply(json!({ "proposals": [
        { "target": "brief", "field": "glossary", "after": "usd мікс — Касса", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "modules", "after": "Возвраты", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "modules", "after": "Отчёты", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "stack", "after": "Redis", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "stack", "after": "1С", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "glossary", "after": "МІКС: валюта — другое", "kind": "inferred", "evidence": [] },
        { "target": "brief", "field": "product", "after": "Модуль возвратов", "kind": "said",
          "evidence": [{ "id": "P1", "quote": "Нужен модуль возвратов" }] },
        { "target": "brief", "field": "product", "after": "Касса", "kind": "inferred",
          "evidence": [{ "id": "S1", "quote": "платят картой и наличными" }] }
    ]}))
    .unwrap();
    let mut dropped = Vec::new();
    let kept = validate::proposals(reply, &message, true, &knowledge, &mut dropped);
    let made: Vec<(&str, Option<&str>, ProposalKind, usize)> = kept
        .iter()
        .map(|p| {
            (
                p.after.as_str(),
                p.before.as_deref(),
                p.kind,
                p.evidence.len(),
            )
        })
        .collect();
    assert_eq!(
        made,
        [
            ("Отчёты", None, ProposalKind::Inferred, 0),
            // `entry_name` up to the earliest separator: «МІКС».
            (
                "МІКС: валюта — другое",
                Some("МІКС — Корзина — микс"),
                ProposalKind::Inferred,
                0
            ),
            ("Модуль возвратов", None, ProposalKind::Inferred, 0),
            ("Касса", None, ProposalKind::Inferred, 1),
        ],
        "{dropped:#?}"
    );
    assert_eq!(kept[3].evidence[0].quote, "платят картой и наличными");
    let log = dropped.join("\n");
    assert!(log.contains("уже отклонено"), "{log}");
    assert!(log.contains("уже принято"), "{log}");
    assert!(log.contains("уже в заметках"), "{log}");
    assert!(log.contains("опирается только на проект"), "{log}");
}
