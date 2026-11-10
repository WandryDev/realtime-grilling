//! The metrics of a replay (question-quality design.md, decision 5), from
//! `report.json` and, once the judge ran, `judge.json`; and `report.md`,
//! which shows them. `replay` writes `report.md`, `judge` rewrites it.
//!
//! - Only the questions that were shown count, from when they were first
//!   shown: one that waited behind a full list to the end of the run is
//!   listed apart in `report.md` and counts nowhere else.
//! - The longest pause is the longest stretch between new questions (from
//!   the run's start to the first, between two, from the last to the run's
//!   last phrase) in which the client said at least
//!   [`PAUSE_CLIENT_PHRASES`] phrases.
//! - The latency of a question is from the end of the last phrase it
//!   quotes to when it was first shown (question-volume, decision 5); a
//!   question that quotes no phrase has none.
//! - The pace by thirds splits the run's span in three equal parts.
//! - Percentiles are nearest-rank.

use std::{
    collections::{BTreeMap, HashMap},
    fmt::Write as _,
};

use serde_json::Value;

use super::{
    corpus::Channels,
    judge::{Judge, Label, Pass},
    report::{CallKind, Report, ReportQuestion},
};
use crate::storage::{call_state::EvidenceSource, transcript::TranscriptChannel};

/// A pause counts when the client said at least this many phrases in it.
pub const PAUSE_CLIENT_PHRASES: usize = 5;
/// A question shown later than this after its phrase counts as late.
pub const LATE_MS: i64 = 15_000;
/// Examples of a rejection reason or a label in `report.md`.
const EXAMPLES: usize = 3;
/// What a rules variant (`--rules`) leaves as it is, in `report.md`.
const NOT_IN_RULES: &str = "Не зависит от --rules: описание схемы патча (patch.schema.json, \
                            в том числе типов пробела) — одно для всех вариантов правил; \
                            пункты «Неясно до звонка» убирает только --no-gaps";

#[derive(Debug, Clone, PartialEq)]
pub struct Metrics {
    /// Questions that were shown.
    pub questions: usize,
    /// Questions the checks let through that were never shown.
    pub never_shown: usize,
    /// The run's span: from its start to its last phrase, ms.
    pub span_ms: i64,
    pub per_ten_minutes: Option<f64>,
    /// Questions per 10 minutes in each third of the span.
    pub per_ten_minutes_by_third: Option<[f64; 3]>,
    /// `None` without a shown question that quotes a phrase.
    pub latency: Option<Latency>,
    /// `None` until the judge labeled the run.
    pub labels: Option<LabelCounts>,
    /// `None` until the judge labeled the run.
    pub coverage: Option<Coverage>,
    /// Every topic, in order.
    pub first_questions: Vec<FirstQuestion>,
    /// Over the topics that got a question.
    pub first_question_median_ms: Option<i64>,
    pub longest_pause: Option<Pause>,
    pub topics: usize,
    /// By reason, the most frequent first.
    pub rejected: Vec<Rejected>,
    pub calls: Calls,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LabelCounts {
    pub labeled: usize,
    pub counts: BTreeMap<Label, usize>,
}

impl LabelCounts {
    pub fn count(&self, label: Label) -> usize {
        self.counts.get(&label).copied().unwrap_or(0)
    }

    /// Of the labeled questions, 0–1.
    pub fn share(&self, label: Label) -> Option<f64> {
        ratio(self.count(label), self.labeled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Coverage {
    pub covered: usize,
    pub total: usize,
}

impl Coverage {
    pub fn share(self) -> Option<f64> {
        ratio(self.covered, self.total)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirstQuestion {
    pub topic: String,
    pub topic_at_ms: i64,
    /// From the topic's start to its first question; `None` without one.
    pub after_ms: Option<i64>,
}

/// From the phrase a question quotes to the question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Latency {
    pub p50_ms: i64,
    pub p90_ms: i64,
    /// Shown later than [`LATE_MS`].
    pub late: usize,
    /// Questions with a phrase to measure from.
    pub counted: usize,
}

impl Latency {
    pub fn late_share(self) -> Option<f64> {
        ratio(self.late, self.counted)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pause {
    pub from_ms: i64,
    pub to_ms: i64,
    pub client_phrases: usize,
}

impl Pause {
    pub fn length_ms(self) -> i64 {
        self.to_ms - self.from_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub reason: String,
    pub count: usize,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Calls {
    pub count: usize,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost_usd: f64,
    /// Topic-check calls, counted in `count` and `cost_usd` too.
    pub topic_checks: usize,
    pub topic_check_cost_usd: f64,
}

impl Metrics {
    pub fn rejected_total(&self) -> usize {
        self.rejected.iter().map(|rejected| rejected.count).sum()
    }
}

// Counts and durations of a call: far from f64's precision limits.
#[allow(clippy::cast_precision_loss)]
fn ratio(part: usize, whole: usize) -> Option<f64> {
    (whole > 0).then(|| part as f64 / whole as f64)
}

/// The nearest-rank `p`-th percentile (0–1) of `values`.
pub fn percentile(values: &[i64], p: f64) -> Option<i64> {
    let mut sorted = values.to_vec();
    sorted.sort_unstable();
    if sorted.is_empty() {
        return None;
    }
    // A rank among a run's calls: small and positive.
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let rank = (p * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

/// Where the run starts, ms from the start of the call.
pub fn start_ms(report: &Report) -> i64 {
    // Minutes of a call: far from the limits of i64.
    #[allow(clippy::cast_possible_truncation)]
    report
        .flags
        .from_min
        .map_or(0, |minutes| (minutes * 60_000.0).round() as i64)
}

/// The corpus's end of the discussion, when it falls after the run's start.
pub fn discussion_end(report: &Report) -> Option<i64> {
    report
        .discussion_end_ms
        .filter(|mark| *mark > start_ms(report))
}

/// The metrics of `report`, with the judge's labels when it has them.
pub fn compute(report: &Report, judge: Option<&Judge>) -> Metrics {
    let start = start_ms(report);
    let shown: Vec<(&ReportQuestion, i64)> = report.shown().collect();
    let last_question = shown.iter().map(|(_, at)| *at).max();
    let run_end = report
        .run
        .last_fed_ms
        .into_iter()
        .chain(last_question)
        .max()
        .unwrap_or(start);
    let end = discussion_end(report).map_or(run_end, |mark| mark.min(run_end));
    let span_ms = (end - start).max(0);
    // The pace and the pause stop at the end of the discussion.
    let marks: Vec<i64> = shown
        .iter()
        .map(|(_, at)| *at)
        .filter(|at| *at <= end)
        .collect();
    #[allow(clippy::cast_precision_loss)]
    let per_ten_minutes = (span_ms > 0).then(|| marks.len() as f64 * 600_000.0 / span_ms as f64);

    let judged = judge.filter(|judge| judge.labeled);
    let labels = judged.map(|judge| {
        let mut counts = LabelCounts::default();
        for (question, _) in &shown {
            if let Some(label) = judge.label_of(&question.id) {
                counts.labeled += 1;
                *counts.counts.entry(label.label).or_default() += 1;
            }
        }
        counts
    });
    let coverage = judged.map(|judge| Coverage {
        covered: judge
            .manager_questions
            .iter()
            .filter(|question| question.covered_by.is_some())
            .count(),
        total: judge.manager_questions.len(),
    });

    let first_questions: Vec<FirstQuestion> = report
        .topics
        .iter()
        .map(|topic| FirstQuestion {
            topic: topic.title.clone(),
            topic_at_ms: topic.at_ms,
            after_ms: shown
                .iter()
                .filter(|(question, _)| question.topic_id.as_deref() == Some(topic.id.as_str()))
                .map(|(_, at)| (at - topic.at_ms).max(0))
                .min(),
        })
        .collect();
    let afters: Vec<i64> = first_questions.iter().filter_map(|f| f.after_ms).collect();
    let per_ten_minutes_by_third = by_thirds(&marks, start, span_ms);

    Metrics {
        questions: shown.len(),
        never_shown: report.never_shown().count(),
        span_ms,
        per_ten_minutes,
        per_ten_minutes_by_third,
        latency: latency(report, &shown),
        labels,
        coverage,
        first_question_median_ms: percentile(&afters, 0.5),
        first_questions,
        longest_pause: longest_pause(report, marks, start, end),
        topics: report.topics.len(),
        rejected: rejected(report),
        calls: calls(report),
    }
}

/// Questions per 10 minutes in each third of `[start, start + span_ms]`;
/// the last third keeps its end.
#[allow(clippy::cast_precision_loss)]
fn by_thirds(marks: &[i64], start: i64, span_ms: i64) -> Option<[f64; 3]> {
    if span_ms <= 0 {
        return None;
    }
    let mut counts = [0_usize; 3];
    for at in marks {
        let offset = (at - start).clamp(0, span_ms);
        // 3 * offset / span_ms is 0..=3; the end belongs to the last third.
        let third = usize::try_from(3 * offset / span_ms).unwrap_or(0).min(2);
        counts[third] += 1;
    }
    let third_ms = span_ms as f64 / 3.0;
    Some(counts.map(|count| count as f64 * 600_000.0 / third_ms))
}

/// `shown`: the shown questions with when they were first shown.
fn latency(report: &Report, shown: &[(&ReportQuestion, i64)]) -> Option<Latency> {
    let ends: HashMap<&str, i64> = report
        .phrases
        .iter()
        .map(|phrase| (phrase.id.as_str(), phrase.end_ms))
        .collect();
    let delays: Vec<i64> = shown
        .iter()
        .filter_map(|(question, shown_at)| {
            let phrase_end = question
                .evidence
                .iter()
                .filter(|evidence| evidence.source == EvidenceSource::Segment)
                .filter_map(|evidence| ends.get(evidence.id.as_str()).copied())
                .max()?;
            Some((shown_at - phrase_end).max(0))
        })
        .collect();
    Some(Latency {
        p50_ms: percentile(&delays, 0.5)?,
        p90_ms: percentile(&delays, 0.9)?,
        late: delays.iter().filter(|delay| **delay > LATE_MS).count(),
        counted: delays.len(),
    })
}

/// `marks`: when the shown questions were first shown.
fn longest_pause(report: &Report, mut marks: Vec<i64>, start: i64, end: i64) -> Option<Pause> {
    marks.sort_unstable();
    let bounds: Vec<i64> = std::iter::once(start)
        .chain(marks)
        .chain(std::iter::once(end))
        .collect();
    let client: Vec<i64> = report
        .phrases
        .iter()
        .filter(|phrase| phrase.channel == TranscriptChannel::Others)
        .map(|phrase| phrase.end_ms)
        .collect();
    bounds
        .windows(2)
        .enumerate()
        .map(|(index, pair)| {
            let (from_ms, to_ms) = (pair[0], pair[1]);
            // The run's first phrase may end right at its start.
            let after = |at: i64| {
                if index == 0 {
                    at >= from_ms
                } else {
                    at > from_ms
                }
            };
            Pause {
                from_ms,
                to_ms,
                client_phrases: client
                    .iter()
                    .filter(|at| after(**at) && **at <= to_ms)
                    .count(),
            }
        })
        .filter(|pause| pause.client_phrases >= PAUSE_CLIENT_PHRASES)
        .max_by_key(|pause| (pause.length_ms(), -pause.from_ms))
}

fn text_of(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|text| text.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|text| !text.is_empty())
}

fn rejected(report: &Report) -> Vec<Rejected> {
    let mut by_reason: BTreeMap<String, Rejected> = BTreeMap::new();
    let items = report
        .calls
        .iter()
        .filter_map(|call| call.rejected.as_array())
        .flatten();
    for item in items {
        let reason = text_of(item.get("reason")).unwrap_or_else(|| "?".to_owned());
        let mut example = text_of(item.get("op")).unwrap_or_else(|| "?".to_owned());
        if let Some(subject) = text_of(item.get("subject")) {
            let _ = write!(example, ": {subject}");
        }
        if let Some(quote) = text_of(item.get("quote")) {
            let _ = write!(example, " — «{quote}»");
        }
        let entry = by_reason.entry(reason.clone()).or_insert_with(|| Rejected {
            reason,
            count: 0,
            examples: Vec::new(),
        });
        entry.count += 1;
        if entry.examples.len() < EXAMPLES {
            entry.examples.push(example);
        }
    }
    let mut list: Vec<Rejected> = by_reason.into_values().collect();
    list.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));
    list
}

fn calls(report: &Report) -> Calls {
    let durations: Vec<i64> = report.calls.iter().map(|call| call.duration_ms).collect();
    let sum = |field: fn(&super::report::ReportCall) -> Option<i64>| {
        report.calls.iter().filter_map(field).sum()
    };
    Calls {
        count: report.calls.len(),
        p50_ms: percentile(&durations, 0.5),
        p95_ms: percentile(&durations, 0.95),
        input_tokens: sum(|call| call.input_tokens),
        output_tokens: sum(|call| call.output_tokens),
        cache_read: sum(|call| call.cache_read),
        cache_write: sum(|call| call.cache_write),
        cost_usd: report.calls.iter().filter_map(|call| call.cost_usd).sum(),
        topic_checks: report
            .calls
            .iter()
            .filter(|call| call.kind == CallKind::TopicCheck)
            .count(),
        topic_check_cost_usd: report
            .calls
            .iter()
            .filter(|call| call.kind == CallKind::TopicCheck)
            .filter_map(|call| call.cost_usd)
            // An empty sum of f64 is -0.0.
            .sum::<f64>()
            + 0.0,
    }
}

/* Formatting, shared with `compare` */

/// `m:ss`.
pub fn duration(ms: i64) -> String {
    let seconds = ms.abs() / 1000;
    let sign = if ms < 0 { "-" } else { "" };
    format!("{sign}{}:{:02}", seconds / 60, seconds % 60)
}

/// `mm:ss` from the start of the call.
pub fn clock(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

// Durations of a call: far from f64's precision limits.
#[allow(clippy::cast_precision_loss)]
pub fn seconds(ms: i64) -> String {
    format!("{:.1} с", ms as f64 / 1000.0)
}

pub fn percent(share: f64) -> String {
    format!("{:.0}%", share * 100.0)
}

fn or_dash(value: Option<String>) -> String {
    value.unwrap_or_else(|| "—".to_owned())
}

fn cell(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .replace('|', "\\|")
}

/// The lines about how the run was made, for `report.md` and `compare`.
pub fn header(report: &Report) -> Vec<String> {
    let mut lines = vec![
        format!("Набор: {}", report.corpus),
        format!("Метка: {}", report.label),
        format!(
            "Правила: sha256 {}{}",
            report
                .rules_sha256
                .get(..12)
                .unwrap_or(&report.rules_sha256),
            report
                .flags
                .rules_file
                .as_deref()
                .map_or_else(|| " (встроенные)".to_owned(), |file| format!(" ({file})"))
        ),
    ];
    let mut flags = Vec::new();
    if let Some(from) = report.flags.from_min {
        flags.push(format!("--from {from}"));
    }
    if let Some(to) = report.flags.to_min {
        flags.push(format!("--to {to}"));
    }
    if report.flags.realtime {
        flags.push("--realtime".to_owned());
    }
    if report.flags.baseline_state {
        flags.push("--baseline-state".to_owned());
    }
    if report.flags.no_gaps {
        flags.push("--no-gaps".to_owned());
    }
    if let Some(minutes) = report.flags.quiet_minutes {
        flags.push(format!("--quiet-minutes {minutes}"));
    }
    if let Some(seconds) = report.flags.min_gap_secs {
        flags.push(format!("--min-gap {seconds}"));
    }
    if let Some(minutes) = report.flags.requeue_minutes {
        flags.push(format!("--requeue-minutes {minutes}"));
    }
    if let Some(topic_check) = &report.flags.topic_check {
        flags.push(format!("--topic-check {topic_check}"));
    }
    lines.push(format!(
        "Флаги: {}",
        if flags.is_empty() {
            "нет".to_owned()
        } else {
            flags.join(" ")
        }
    ));
    if report.channels == Channels::Approximate {
        lines.push(
            "**channels: approximate** — каналы разделены приблизительно, сравнивать только \
             с такими же наборами"
                .to_owned(),
        );
    }
    if let Some(mark) = discussion_end(report) {
        lines.push(format!(
            "Конец обсуждения: {} — пауза и вопросы на 10 минут считаются до него",
            clock(mark)
        ));
    }
    lines.push(match (&report.complete, &report.stopped) {
        (true, _) => "Прогон: завершён".to_owned(),
        (false, Some(reason)) => format!("Прогон: **неполный** — {reason}"),
        (false, None) => "Прогон: **неполный**".to_owned(),
    });
    lines
}

fn judge_line(judge: Option<&Judge>) -> String {
    match judge {
        None => "Судья: не запускался (`grill-eval judge`)".to_owned(),
        Some(judge) if !judge.labeled => format!(
            "Судья: **неразмечено** — {}",
            judge.error.as_deref().unwrap_or("ответ не по схеме")
        ),
        Some(judge) => format!(
            "Судья: {}, расшифровка {}, частей {}, ${:.2}",
            judge.model,
            match judge.transcript {
                Pass::Refined => "уточнённая",
                Pass::Live => "живая",
            },
            judge.parts,
            judge.cost_usd.unwrap_or(0.0)
        ),
    }
}

/// `report.md`: the header, the metrics, the labels with examples, the
/// first questions of the topics, the rejections, the questions.
pub fn markdown(report: &Report, judge: Option<&Judge>) -> String {
    let metrics = compute(report, judge);
    let mut text = format!("# Прогон {} — {}\n\n", report.corpus, report.label);
    for line in header(report) {
        let _ = writeln!(text, "- {line}");
    }
    let _ = writeln!(text, "- {NOT_IN_RULES}");
    let _ = writeln!(
        text,
        "- Фраз подано: {} из {}, время прогона {}",
        report.run.segments_fed,
        report.run.segments,
        duration(report.run.wall_ms)
    );
    let _ = writeln!(text, "- {}", judge_line(judge));

    text.push_str("\n## Метрики\n\n| Метрика | Значение |\n|---|---|\n");
    for (name, value) in rows(&metrics) {
        let _ = writeln!(text, "| {name} | {} |", or_dash(value.map(|v| v.shown)));
    }

    if let (Some(judge), Some(labels)) = (judge, &metrics.labels) {
        text.push_str("\n## Метки судьи\n\n| Метка | Число | Доля |\n|---|---|---|\n");
        for label in Label::ALL {
            let _ = writeln!(
                text,
                "| {} | {} | {} |",
                label.title(),
                labels.count(label),
                or_dash(labels.share(label).map(percent))
            );
        }
        let unlabeled = metrics.questions - labels.labeled;
        if unlabeled > 0 {
            let _ = writeln!(text, "\nБез метки: {unlabeled}.");
        }
        for label in Label::ALL {
            let examples: Vec<String> = report
                .shown()
                .filter_map(|(question, shown_at)| {
                    let given = judge.label_of(&question.id)?;
                    (given.label == label).then(|| {
                        format!(
                            "- {} «{}» — {}",
                            clock(shown_at),
                            cell(&question.text),
                            cell(&given.reason)
                        )
                    })
                })
                .take(EXAMPLES)
                .collect();
            if !examples.is_empty() {
                let _ = write!(text, "\n{}:\n{}\n", label.title(), examples.join("\n"));
            }
        }
    }

    text.push_str("\n## Первый вопрос темы\n\n");
    if metrics.first_questions.is_empty() {
        text.push_str("Тем нет.\n");
    } else {
        text.push_str("| Тема | Создана | Первый вопрос через |\n|---|---|---|\n");
        for first in &metrics.first_questions {
            let _ = writeln!(
                text,
                "| {} | {} | {} |",
                cell(&first.topic),
                clock(first.topic_at_ms),
                or_dash(first.after_ms.map(duration))
            );
        }
    }

    text.push_str("\n## Отброшено проверкой\n\n");
    if metrics.rejected.is_empty() {
        text.push_str("Ничего.\n");
    }
    for rejected in &metrics.rejected {
        let _ = writeln!(text, "- {}: {}", rejected.reason, rejected.count);
        for example in &rejected.examples {
            let _ = writeln!(text, "  - {}", cell(example));
        }
    }

    text.push_str("\n## Вопросы\n\n");
    if metrics.questions == 0 {
        text.push_str("Показанных вопросов нет.\n");
    } else {
        text.push_str(
            "Время — когда вопрос впервые показан.\n\n\
             | Время | Тема | Поле | Тип | Метка | Вопрос |\n|---|---|---|---|---|---|\n",
        );
        for (question, shown_at) in report.shown() {
            let label = judge
                .and_then(|judge| judge.label_of(&question.id))
                .map_or("—", |label| label.label.title());
            let _ = writeln!(
                text,
                "| {} | {} | {} | {} | {label} | {} |",
                clock(shown_at),
                cell(question.topic.as_deref().unwrap_or("—")),
                question.card_field.map_or("—", |lens| lens.label()),
                question.gap_type.as_str(),
                cell(&question.text)
            );
        }
    }
    if metrics.never_shown > 0 {
        let _ = write!(
            text,
            "\n## Не показаны: {}\n\nПрошли проверку, но до конца прогона ждали за полным \
             списком. Судья их не размечает, в метриках их нет.\n\n\
             | Добавлен | Тема | Приоритет | Вопрос |\n|---|---|---|---|\n",
            metrics.never_shown
        );
        for question in report.never_shown() {
            let _ = writeln!(
                text,
                "| {} | {} | {} | {} |",
                clock(question.at_ms),
                cell(question.topic.as_deref().unwrap_or("—")),
                question.priority,
                cell(&question.text)
            );
        }
    }

    if let Some(judge) = judge.filter(|judge| judge.labeled) {
        text.push_str("\n## Вопросы менеджера\n\n");
        if judge.manager_questions.is_empty() {
            text.push_str("Нет.\n");
        } else {
            text.push_str("| Время | Вопрос | Предвиден вопросом |\n|---|---|---|\n");
            for question in &judge.manager_questions {
                let covered = question
                    .covered_by
                    .as_deref()
                    .and_then(|id| report.shown().find(|(q, _)| q.id == id))
                    .map_or_else(
                        || "—".to_owned(),
                        |(q, shown_at)| format!("{} «{}»", clock(shown_at), cell(&q.text)),
                    );
                let _ = writeln!(
                    text,
                    "| {} | {} | {covered} |",
                    clock(question.at_ms),
                    cell(&question.text)
                );
            }
        }
    }
    text
}

/// How a metric's value compares: what its difference looks like.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Count,
    Decimal,
    Share,
    Duration,
    Seconds,
    Money,
}

/// A metric's value: the number `compare` subtracts and what is shown.
#[derive(Debug, Clone, PartialEq)]
pub struct MetricValue {
    pub number: f64,
    pub kind: Kind,
    pub shown: String,
}

// Counts and durations of a call: far from f64's precision limits.
#[allow(clippy::cast_precision_loss)]
fn value(number: f64, kind: Kind, shown: String) -> Option<MetricValue> {
    Some(MetricValue {
        number,
        kind,
        shown,
    })
}

const THIRDS: [&str; 3] = [
    "Вопросов на 10 минут, 1-я треть",
    "Вопросов на 10 минут, 2-я треть",
    "Вопросов на 10 минут, 3-я треть",
];

/// The rows of the metrics table, in the order of decision 5.
#[allow(clippy::cast_precision_loss)]
pub fn rows(metrics: &Metrics) -> Vec<(&'static str, Option<MetricValue>)> {
    let share = |share: Option<f64>, detail: String| {
        share.and_then(|share| value(share, Kind::Share, format!("{} ({detail})", percent(share))))
    };
    let labels = metrics.labels.as_ref();
    let label_share = |label: Label| {
        labels.and_then(|labels| {
            share(
                labels.share(label),
                format!("{} из {}", labels.count(label), labels.labeled),
            )
        })
    };
    let calls = &metrics.calls;
    let latency = metrics.latency;
    let third = |index: usize| {
        (
            THIRDS[index],
            metrics.per_ten_minutes_by_third.and_then(|rates| {
                value(rates[index], Kind::Decimal, format!("{:.1}", rates[index]))
            }),
        )
    };
    vec![
        (
            "Показано вопросов",
            value(
                metrics.questions as f64,
                Kind::Count,
                metrics.questions.to_string(),
            ),
        ),
        (
            "Не показано (ждали за полным списком)",
            value(
                metrics.never_shown as f64,
                Kind::Count,
                metrics.never_shown.to_string(),
            ),
        ),
        (
            "Вопросов на 10 минут",
            metrics
                .per_ten_minutes
                .and_then(|rate| value(rate, Kind::Decimal, format!("{rate:.1}"))),
        ),
        third(0),
        third(1),
        third(2),
        (
            "От фразы до вопроса, p50",
            latency.and_then(|latency| {
                value(
                    latency.p50_ms as f64,
                    Kind::Seconds,
                    seconds(latency.p50_ms),
                )
            }),
        ),
        (
            "От фразы до вопроса, p90",
            latency.and_then(|latency| {
                value(
                    latency.p90_ms as f64,
                    Kind::Seconds,
                    seconds(latency.p90_ms),
                )
            }),
        ),
        (
            "Позже 15 с после фразы",
            latency.and_then(|latency| {
                share(
                    latency.late_share(),
                    format!("{} из {}", latency.late, latency.counted),
                )
            }),
        ),
        ("Доля полезных («задал бы»)", label_share(Label::WouldAsk)),
        ("Доля выдуманных", label_share(Label::Fabricated)),
        (
            "Покрытие вопросов менеджера",
            metrics.coverage.and_then(|coverage| {
                share(
                    coverage.share(),
                    format!("{} из {}", coverage.covered, coverage.total),
                )
            }),
        ),
        (
            "Первый вопрос темы, медиана",
            metrics
                .first_question_median_ms
                .and_then(|ms| value(ms as f64, Kind::Duration, duration(ms))),
        ),
        (
            "Самая длинная пауза (клиент ≥ 5 фраз)",
            metrics.longest_pause.and_then(|pause| {
                value(
                    pause.length_ms() as f64,
                    Kind::Duration,
                    format!(
                        "{} ({}–{}, фраз клиента {})",
                        duration(pause.length_ms()),
                        clock(pause.from_ms),
                        clock(pause.to_ms),
                        pause.client_phrases
                    ),
                )
            }),
        ),
        (
            "Темы",
            value(
                metrics.topics as f64,
                Kind::Count,
                metrics.topics.to_string(),
            ),
        ),
        (
            "Отброшено проверкой",
            value(
                metrics.rejected_total() as f64,
                Kind::Count,
                metrics.rejected_total().to_string(),
            ),
        ),
        (
            "Вызовы",
            value(calls.count as f64, Kind::Count, calls.count.to_string()),
        ),
        (
            "Вызовы проверки темы",
            value(
                calls.topic_checks as f64,
                Kind::Count,
                format!(
                    "{} (${:.2})",
                    calls.topic_checks, calls.topic_check_cost_usd
                ),
            ),
        ),
        (
            "Вызов p50",
            calls
                .p50_ms
                .and_then(|ms| value(ms as f64, Kind::Seconds, seconds(ms))),
        ),
        (
            "Вызов p95",
            calls
                .p95_ms
                .and_then(|ms| value(ms as f64, Kind::Seconds, seconds(ms))),
        ),
        (
            "Токены: вход / выход / кеш чтение / кеш запись",
            value(
                (calls.input_tokens + calls.output_tokens) as f64,
                Kind::Count,
                format!(
                    "{} / {} / {} / {}",
                    calls.input_tokens, calls.output_tokens, calls.cache_read, calls.cache_write
                ),
            ),
        ),
        (
            "Стоимость",
            value(
                calls.cost_usd,
                Kind::Money,
                format!("${:.2}", calls.cost_usd),
            ),
        ),
    ]
}

#[cfg(test)]
mod tests;
