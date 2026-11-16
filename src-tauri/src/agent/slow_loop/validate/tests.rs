use serde_json::json;

use super::*;
use crate::{agent::slow_loop::search::IndexSource, storage::context_findings::FindingSourceKind};

const REGULATION: &str = "Оператор смены отвечает за распределение звонков между линиями. \
                          В смене три оператора, старший смены следит за очередью.";
const NIGHT: &str = "Ночью звонки уходят на автоответчик клиники, утром их разбирает первая смена.";

fn candidate(key: &str, text: &str) -> Candidate {
    Candidate {
        key: key.to_owned(),
        source: IndexSource {
            id: key.split('#').next().unwrap().to_owned(),
            name: "Регламент смены".to_owned(),
            kind: FindingSourceKind::Outline,
            url: Some("https://outline.example/doc/reg".to_owned()),
        },
        path: "Старший смены".to_owned(),
        text: text.to_owned(),
    }
}

/// `C1` the regulation, `C2` the night; `Q1` open; one finding already.
fn context() -> SlowContext {
    SlowContext {
        candidates: vec![candidate("reg#0", REGULATION), candidate("reg#1", NIGHT)],
        open_questions: vec!["Q1".to_owned()],
        known: vec![KnownFinding {
            id: "f-old".to_owned(),
            chunk_key: "other#4".to_owned(),
            quote: "запись к врачу без ожидания на линии".to_owned(),
        }],
    }
}

fn reply(findings: serde_json::Value) -> Reply {
    Reply::parse(json!({ "findings": findings, "queries": [] })).unwrap()
}

fn finding(candidate: &str, quote: &str) -> serde_json::Value {
    json!({ "candidate": candidate, "quote": quote, "note": "Противоречит: в регламенте три оператора" })
}

fn reasons(validation: &SlowValidation) -> Vec<&SlowRejectReason> {
    validation.rejected.iter().map(|r| &r.reason).collect()
}

#[test]
fn a_finding_that_passes_keeps_the_sources_spelling() {
    let validation = validate(
        &reply(json!([{
            "candidate": "[C1]", "quote": "в смене ТРИ оператора старший",
            "note": "  Противоречит:\n клиент говорит о пяти  ", "questionId": "Q:Q1"
        }])),
        &context(),
    );
    assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
    let (index, accepted) = &validation.accepted[0];
    assert_eq!(*index, 0);
    assert_eq!(accepted.candidate.key, "reg#0");
    assert_eq!(accepted.quote, "В смене три оператора, старший");
    assert_eq!(accepted.note, "Противоречит: клиент говорит о пяти");
    assert_eq!(accepted.question_id.as_deref(), Some("Q1"));
}

/// Spec «Выдуманная цитата».
#[test]
fn an_invented_quote_is_rejected() {
    let validation = validate(
        &reply(json!([finding(
            "C1",
            "в смене работают двадцать операторов"
        )])),
        &context(),
    );
    assert!(validation.accepted.is_empty());
    assert_eq!(
        reasons(&validation),
        [&SlowRejectReason::QuoteNotFound {
            quote: "в смене работают двадцать операторов".to_owned()
        }]
    );
    let logged = validation.rejected_json();
    assert_eq!(logged[0]["reason"], "quoteNotFound");
    assert_eq!(logged[0]["op"], "finding");
    assert_eq!(logged[0]["subject"], "C1");

    let validation = validate(&reply(json!([finding("C1", "три")])), &context());
    assert!(matches!(
        reasons(&validation)[..],
        [SlowRejectReason::QuoteTooShort { .. }]
    ));
}

/// Spec «Повтор»: the same quote of the same chunk, and the same chunk or
/// quote as a finding of the recording or an earlier one of the reply.
#[test]
fn repeats_are_rejected() {
    let mut known = context();
    known.known.push(KnownFinding {
        id: "f-1".to_owned(),
        chunk_key: "reg#0".to_owned(),
        quote: "В смене три оператора".to_owned(),
    });
    let validation = validate(
        &reply(json!([finding("C1", "в смене три оператора")])),
        &known,
    );
    assert_eq!(
        reasons(&validation),
        [&SlowRejectReason::Repeat {
            of: "f-1".to_owned(),
            score: 1.0
        }]
    );

    // The same quote from another chunk (a copy of the regulation).
    let mut copy = context();
    copy.candidates.push(candidate("copy#0", REGULATION));
    copy.known.push(KnownFinding {
        id: "f-2".to_owned(),
        chunk_key: "reg#0".to_owned(),
        quote: "В смене три оператора, старший смены следит за очередью".to_owned(),
    });
    let validation = validate(
        &reply(json!([finding(
            "C3",
            "в смене три оператора старший смены следит за очередью"
        )])),
        &copy,
    );
    assert!(matches!(
        reasons(&validation)[..],
        [SlowRejectReason::Repeat { of, score }] if of == "f-2" && *score >= REPEAT_SIMILARITY
    ));

    // Twice in one reply: the second goes.
    let validation = validate(
        &reply(json!([
            finding("C2", "ночью звонки уходят на автоответчик"),
            finding("C2", "утром их разбирает первая смена")
        ])),
        &context(),
    );
    assert_eq!(validation.accepted.len(), 1);
    assert_eq!(
        reasons(&validation),
        [&SlowRejectReason::Repeat {
            of: "finding 0".to_owned(),
            score: 1.0
        }]
    );
}

#[test]
fn an_unknown_candidate_and_a_closed_question_are_rejected() {
    let validation = validate(
        &reply(json!([
            finding("C9", "в смене три оператора"),
            finding("X1", "в смене три оператора"),
            {
                "candidate": "C1", "quote": "в смене три оператора",
                "note": "Дополняет", "questionId": "Q2"
            },
            { "candidate": "C2", "quote": "ночью звонки уходят на автоответчик", "note": "  " }
        ])),
        &context(),
    );
    assert!(validation.accepted.is_empty());
    assert_eq!(
        reasons(&validation),
        [
            &SlowRejectReason::UnknownCandidate,
            &SlowRejectReason::UnknownCandidate,
            &SlowRejectReason::QuestionNotOpen {
                question_id: "Q2".to_owned()
            },
            &SlowRejectReason::Blank { field: "note" },
        ]
    );
    assert_eq!(validation.rejected_json()[2]["questionId"], "Q2");
}

/// Two per call: the third is dropped.
#[test]
fn the_third_finding_is_dropped() {
    let mut context = context();
    context.candidates.push(candidate(
        "tz#0",
        "Интеграция с МИС через API, синхронизация расписания врачей каждые пять минут.",
    ));
    let validation = validate(
        &reply(json!([
            finding("C1", "в смене три оператора"),
            finding("C2", "ночью звонки уходят на автоответчик"),
            finding("C3", "синхронизация расписания врачей каждые пять минут")
        ])),
        &context,
    );
    assert_eq!(validation.accepted.len(), MAX_FINDINGS);
    assert_eq!(
        validation
            .rejected
            .iter()
            .map(|r| (r.index, &r.reason))
            .collect::<Vec<_>>(),
        [(2, &SlowRejectReason::OverLimit)]
    );
}

/// The question closed during the call: stale.
#[test]
fn a_recheck_drops_what_went_stale() {
    let reply = reply(json!([
        { "candidate": "C1", "quote": "в смене три оператора", "note": "Дополняет", "questionId": "Q1" },
        finding("C2", "ночью звонки уходят на автоответчик")
    ]));
    let given = context();
    let checked = validate(&reply, &given);
    assert_eq!(checked.accepted.len(), 2);
    let fresh = SlowContext {
        open_questions: Vec::new(),
        ..given
    };
    let rechecked = recheck(&reply, checked, &fresh);
    assert_eq!(rechecked.accepted.len(), 1);
    assert_eq!(rechecked.accepted[0].0, 1);
    assert_eq!(rechecked.rejected_json()[0]["reason"], "stale");
    assert_eq!(
        rechecked.rejected_json()[0]["cause"]["reason"],
        "questionNotOpen"
    );
}

#[test]
fn a_reply_is_parsed_with_its_queries_cut() {
    let reply = Reply::parse(json!({
        "findings": [],
        "queries": [
            "старший смены",
            "  ",
            "один два три четыре пять шесть семь восемь девять десять",
            "mango office",
            "четвёртый"
        ]
    }))
    .unwrap();
    assert_eq!(
        reply.queries,
        [
            "старший смены",
            "один два три четыре пять шесть семь восемь",
            "mango office"
        ]
    );
    assert!(Reply::parse(json!({ "ops": [] })).is_err());
    assert!(Reply::parse(json!({ "findings": [{ "candidate": "C1" }] })).is_err());
    assert_eq!(
        Reply::parse(json!({ "findings": [] })).unwrap(),
        Reply::default()
    );
}
