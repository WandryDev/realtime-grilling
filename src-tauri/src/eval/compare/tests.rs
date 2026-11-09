//! «Сравнение после правки промпта»: both columns with their difference,
//! and the questions that appeared or disappeared.

use serde_json::json;

use super::*;
use crate::eval::testing::{MINUTE, OTHERS, call, phrase, question, report_with, topic};

fn baseline() -> Report {
    let mut report = report_with(
        vec![topic("a-t1", "Бронь через бота", 0)],
        vec![
            question("a1", MINUTE, "a-t1", "Кто подтверждает бронь у оператора?"),
            question("a2", 2 * MINUTE, "a-t1", "Сколько броней в день?"),
            question("a3", 3 * MINUTE, "a-t1", "Какой курс показывает бот?"),
        ],
        (1..=10)
            .map(|n| phrase(&format!("p{n}"), OTHERS, n * MINUTE))
            .collect(),
    );
    report.label = "main".to_owned();
    report.calls = vec![call(MINUTE, 4_000, 0.10, json!([]))];
    report
}

fn variant() -> Report {
    let mut report = report_with(
        vec![
            // The same topic named otherwise: no title of A is alike, so
            // its questions pair by text.
            topic("b-t1", "Бронирование", 0),
            topic("b-t2", "Работа операторов", 5 * MINUTE),
        ],
        vec![
            question("b1", MINUTE, "b-t1", "Кто у оператора подтверждает бронь?"),
            question("b2", 2 * MINUTE, "b-t1", "Сколько броней приходит в день?"),
            question("b3", 6 * MINUTE, "b-t2", "Сколько операторов в смене?"),
        ],
        (1..=10)
            .map(|n| phrase(&format!("p{n}"), OTHERS, n * MINUTE))
            .collect(),
    );
    report.label = "rules-v2".to_owned();
    report.calls = vec![
        call(MINUTE, 4_000, 0.10, json!([])),
        call(
            2 * MINUTE,
            6_000,
            0.15,
            json!([{ "op": "question", "reason": "repeat" }]),
        ),
    ];
    report
}

#[test]
fn questions_pair_by_text_within_a_topic() {
    let (a, b) = (baseline(), variant());
    let matched = match_questions(&a, &b);
    let pairs: Vec<(&str, &str)> = matched
        .pairs
        .iter()
        .map(|(qa, qb)| (qa.id.as_str(), qb.id.as_str()))
        .collect();
    assert_eq!(pairs, [("a1", "b1"), ("a2", "b2")]);
    let ids = |list: &[&ReportQuestion]| list.iter().map(|q| q.id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&matched.disappeared), ["a3"]);
    assert_eq!(ids(&matched.appeared), ["b3"]);
}

/// A topic both runs have: an alike question of another topic doesn't pair.
#[test]
fn a_question_of_another_matched_topic_does_not_pair() {
    let mut a = baseline();
    a.topics = vec![
        topic("a-t1", "Бронирование", 0),
        topic("a-t2", "Работа операторов", 5 * MINUTE),
    ];
    a.questions = vec![question(
        "a1",
        6 * MINUTE,
        "a-t1",
        "Сколько операторов в смене?",
    )];
    let b = variant();
    let matched = match_questions(&a, &b);
    assert!(matched.pairs.is_empty(), "{:?}", matched.pairs);
    assert_eq!(matched.disappeared.len(), 1);
    assert_eq!(matched.appeared.len(), 3);
}

#[test]
fn the_table_has_both_columns_and_the_difference() {
    let (a, b) = (baseline(), variant());
    let text = markdown(
        &Run {
            report: &a,
            judge: None,
            place: "reports/a".to_owned(),
        },
        &Run {
            report: &b,
            judge: None,
            place: "reports/b".to_owned(),
        },
    );
    for part in [
        "**A** — reports/a",
        "- Метка: main",
        "**B** — reports/b",
        "- Метка: rules-v2",
        "| Метрика | A | B | разница |",
        "| Показано вопросов | 3 | 3 | 0 |",
        "| Темы | 1 | 2 | +1 |",
        "| Отброшено проверкой | 0 | 1 | +1 |",
        "| Вызовы | 1 | 2 | +1 |",
        "| Вызов p95 | 4.0 с | 6.0 с | +2.0 с |",
        "| Стоимость | $0.10 | $0.25 | +$0.15 |",
        "| Вызов p50 | 4.0 с | 4.0 с | 0.0 с |",
        "| Доля полезных («задал бы») | — | — | — |",
        "Пар: 2",
        "### Появились (есть в B, нет в A)\n\n- 06:00 «Работа операторов» — Сколько операторов в смене?",
        "### Пропали (были в A, нет в B)\n\n- 03:00 «Бронь через бота» — Какой курс показывает бот?",
    ] {
        assert!(text.contains(part), "no «{part}» in\n{text}");
    }
    assert!(!text.contains("Внимание"));
    assert!(!text.contains("Для сведения"));
    // B has no stretch with five client phrases between its questions.
    assert!(
        text.contains(
            "| Самая длинная пауза (клиент ≥ 5 фраз) | 7:00 (03:00–10:00, фраз клиента 7) | — | — |"
        ),
        "{text}"
    );

    let mut other = variant();
    other.corpus = "obmennik".to_owned();
    let text = markdown(
        &Run {
            report: &a,
            judge: None,
            place: "a".to_owned(),
        },
        &Run {
            report: &other,
            judge: None,
            place: "b".to_owned(),
        },
    );
    assert!(text.contains("прогоны разных наборов"), "{text}");
}

/// Runs made differently (span, flags, rules): `compare` says so, for
/// information, and still compares.
#[test]
fn runs_made_differently_are_flagged() {
    let a = baseline();
    let mut b = variant();
    b.flags.from_min = Some(40.0);
    b.flags.to_min = Some(75.0);
    b.flags.realtime = true;
    b.flags.baseline_state = true;
    b.flags.no_gaps = true;
    b.rules_sha256 = "cd".repeat(32);
    let text = markdown(
        &Run {
            report: &a,
            judge: None,
            place: "a".to_owned(),
        },
        &Run {
            report: &b,
            judge: None,
            place: "b".to_owned(),
        },
    );
    for part in [
        "**Для сведения:** прогоны отличаются",
        "- отрезки звонка разные: A —–—, B 40–75 мин",
        "- --realtime: A нет, B да",
        "- --baseline-state: A нет, B да",
        "- --no-gaps: A нет, B да",
        "- правила разные (sha256 в заголовках)",
        "| Метрика | A | B | разница |",
    ] {
        assert!(text.contains(part), "no «{part}» in\n{text}");
    }
    assert!(!text.contains("Внимание"));
}

/// A question never shown is in neither list: it pairs with nothing and
/// neither appears nor disappears.
#[test]
fn a_question_never_shown_is_not_compared() {
    let a = baseline();
    let mut b = variant();
    b.questions[2].shown_at_ms = None;
    let matched = match_questions(&a, &b);
    assert_eq!(matched.pairs.len(), 2);
    assert!(matched.appeared.is_empty(), "{:?}", matched.appeared);
}

#[test]
fn differences_keep_the_sign_and_the_unit() {
    let value = |number: f64, kind: Kind| MetricValue {
        number,
        kind,
        shown: String::new(),
    };
    let diff = |a: f64, b: f64, kind: Kind| difference(&value(a, kind), &value(b, kind));
    assert_eq!(diff(0.09, 0.07, Kind::Money), "-$0.02");
    assert_eq!(diff(0.07, 0.09, Kind::Money), "+$0.02");
    assert_eq!(diff(3.0, 2.0, Kind::Count), "-1");
    assert_eq!(diff(0.5, 0.75, Kind::Share), "+25 п.п.");
    assert_eq!(diff(90_000.0, 30_000.0, Kind::Duration), "-1:00");
    assert_eq!(diff(6_400.0, 6_000.0, Kind::Seconds), "-0.4 с");
}
