//! The metrics of decision 5 on a hand-built report.

use serde_json::json;

use super::*;
use crate::eval::{
    judge::{ManagerQuestion, QuestionLabel},
    testing::{ME, MINUTE, OTHERS, call, phrase, question, report, report_with, topic},
};

/// Three topics (the last without a question), four questions, 20 minutes
/// of phrases: 3:00–12:00 has only 4 client phrases, 13:00–20:00 has 5.
fn run() -> Report {
    let topics = vec![
        topic("t1", "Очередь", MINUTE),
        topic("t2", "Ночная смена", 10 * MINUTE),
        topic("t3", "Отчёты", 15 * MINUTE),
    ];
    let questions = vec![
        question("q1", MINUTE + 30_000, "t1", "Кто принимает звонки?"),
        question("q2", 3 * MINUTE, "t1", "Сколько звонков в час пик?"),
        question("q3", 12 * MINUTE, "t2", "Кто дежурит ночью?"),
        question("q4", 13 * MINUTE, "t2", "Что делать с пропущенными ночью?"),
    ];
    let mut phrases = vec![phrase("p0", OTHERS, 30_000)];
    for (index, minute) in [4, 6, 8, 10].into_iter().enumerate() {
        phrases.push(phrase(&format!("a{index}"), OTHERS, minute * MINUTE));
        phrases.push(phrase(&format!("m{index}"), ME, minute * MINUTE + 20_000));
    }
    for (index, minute) in [14, 15, 16, 18, 20].into_iter().enumerate() {
        phrases.push(phrase(&format!("b{index}"), OTHERS, minute * MINUTE));
    }
    let mut report = report_with(topics, questions, phrases);
    report.calls = (1..=20)
        .map(|n| call(n * MINUTE, n * 1_000, 0.05, json!([])))
        .collect();
    let rejected = |reason: &str, subject: &str, quote: &str| json!({ "index": 0, "op": "question", "subject": subject, "reason": reason, "id": "s1", "quote": quote });
    report.calls[0].rejected = json!([
        rejected("quoteTooShort", "Сколько?", "нас"),
        rejected("quoteNotFound", "Первый", "его не было"),
    ]);
    report.calls[1].rejected = json!([
        rejected("quoteNotFound", "Второй", "и этого"),
        rejected("quoteNotFound", "Третий", "и того"),
        rejected("quoteNotFound", "Четвёртый", "тоже нет"),
    ]);
    report
}

fn judge(labels: &[(&str, Label)], covered: &[Option<&str>]) -> Judge {
    Judge {
        version: 1,
        corpus: "telemedia".to_owned(),
        model: "claude-sonnet-5-5".to_owned(),
        transcript: Pass::Live,
        parts: 1,
        labeled: true,
        error: None,
        labels: labels
            .iter()
            .map(|(id, label)| QuestionLabel {
                question_id: (*id).to_owned(),
                label: *label,
                reason: "Так сказал бы менеджер".to_owned(),
                segment_id: None,
            })
            .collect(),
        manager_questions: covered
            .iter()
            .enumerate()
            .map(|(index, by)| ManagerQuestion {
                segment_id: format!("m{index}"),
                at_ms: (index as i64 + 5) * MINUTE,
                text: "А кто отвечает?".to_owned(),
                covered_by: by.map(str::to_owned),
            })
            .collect(),
        dropped: Vec::new(),
        cost_usd: Some(0.1),
        duration_ms: 1_000,
    }
}

#[test]
fn the_longest_pause_needs_five_client_phrases() {
    let metrics = compute(&run(), None);
    // 3:00–12:00 is longer, but the client said 4 phrases there.
    assert_eq!(
        metrics.longest_pause,
        Some(Pause {
            from_ms: 13 * MINUTE,
            to_ms: 20 * MINUTE,
            client_phrases: 5,
        })
    );

    // A fifth client phrase makes 3:00–12:00 the longest.
    let mut report = run();
    report.phrases.push(phrase("a4", OTHERS, 11 * MINUTE));
    let pause = compute(&report, None).longest_pause.unwrap();
    assert_eq!((pause.from_ms, pause.to_ms), (3 * MINUTE, 12 * MINUTE));
    assert_eq!(pause.length_ms(), 9 * MINUTE);

    // Manager phrases don't count; no pause has five client phrases.
    let quiet = report_with(
        Vec::new(),
        Vec::new(),
        (1..=10)
            .map(|n| phrase(&format!("m{n}"), ME, n * MINUTE))
            .collect(),
    );
    assert_eq!(compute(&quiet, None).longest_pause, None);
}

/// Without questions the whole run is one pause, from `--from`.
#[test]
fn a_run_without_questions_is_one_pause_from_its_start() {
    let mut report = report_with(
        Vec::new(),
        Vec::new(),
        (40..=45)
            .map(|n| phrase(&format!("c{n}"), OTHERS, n * MINUTE))
            .collect(),
    );
    report.flags.from_min = Some(40.0);
    let metrics = compute(&report, None);
    assert_eq!(
        metrics.longest_pause,
        Some(Pause {
            from_ms: 40 * MINUTE,
            to_ms: 45 * MINUTE,
            client_phrases: 6,
        })
    );
    assert_eq!(metrics.span_ms, 5 * MINUTE);
    assert_eq!(metrics.per_ten_minutes, Some(0.0));
}

#[test]
fn the_first_question_of_each_topic() {
    let metrics = compute(&run(), None);
    let firsts: Vec<(&str, Option<i64>)> = metrics
        .first_questions
        .iter()
        .map(|first| (first.topic.as_str(), first.after_ms))
        .collect();
    assert_eq!(
        firsts,
        [
            ("Очередь", Some(30_000)),
            ("Ночная смена", Some(2 * MINUTE)),
            ("Отчёты", None),
        ]
    );
    // Nearest rank: the lower of two.
    assert_eq!(metrics.first_question_median_ms, Some(30_000));
    assert_eq!(metrics.topics, 3);
}

#[test]
fn coverage_and_label_shares_come_from_the_judge() {
    let report = run();
    assert_eq!(compute(&report, None).coverage, None);
    assert_eq!(compute(&report, None).labels, None);

    let judged = judge(
        &[
            ("q1", Label::WouldAsk),
            ("q2", Label::AlreadyAnswered),
            ("q3", Label::WouldAsk),
            ("q4", Label::Fabricated),
        ],
        &[Some("q1"), None, Some("q3")],
    );
    let metrics = compute(&report, Some(&judged));
    assert_eq!(
        metrics.coverage,
        Some(Coverage {
            covered: 2,
            total: 3
        })
    );
    let labels = metrics.labels.unwrap();
    assert_eq!(labels.labeled, 4);
    assert_eq!(labels.share(Label::WouldAsk), Some(0.5));
    assert_eq!(labels.share(Label::Fabricated), Some(0.25));
    assert_eq!(labels.share(Label::OffTopic), Some(0.0));

    // A question without a label is out of the shares.
    let partly = judge(&[("q1", Label::WouldAsk), ("q2", Label::OffTopic)], &[]);
    let labels = compute(&report, Some(&partly)).labels.unwrap();
    assert_eq!(labels.labeled, 2);
    assert_eq!(labels.share(Label::WouldAsk), Some(0.5));
    assert_eq!(
        compute(&report, Some(&partly)).coverage.unwrap().share(),
        None
    );

    // An unlabeled run has neither.
    let mut failed = judged;
    failed.labeled = false;
    assert_eq!(compute(&report, Some(&failed)).labels, None);
    assert_eq!(compute(&report, Some(&failed)).coverage, None);
}

#[test]
fn call_percentiles_tokens_and_cost() {
    let metrics = compute(&run(), None);
    let calls = &metrics.calls;
    assert_eq!(calls.count, 20);
    assert_eq!(calls.p50_ms, Some(10_000));
    assert_eq!(calls.p95_ms, Some(19_000));
    assert_eq!(calls.input_tokens, 20_000);
    assert_eq!(calls.output_tokens, 2_000);
    assert_eq!(calls.cache_read, 10_000);
    assert!((calls.cost_usd - 1.0).abs() < 1e-9);

    assert_eq!(percentile(&[], 0.5), None);
    assert_eq!(percentile(&[7], 0.95), Some(7));
    assert_eq!(percentile(&[5, 1, 3], 0.5), Some(3));
    assert_eq!(percentile(&[5, 1, 3], 0.95), Some(5));
}

#[test]
fn rejections_by_reason_with_three_examples() {
    let metrics = compute(&run(), None);
    assert_eq!(metrics.rejected_total(), 5);
    assert_eq!(metrics.rejected[0].reason, "quoteNotFound");
    assert_eq!(metrics.rejected[0].count, 4);
    assert_eq!(
        metrics.rejected[0].examples,
        [
            "question: Первый — «его не было»",
            "question: Второй — «и этого»",
            "question: Третий — «и того»",
        ]
    );
    assert_eq!(metrics.rejected[1].reason, "quoteTooShort");
    assert_eq!(metrics.per_ten_minutes, Some(2.0));
}

#[test]
fn the_markdown_has_the_header_the_metrics_and_the_questions() {
    let mut report = run();
    report.flags.from_min = Some(0.0);
    report.flags.to_min = Some(20.0);
    report.flags.baseline_state = true;
    let text = markdown(&report, None);
    for part in [
        "# Прогон telemedia — test",
        "- Набор: telemedia",
        "- Правила: sha256 abababababab (встроенные)",
        "- Флаги: --from 0 --to 20 --baseline-state",
        "- Прогон: завершён",
        "- Судья: не запускался",
        "| Показано вопросов | 4 |",
        "| Вопросов на 10 минут | 2.0 |",
        "| Доля полезных («задал бы») | — |",
        "| Самая длинная пауза (клиент ≥ 5 фраз) | 7:00 (13:00–20:00, фраз клиента 5) |",
        "| Вызов p50 | 10.0 с |",
        "| Стоимость | $1.00 |",
        "| Ночная смена | 10:00 | 2:00 |",
        "| Отчёты | 15:00 | — |",
        "- quoteNotFound: 4",
        "| 12:00 | Ночная смена | пользователи | empty | — | Кто дежурит ночью? |",
    ] {
        assert!(text.contains(part), "no «{part}» in\n{text}");
    }
    assert!(!text.contains("approximate"));

    report.channels = Channels::Approximate;
    report.complete = false;
    report.stopped = Some("Нужен вход в Claude Code".to_owned());
    let judged = judge(&[("q1", Label::WouldAsk)], &[Some("q1")]);
    let text = markdown(&report, Some(&judged));
    for part in [
        "**channels: approximate**",
        "- Прогон: **неполный** — Нужен вход в Claude Code",
        "| Доля полезных («задал бы») | 100% (1 из 1) |",
        "| Покрытие вопросов менеджера | 100% (1 из 1) |",
        "| задал бы | 1 | 100% |",
        "Без метки: 3.",
        "| 05:00 | А кто отвечает? | 01:30 «Кто принимает звонки?» |",
    ] {
        assert!(text.contains(part), "no «{part}» in\n{text}");
    }

    let mut unlabeled = judged;
    unlabeled.labeled = false;
    unlabeled.error = Some("Судья ответил не по схеме: labels".to_owned());
    let text = markdown(&report, Some(&unlabeled));
    assert!(
        text.contains("- Судья: **неразмечено** — Судья ответил не по схеме: labels"),
        "{text}"
    );
}

#[test]
fn an_empty_report_has_dashes() {
    let text = markdown(&report(), None);
    assert!(text.contains("| Показано вопросов | 0 |"), "{text}");
    assert!(text.contains("| Вызов p50 | — |"), "{text}");
    assert!(text.contains("Тем нет."), "{text}");
    assert!(text.contains("Показанных вопросов нет."), "{text}");
}

fn quoting(id: &str, at_ms: i64, segments: &[&str]) -> ReportQuestion {
    let mut question = question(id, at_ms, "t1", "Кто отвечает ночью?");
    question.evidence = segments
        .iter()
        .map(|segment| {
            let source = if segment.starts_with('G') {
                EvidenceSource::Project
            } else {
                EvidenceSource::Segment
            };
            crate::storage::call_state::Evidence {
                source,
                id: (*segment).to_owned(),
                quote: "звонки теряются в час пик".to_owned(),
            }
        })
        .collect();
    question
}

/// From the end of the last quoted phrase to when the question was shown.
#[test]
fn the_latency_runs_from_the_last_quoted_phrase() {
    let phrases = vec![
        phrase("s1", OTHERS, MINUTE),
        phrase("s2", OTHERS, 2 * MINUTE),
        phrase("s3", OTHERS, 3 * MINUTE),
    ];
    let mut waited = quoting("q3", 3 * MINUTE + 4_000, &["s3"]);
    // Added 4 s after its phrase, shown 20 s later behind a full list.
    waited.shown_at_ms = Some(3 * MINUTE + 24_000);
    let questions = vec![
        // Two phrases: from the later one, 2:00 → 2:06.
        quoting("q1", 2 * MINUTE + 6_000, &["s1", "s2"]),
        // Only a brief gap: no phrase to measure from.
        quoting("q2", 2 * MINUTE + 30_000, &["G1"]),
        waited,
    ];
    let report = report_with(vec![topic("t1", "Ночь", 0)], questions, phrases);
    let latency = compute(&report, None).latency.unwrap();
    assert_eq!(
        latency,
        Latency {
            p50_ms: 6_000,
            p90_ms: 24_000,
            late: 1,
            counted: 2,
        }
    );
    assert_eq!(latency.late_share(), Some(0.5));

    let text = markdown(&report, None);
    for part in [
        "| От фразы до вопроса, p50 | 6.0 с |",
        "| От фразы до вопроса, p90 | 24.0 с |",
        "| Позже 15 с после фразы | 50% (1 из 2) |",
    ] {
        assert!(text.contains(part), "no «{part}» in\n{text}");
    }

    let unquoted = report_with(
        vec![topic("t1", "Ночь", 0)],
        vec![quoting("q2", MINUTE, &["G1"])],
        vec![phrase("s1", OTHERS, MINUTE)],
    );
    assert_eq!(compute(&unquoted, None).latency, None);
}

/// «Затухание на длинном звонке»: questions only in the first third.
#[test]
fn the_pace_by_thirds_shows_the_fading() {
    let questions = (0..6)
        .map(|n| question(&format!("q{n}"), (n * 4 + 1) * MINUTE, "t1", "Кто?"))
        .collect();
    let phrases = (1..=75)
        .map(|n| phrase(&format!("c{n}"), OTHERS, n * MINUTE))
        .collect();
    let report = report_with(vec![topic("t1", "Бронь", 0)], questions, phrases);
    let metrics = compute(&report, None);
    assert_eq!(metrics.per_ten_minutes_by_third, Some([2.4, 0.0, 0.0]));
    let text = markdown(&report, None);
    for part in [
        "| Вопросов на 10 минут, 1-я треть | 2.4 |",
        "| Вопросов на 10 минут, 2-я треть | 0.0 |",
        "| Вопросов на 10 минут, 3-я треть | 0.0 |",
    ] {
        assert!(text.contains(part), "no «{part}» in\n{text}");
    }
    assert_eq!(
        compute(&report_with(Vec::new(), Vec::new(), Vec::new()), None).per_ten_minutes_by_third,
        None
    );
}

#[test]
fn topic_checks_are_counted_apart() {
    let mut report = run();
    report.calls[3].kind = CallKind::TopicCheck;
    report.calls[7].kind = CallKind::TopicCheck;
    let calls = compute(&report, None).calls;
    assert_eq!(calls.count, 20);
    assert_eq!(calls.topic_checks, 2);
    assert!((calls.topic_check_cost_usd - 0.1).abs() < 1e-9);
    assert!(markdown(&report, None).contains("| Вызовы проверки темы | 2 ($0.10) |"));
}

/// «Разговор после конца обсуждения»: 12 minutes off the project, without
/// questions, are not a pause.
#[test]
fn the_pause_and_the_pace_stop_at_the_end_of_the_discussion() {
    let questions = vec![
        question("q1", 50 * MINUTE, "t1", "Кто?"),
        question("q2", 53 * MINUTE, "t1", "Сколько?"),
    ];
    let phrases = (40..=76)
        .map(|n| phrase(&format!("c{n}"), OTHERS, n * MINUTE))
        .collect();
    let mut report = report_with(vec![topic("t1", "Бронь", 40 * MINUTE)], questions, phrases);
    report.flags.from_min = Some(40.0);
    let unmarked = compute(&report, None).longest_pause.unwrap();
    assert_eq!(
        (unmarked.from_ms, unmarked.to_ms),
        (53 * MINUTE, 76 * MINUTE)
    );

    report.discussion_end_ms = Some(63 * MINUTE + 45_000);
    let metrics = compute(&report, None);
    let pause = metrics.longest_pause.unwrap();
    assert_eq!(
        (pause.from_ms, pause.to_ms),
        (53 * MINUTE, 63 * MINUTE + 45_000)
    );
    assert_eq!(metrics.span_ms, 23 * MINUTE + 45_000);
    let text = markdown(&report, None);
    assert!(
        text.contains("- Конец обсуждения: 63:45 — пауза и вопросы на 10 минут считаются до него"),
        "{text}"
    );

    // A mark before the run's start does nothing.
    report.discussion_end_ms = Some(30 * MINUTE);
    assert_eq!(compute(&report, None).longest_pause, Some(unmarked));
    assert!(!markdown(&report, None).contains("Конец обсуждения"));
}
