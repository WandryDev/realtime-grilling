//! The judge against a fake `claude` that records what it was given and
//! plays `stream-json` lines (in the manner of
//! `summary/fake_cli_tests.rs`): `specs/question-replay` «Разметка судьёй».

use serde_json::json;

use super::*;
use crate::eval::{
    metrics,
    testing::{
        ME, MINUTE, OTHERS, block_on, corpus, fake::Fake, phrase, question, report_with, segment,
        topic,
    },
};

trait Judged {
    fn judge(&self, corpus: &Corpus, report: &Report) -> Judge;
}

impl Judged for Fake {
    fn judge(&self, corpus: &Corpus, report: &Report) -> Judge {
        let prompts = self.path().join("prompts");
        block_on(run(corpus, report, self.agent(), &prompts)).unwrap()
    }
}

/// A call about the queue: the client says at 2:00 who answers calls; the
/// agent asks it at 4:00, and about the channels; the manager asks about
/// the channels at 6:00.
fn call() -> (Corpus, Report) {
    let corpus = corpus(vec![
        segment("s1", OTHERS, MINUTE, "Звонки теряются в час пик"),
        segment(
            "s2",
            OTHERS,
            2 * MINUTE,
            "Звонки принимают администраторы клиник",
        ),
        segment("s3", ME, 5 * MINUTE, "Понятно"),
        segment(
            "s4",
            ME,
            6 * MINUTE,
            "А через какие каналы пациенты к вам обращаются?",
        ),
        segment("s5", OTHERS, 7 * MINUTE, "Телефон и Telegram"),
    ]);
    let report = report_with(
        vec![topic("t1", "Очередь звонков", MINUTE)],
        vec![
            question("q1", 4 * MINUTE, "t1", "Кто принимает звонки в клиниках?"),
            question(
                "q2",
                4 * MINUTE + 5_000,
                "t1",
                "Через какие каналы обращаются пациенты?",
            ),
        ],
        corpus
            .live
            .iter()
            .map(|segment| phrase(&segment.id, segment.channel, segment.end_ms))
            .collect(),
    );
    (corpus, report)
}

/// «Вопрос об уже сказанном»: the judge marks it answered and cites the
/// phrase with the answer; the call had the transcript, the project and
/// the questions.
#[test]
fn a_question_about_what_was_said_is_already_answered() {
    let (corpus, report) = call();
    let fake = Fake::new(&[json!({
        "labels": [
            { "questionId": "q1", "label": "already_answered",
              "reason": "Клиент сказал это на 2-й минуте", "segmentId": "s2" },
            { "questionId": "Q:q2", "label": "would_ask", "reason": "Каналов не называли", "segmentId": null },
        ],
        "managerQuestions": [],
    })]);
    let judge = fake.judge(&corpus, &report);

    assert_eq!(fake.runs(), 1);
    assert!(judge.labeled, "{judge:?}");
    assert_eq!(
        judge.label_of("q1"),
        Some(&QuestionLabel {
            question_id: "q1".to_owned(),
            label: Label::AlreadyAnswered,
            reason: "Клиент сказал это на 2-й минуте".to_owned(),
            segment_id: Some("s2".to_owned()),
        })
    );
    assert_eq!(judge.label_of("q2").unwrap().label, Label::WouldAsk);
    assert_eq!(judge.transcript, Pass::Live);
    assert_eq!(judge.cost_usd, Some(0.12));

    let stdin = fake.read("stdin-1");
    for part in [
        "Название: Телемедиа",
        "Описание: Единая система приёма звонков для сети клиник",
        "- Клиники теряют до половины звонков пациентов",
        "- (пользователи) Не сказано, кто принимает звонки ночью",
        "Прогон охватил отрезок звонка 00:00–07:02.",
        "[Q:q1] 04:00 тема «Очередь звонков», поле users (пользователи), тип empty\n  Вопрос: Кто принимает звонки в клиниках?",
        "Основание: S:seg «звонки теряются в час пик»",
        "[S:s2] 02:00 Клиент: Звонки принимают администраторы клиник",
        "[S:s4] 06:00 Менеджер: А через какие каналы пациенты к вам обращаются?",
    ] {
        assert!(stdin.contains(part), "no «{part}» in\n{stdin}");
    }
    let args = fake.read("args-1");
    for arg in ["claude-sonnet-5-5", "medium", "\"managerQuestions\""] {
        assert!(args.contains(arg), "no {arg} in {args:?}");
    }

    let found = metrics::compute(&report, Some(&judge));
    assert_eq!(found.labels.unwrap().share(Label::WouldAsk), Some(0.5));
}

/// «Вопрос менеджера предвиден»: the agent asked about the channels at
/// 4:00, the manager at 6:00 — covered; a «covering» question shown after
/// the manager's isn't.
#[test]
fn a_manager_question_the_agent_foresaw_is_covered() {
    let (corpus, mut report) = call();
    report
        .questions
        .push(question("q3", 8 * MINUTE, "t1", "Отвечаете ли вы ночью?"));
    let fake = Fake::new(&[json!({
        "labels": [
            { "questionId": "q1", "label": "would_ask", "reason": "Важно", "segmentId": null },
            { "questionId": "q2", "label": "would_ask", "reason": "Важно", "segmentId": null },
            { "questionId": "q3", "label": "off_topic", "reason": "Не о том", "segmentId": null },
        ],
        "managerQuestions": [
            { "segmentId": "S:s4", "coveredBy": "q2" },
            { "segmentId": "s4", "coveredBy": null },
        ],
    })]);
    let judge = fake.judge(&corpus, &report);
    assert_eq!(
        judge.manager_questions,
        [ManagerQuestion {
            segment_id: "s4".to_owned(),
            at_ms: 6 * MINUTE,
            text: "А через какие каналы пациенты к вам обращаются?".to_owned(),
            covered_by: Some("q2".to_owned()),
        }]
    );
    let coverage = metrics::compute(&report, Some(&judge)).coverage.unwrap();
    assert_eq!((coverage.covered, coverage.total), (1, 1));

    let late = Fake::new(&[json!({
        "labels": [],
        "managerQuestions": [{ "segmentId": "s4", "coveredBy": "q3" }],
    })]);
    let judge = late.judge(&corpus, &report);
    assert_eq!(judge.manager_questions[0].covered_by, None);
    assert!(
        judge
            .dropped
            .iter()
            .any(|why| why.contains("q3 появился позже")),
        "{:?}",
        judge.dropped
    );
}

/// A label of an unknown question or segment is dropped and the question
/// stays unlabeled; so is a «manager question» that is the client's.
#[test]
fn a_label_with_an_unknown_id_is_dropped() {
    let (corpus, report) = call();
    let fake = Fake::new(&[json!({
        "labels": [
            { "questionId": "q-none", "label": "would_ask", "reason": "?", "segmentId": null },
            { "questionId": "q1", "label": "already_answered", "reason": "?", "segmentId": "s-none" },
            { "questionId": "q2", "label": "would_ask", "reason": "Важно", "segmentId": null },
            { "questionId": "q2", "label": "duplicate", "reason": "Второй раз", "segmentId": null },
        ],
        "managerQuestions": [
            { "segmentId": "s5", "coveredBy": null },
            { "segmentId": "s-none", "coveredBy": null },
            { "segmentId": "s4", "coveredBy": "q-none" },
        ],
    })]);
    let judge = fake.judge(&corpus, &report);
    assert!(judge.labeled);
    assert_eq!(judge.label_of("q1"), None);
    assert_eq!(judge.label_of("q2").unwrap().label, Label::WouldAsk);
    assert_eq!(judge.labels.len(), 1);
    let managers: Vec<(&str, Option<&str>)> = judge
        .manager_questions
        .iter()
        .map(|m| (m.segment_id.as_str(), m.covered_by.as_deref()))
        .collect();
    assert_eq!(managers, [("s4", None)]);
    assert_eq!(judge.dropped.len(), 6, "{:?}", judge.dropped);

    let labels = metrics::compute(&report, Some(&judge)).labels.unwrap();
    assert_eq!(labels.labeled, 1);
}

/// A reply not by the schema: the run is unlabeled, with the error, and
/// the judge doesn't fail.
#[test]
fn a_reply_not_by_the_schema_leaves_the_run_unlabeled() {
    let (corpus, report) = call();
    let fake = Fake::new(&[json!({ "labels": "все хорошие" })]);
    let judge = fake.judge(&corpus, &report);
    assert!(!judge.labeled);
    assert!(
        judge
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("Судья ответил не по схеме")),
        "{judge:?}"
    );
    assert!(judge.labels.is_empty());
    assert_eq!(metrics::compute(&report, Some(&judge)).labels, None);
    let text = metrics::markdown(&report, Some(&judge));
    assert!(text.contains("**неразмечено**"), "{text}");

    let unknown_label = Fake::new(&[json!({
        "labels": [{ "questionId": "q1", "label": "great", "reason": "?", "segmentId": null }],
        "managerQuestions": [],
    })]);
    assert!(!unknown_label.judge(&corpus, &report).labeled);
}

/// The refined pass is judged when it covers 90 % of the live one.
#[test]
fn the_refined_pass_when_it_covers_the_live_one() {
    let (mut corpus, _) = call();
    corpus.refined = Some(vec![segment("r1", OTHERS, 6 * MINUTE + 30_000, "Звонки")]);
    assert_eq!(transcript(&corpus).0, Pass::Refined);
    corpus.refined = Some(vec![segment("r1", OTHERS, 5 * MINUTE, "Звонки")]);
    assert_eq!(transcript(&corpus).0, Pass::Live);
    corpus.refined = Some(Vec::new());
    assert_eq!(transcript(&corpus).0, Pass::Live);
}

/// A call over the limit goes in 30-minute parts every 25 minutes; each
/// question is labeled once, in its first part, and the manager questions
/// merge by segment id.
#[test]
fn a_long_call_goes_in_parts_and_merges() {
    // 61 minutes, a client phrase of 2 500 characters every minute.
    let long = "очередь ".repeat(312);
    let mut live: Vec<Segment> = (0..=60)
        .map(|minute| segment(&format!("c{minute}"), OTHERS, minute * MINUTE, &long))
        .collect();
    live.push(segment(
        "m27",
        ME,
        27 * MINUTE + 10_000,
        "А кто отвечает ночью?",
    ));
    let corpus = corpus(live);
    assert_eq!(
        parts(&corpus.live),
        [
            0..30 * MINUTE,
            25 * MINUTE..55 * MINUTE,
            50 * MINUTE..80 * MINUTE
        ]
    );
    let whole = 0..i64::MAX;
    assert_eq!(parts(&corpus.live[..5]), vec![whole]);

    let report = report_with(
        vec![topic("t1", "Очередь", 0)],
        vec![
            question("q1", 26 * MINUTE, "t1", "Кто дежурит ночью?"),
            question("q2", 57 * MINUTE, "t1", "Сколько звонков ночью?"),
        ],
        corpus
            .live
            .iter()
            .map(|segment| phrase(&segment.id, segment.channel, segment.end_ms))
            .collect(),
    );
    let fake = Fake::new(&[
        json!({
            "labels": [{ "questionId": "q1", "label": "would_ask", "reason": "Важно", "segmentId": null }],
            "managerQuestions": [{ "segmentId": "m27", "coveredBy": null }],
        }),
        json!({
            // q1 belongs to the first part: its label here is dropped.
            "labels": [{ "questionId": "q1", "label": "off_topic", "reason": "?", "segmentId": null }],
            "managerQuestions": [{ "segmentId": "m27", "coveredBy": "q1" }],
        }),
        json!({
            "labels": [{ "questionId": "q2", "label": "duplicate", "reason": "Как q1", "segmentId": null }],
            "managerQuestions": [],
        }),
    ]);
    let judge = fake.judge(&corpus, &report);
    assert_eq!(fake.runs(), 3);
    assert_eq!(judge.parts, 3);
    assert_eq!(judge.label_of("q1").unwrap().label, Label::WouldAsk);
    assert_eq!(judge.label_of("q2").unwrap().label, Label::Duplicate);
    assert_eq!(judge.manager_questions.len(), 1);
    assert_eq!(judge.manager_questions[0].covered_by.as_deref(), Some("q1"));
    assert!((judge.cost_usd.unwrap() - 0.36).abs() < 1e-9);

    let second = fake.read("stdin-2");
    assert!(second.contains("Это часть 2 из 3: расшифровка с 25:00 по 55:00."));
    assert!(
        second.contains("# Вопросы для разметки\n\nНет."),
        "{second}"
    );
    assert!(second.contains("# Вопросы, показанные раньше этой части"));
    assert!(second.contains("[S:c25]") && !second.contains("[S:c24]"));
    assert!(fake.read("stdin-3").contains("[Q:q2] 57:00"));
}
