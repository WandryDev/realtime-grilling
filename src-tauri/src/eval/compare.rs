//! `grill-eval compare <A> <B>`: two runs of one corpus side by side
//! (question-quality design.md, decision 5): the metrics as «A | B |
//! разница», and the questions that appeared in B or disappeared from A.
//!
//! Two questions are a pair when their texts are alike by trigrams
//! ([`TrigramSimilarity`], the threshold of the repeat check) and they are
//! about one topic. Topic ids differ between runs, so topics are matched by
//! their titles, alike by the same measure; a question whose topic has no
//! match in the other run (the agent named it otherwise) pairs by its text
//! alone. Pairs are taken best score first, each question once.

use std::fmt::Write as _;

use super::{
    judge::Judge,
    metrics::{self, Kind, MetricValue, clock, duration, percent},
    report::{Report, ReportQuestion, ReportTopic},
};
use crate::agent::fast_loop::similarity::{QuestionSimilarity, TrigramSimilarity};

/// `compare.md` in B's folder.
pub const COMPARE_FILE: &str = "compare.md";

/// One run: its report, the judge's labels if any, and where it lies.
pub struct Run<'a> {
    pub report: &'a Report,
    pub judge: Option<&'a Judge>,
    pub place: String,
}

/// The questions of A and B: paired, only in A, only in B.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Matched<'a> {
    pub pairs: Vec<(&'a ReportQuestion, &'a ReportQuestion)>,
    pub disappeared: Vec<&'a ReportQuestion>,
    pub appeared: Vec<&'a ReportQuestion>,
}

fn topic_of<'a>(report: &'a Report, question: &ReportQuestion) -> Option<&'a ReportTopic> {
    let id = question.topic_id.as_deref()?;
    report.topics.iter().find(|topic| topic.id == id)
}

/// Pairs the shown questions of `a` and `b` (the never shown count nowhere,
/// as in the metrics).
pub fn match_questions<'a>(a: &'a Report, b: &'a Report) -> Matched<'a> {
    let shown = |report: &'a Report| -> Vec<&'a ReportQuestion> {
        report.shown().map(|(question, _)| question).collect()
    };
    let (questions_a, questions_b) = (shown(a), shown(b));
    let similarity = TrigramSimilarity::default();
    let alike = |x: &str, y: &str| similarity.score(x, y) >= similarity.threshold();
    let has_match = |topic: &ReportTopic, other: &Report| {
        other
            .topics
            .iter()
            .any(|them| alike(&topic.title, &them.title))
    };
    let same_topic =
        |qa: &ReportQuestion, qb: &ReportQuestion| match (topic_of(a, qa), topic_of(b, qb)) {
            (Some(ta), Some(tb)) => {
                alike(&ta.title, &tb.title) || !has_match(ta, b) || !has_match(tb, a)
            }
            _ => true,
        };
    let mut candidates: Vec<(f64, usize, usize)> = Vec::new();
    for (i, qa) in questions_a.iter().enumerate() {
        for (j, qb) in questions_b.iter().enumerate() {
            let score = similarity.score(&qa.text, &qb.text);
            if score >= similarity.threshold() && same_topic(qa, qb) {
                candidates.push((score, i, j));
            }
        }
    }
    candidates.sort_by(|x, y| y.0.total_cmp(&x.0).then((x.1, x.2).cmp(&(y.1, y.2))));
    let (mut used_a, mut used_b) = (
        vec![false; questions_a.len()],
        vec![false; questions_b.len()],
    );
    let mut pairs = Vec::new();
    for (_, i, j) in candidates {
        if !used_a[i] && !used_b[j] {
            used_a[i] = true;
            used_b[j] = true;
            pairs.push((questions_a[i], questions_b[j]));
        }
    }
    pairs.sort_by_key(|(qa, _)| shown_at(qa));
    let unused = |questions: Vec<&'a ReportQuestion>, used: Vec<bool>| {
        questions
            .into_iter()
            .zip(used)
            .filter(|(_, used)| !used)
            .map(|(question, _)| question)
            .collect()
    };
    Matched {
        pairs,
        disappeared: unused(questions_a, used_a),
        appeared: unused(questions_b, used_b),
    }
}

/// When a shown question was first shown.
fn shown_at(question: &ReportQuestion) -> i64 {
    question.shown_at_ms.unwrap_or(question.at_ms)
}

/// How the runs were made differently: the span, the flags, the rules.
/// Informational: one of them is usually what is compared, the others make
/// the numbers less comparable.
fn differences(a: &Report, b: &Report) -> Vec<String> {
    let mut found = Vec::new();
    let minutes = |value: Option<f64>| value.map_or_else(|| "—".to_owned(), |v| v.to_string());
    if a.flags.from_min != b.flags.from_min || a.flags.to_min != b.flags.to_min {
        found.push(format!(
            "отрезки звонка разные: A {}–{}, B {}–{} мин",
            minutes(a.flags.from_min),
            minutes(a.flags.to_min),
            minutes(b.flags.from_min),
            minutes(b.flags.to_min)
        ));
    }
    let switch = |on: bool| if on { "да" } else { "нет" };
    for (name, in_a, in_b) in [
        ("--realtime", a.flags.realtime, b.flags.realtime),
        (
            "--baseline-state",
            a.flags.baseline_state,
            b.flags.baseline_state,
        ),
        ("--no-gaps", a.flags.no_gaps, b.flags.no_gaps),
    ] {
        if in_a != in_b {
            found.push(format!("{name}: A {}, B {}", switch(in_a), switch(in_b)));
        }
    }
    if a.rules_sha256 != b.rules_sha256 {
        found.push("правила разные (sha256 в заголовках)".to_owned());
    }
    found
}

/// B minus A as the metric shows it.
fn difference(a: &MetricValue, b: &MetricValue) -> String {
    let delta = b.number - a.number;
    let sign = if delta > 0.0 { "+" } else { "" };
    // Differences of counts and durations: far from the limits of i64.
    #[allow(clippy::cast_possible_truncation)]
    let whole = delta.round() as i64;
    match a.kind {
        Kind::Count => format!("{sign}{whole}"),
        Kind::Decimal => format!("{sign}{delta:.1}"),
        Kind::Share => format!("{sign}{:.0} п.п.", delta * 100.0),
        Kind::Duration => format!("{sign}{}", duration(whole)),
        Kind::Seconds => format!("{sign}{:.1} с", delta / 1000.0),
        Kind::Money => format!(
            "{}${:.2}",
            if delta < 0.0 { "-" } else { sign },
            delta.abs()
        ),
    }
}

fn question_line(report: &Report, question: &ReportQuestion, judge: Option<&Judge>) -> String {
    let topic = topic_of(report, question).map_or("—", |topic| topic.title.as_str());
    let label = judge
        .and_then(|judge| judge.label_of(&question.id))
        .map(|label| format!(" [{}]", label.label.title()))
        .unwrap_or_default();
    format!(
        "- {} «{}» — {}{label}",
        clock(shown_at(question)),
        topic,
        question
            .text
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    )
}

/// `compare.md`: who is compared, the table, the questions.
pub fn markdown(a: &Run<'_>, b: &Run<'_>) -> String {
    let mut text = String::from("# Сравнение прогонов\n\n");
    for (name, run) in [("A", a), ("B", b)] {
        let _ = writeln!(text, "**{name}** — {}", run.place);
        for line in metrics::header(run.report) {
            let _ = writeln!(text, "- {line}");
        }
        let judged = match run.judge {
            Some(judge) if judge.labeled => "размечено",
            Some(_) => "**неразмечено**",
            None => "не запускался",
        };
        let _ = writeln!(text, "- Судья: {judged}\n");
    }
    if a.report.corpus != b.report.corpus {
        text.push_str("**Внимание:** прогоны разных наборов, сравнение не имеет смысла.\n\n");
    }
    if a.report.channels != b.report.channels {
        text.push_str(
            "**Внимание:** у одного набора каналы настоящие, у другого приблизительные.\n\n",
        );
    }
    let differences = differences(a.report, b.report);
    if !differences.is_empty() {
        text.push_str(
            "**Для сведения:** прогоны отличаются; всё, кроме того, что сравнивается, \
             делает цифры хуже сравнимыми.\n\n",
        );
        for difference in differences {
            let _ = writeln!(text, "- {difference}");
        }
        text.push('\n');
    }

    let (ma, mb) = (
        metrics::compute(a.report, a.judge),
        metrics::compute(b.report, b.judge),
    );
    text.push_str("| Метрика | A | B | разница |\n|---|---|---|---|\n");
    for ((name, va), (_, vb)) in metrics::rows(&ma).into_iter().zip(metrics::rows(&mb)) {
        let shown = |value: &Option<MetricValue>| {
            value
                .as_ref()
                .map_or_else(|| "—".to_owned(), |value| value.shown.clone())
        };
        let diff = match (&va, &vb) {
            (Some(va), Some(vb)) => difference(va, vb),
            _ => "—".to_owned(),
        };
        let _ = writeln!(
            text,
            "| {name} | {} | {} | {diff} |",
            shown(&va),
            shown(&vb)
        );
    }

    let matched = match_questions(a.report, b.report);
    let _ = write!(
        text,
        "\n## Вопросы\n\nПар: {} (похожесть по триграммам от {}).\n",
        matched.pairs.len(),
        percent(TrigramSimilarity::DEFAULT_THRESHOLD)
    );
    text.push_str("\n### Появились (есть в B, нет в A)\n\n");
    if matched.appeared.is_empty() {
        text.push_str("Нет.\n");
    }
    for question in &matched.appeared {
        let _ = writeln!(text, "{}", question_line(b.report, question, b.judge));
    }
    text.push_str("\n### Пропали (были в A, нет в B)\n\n");
    if matched.disappeared.is_empty() {
        text.push_str("Нет.\n");
    }
    for question in &matched.disappeared {
        let _ = writeln!(text, "{}", question_line(a.report, question, a.judge));
    }
    if !matched.pairs.is_empty() {
        text.push_str("\n### Пары\n\n");
        for (qa, qb) in &matched.pairs {
            let _ = writeln!(
                text,
                "{}\n  {}",
                question_line(a.report, qa, a.judge),
                question_line(b.report, qb, b.judge).replacen("- ", "→ ", 1)
            );
        }
    }
    text
}

#[cfg(test)]
mod tests;
