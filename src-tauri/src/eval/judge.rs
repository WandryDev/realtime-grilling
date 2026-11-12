//! `grill-eval judge`: an LLM judge labels the questions a replay showed
//! and finds the manager's own questions (question-quality design.md,
//! decision 4). One Claude Code call per call of the corpus, with the
//! whole transcript (the refined pass when it covers the live one), the
//! project with its brief and the run's questions.
//!
//! Only the questions that were shown go to the judge, with the time they
//! were first shown («время появления»); one that waited behind a full list
//! to the end is neither labeled nor a cover.
//!
//! The code checks what the judge cites: a label of an unknown question or
//! segment is dropped (the question stays unlabeled), and so is
//! `already_answered` without the segment of the answer said before the
//! question was shown; a manager question must be a «Я» segment of the
//! run's span, and the agent question that covers it must have been shown
//! before it. The judge reads the run's span and [`CONTEXT_MS`] before it;
//! when that is over [`PART_LIMIT_CHARS`], it goes in 30-minute parts every
//! 25 minutes; each question is labeled in the first part that holds it,
//! and the manager questions of all parts merge by segment id. A reply not
//! by the schema, or a failed call after the first part, leaves the run
//! unlabeled (`labeled: false` with the error and the cost so far) instead
//! of failing.

use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
    ops::Range,
    path::Path,
    sync::{Arc, LazyLock},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use super::{
    corpus::{Corpus, Segment},
    report::{Report, ReportQuestion},
};
use crate::{
    agent::{
        claude_cli::{Agent, AgentError, AgentRequest, CallOptions, OutputKind},
        fast_loop::assembly,
        process::TreeSlot,
    },
    storage::{call_state::EvidenceSource, transcript::TranscriptChannel},
};

/// The full name: an alias may move to another model.
pub const MODEL: &str = "claude-sonnet-5-5";
pub const EFFORT: &str = "medium";
/// A long call takes the judge a while.
pub const TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// The judge's labels next to `report.json`.
pub const JUDGE_FILE: &str = "judge.json";
/// The version of `judge.json`.
pub const FORMAT: u32 = 1;
/// A transcript longer than this (its lines, in characters) goes in parts.
pub const PART_LIMIT_CHARS: usize = 150_000;
/// A part of a long transcript, and how much the next one repeats of it.
pub const PART_MS: i64 = 30 * 60_000;
pub const OVERLAP_MS: i64 = 5 * 60_000;
/// How much of the call before the run's span the judge reads, for what
/// was already said.
pub const CONTEXT_MS: i64 = 5 * 60_000;
/// The refined pass is judged when it lasts at least this share of the
/// live one (the second pass may not have finished).
const REFINED_SHARE: f64 = 0.9;

const PROMPT: &str = include_str!("judge_prompt.md");
const SCHEMA: &str = include_str!("judge.schema.json");

/// [`SCHEMA`] on one line, as `--json-schema` takes it.
fn schema_argument() -> &'static str {
    static MINIFIED: LazyLock<String> = LazyLock::new(|| {
        let schema: Value = serde_json::from_str(SCHEMA).expect("judge.schema.json is valid JSON");
        schema.to_string()
    });
    &MINIFIED
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Label {
    WouldAsk,
    OffTopic,
    AlreadyAnswered,
    Fabricated,
    Duplicate,
}

impl Label {
    pub const ALL: [Self; 5] = [
        Self::WouldAsk,
        Self::OffTopic,
        Self::AlreadyAnswered,
        Self::Fabricated,
        Self::Duplicate,
    ];

    /// As the reports name it.
    pub fn title(self) -> &'static str {
        match self {
            Self::WouldAsk => "задал бы",
            Self::OffTopic => "не по теме",
            Self::AlreadyAnswered => "уже отвечено",
            Self::Fabricated => "выдумано",
            Self::Duplicate => "повтор",
        }
    }
}

/// Which pass the judge read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Pass {
    Refined,
    Live,
}

/// `judge.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Judge {
    pub version: u32,
    pub corpus: String,
    pub model: String,
    pub transcript: Pass,
    /// How many calls the transcript took.
    pub parts: usize,
    /// `false` when a reply was not by the schema or a later part failed:
    /// then nothing counts as labeled and `error` says why (`labels` may
    /// keep what the earlier parts gave, for a look).
    pub labeled: bool,
    pub error: Option<String>,
    pub labels: Vec<QuestionLabel>,
    /// In transcript order.
    pub manager_questions: Vec<ManagerQuestion>,
    /// What the checks dropped from the replies, and why.
    pub dropped: Vec<String>,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionLabel {
    pub question_id: String,
    pub label: Label,
    pub reason: String,
    pub segment_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerQuestion {
    pub segment_id: String,
    /// The segment's start, ms from the start of the call.
    pub at_ms: i64,
    pub text: String,
    /// The agent question shown before it that asks the same.
    pub covered_by: Option<String>,
}

impl Judge {
    /// The label of `question_id`, if it has one and the run is labeled.
    pub fn label_of(&self, question_id: &str) -> Option<&QuestionLabel> {
        if !self.labeled {
            return None;
        }
        self.labels
            .iter()
            .find(|label| label.question_id == question_id)
    }
}

/* The reply */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reply {
    labels: Vec<ReplyLabel>,
    manager_questions: Vec<ReplyManager>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplyLabel {
    question_id: String,
    label: Label,
    reason: String,
    #[serde(default)]
    segment_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplyManager {
    segment_id: String,
    #[serde(default)]
    covered_by: Option<String>,
}

/// `S:x`, `[Q:x]` → `x`.
fn bare(id: &str) -> String {
    let id = id.trim().trim_start_matches('[').trim_end_matches(']');
    let id = id
        .strip_prefix("S:")
        .or_else(|| id.strip_prefix("Q:"))
        .unwrap_or(id);
    id.trim().to_owned()
}

/* The input */

/// The transcript the judge reads: the refined pass when it lasts at least
/// [`REFINED_SHARE`] of the live one, else the live pass.
pub fn transcript(corpus: &Corpus) -> (Pass, &[Segment]) {
    let end = |segments: &[Segment]| segments.iter().map(|s| s.end_ms).max().unwrap_or(0);
    // Durations of a call: far from f64's precision limits.
    #[allow(clippy::cast_precision_loss)]
    let covers = |refined: &[Segment]| {
        !refined.is_empty() && end(refined) as f64 >= REFINED_SHARE * end(&corpus.live) as f64
    };
    match corpus.refined.as_deref() {
        Some(refined) if covers(refined) => (Pass::Refined, refined),
        _ => (Pass::Live, &corpus.live),
    }
}

/// `mm:ss` from the start of the call.
fn clock(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn speaker(channel: TranscriptChannel) -> &'static str {
    match channel {
        TranscriptChannel::Me => "Менеджер",
        TranscriptChannel::Others => "Клиент",
    }
}

fn segment_line(segment: &Segment) -> String {
    format!(
        "[S:{}] {} {}: {}\n",
        one_line(&segment.id),
        clock(segment.start_ms),
        speaker(segment.channel),
        one_line(&segment.text)
    )
}

/// The parts of the transcript the judge reads, as time ranges over the
/// run's `span` and [`CONTEXT_MS`] before it: one for all of that when its
/// lines fit [`PART_LIMIT_CHARS`], else [`PART_MS`] every
/// `PART_MS - OVERLAP_MS`. A segment belongs to the parts its start is in.
pub fn parts(segments: &[Segment], span: &Range<i64>) -> Vec<Range<i64>> {
    let from = (span.start - CONTEXT_MS).max(0);
    let reach = from..span.end;
    let in_reach = || {
        segments
            .iter()
            .filter(|segment| reach.contains(&segment.start_ms))
    };
    let chars: usize = in_reach()
        .map(|segment| segment_line(segment).chars().count())
        .sum();
    if chars <= PART_LIMIT_CHARS {
        return vec![reach.clone()];
    }
    let last = in_reach().map(|s| s.start_ms).max().unwrap_or(from);
    let mut ranges = Vec::new();
    let mut start = from;
    loop {
        let end = start.saturating_add(PART_MS);
        ranges.push(start..end.min(span.end));
        if end > last {
            return ranges;
        }
        start += PART_MS - OVERLAP_MS;
    }
}

/// The run's span, ms from the start of the call: `--from`…`--to`, or up to
/// the last phrase fed.
fn span(report: &Report) -> Range<i64> {
    // Minutes of a call: far from the limits of i64.
    #[allow(clippy::cast_possible_truncation)]
    let ms = |minutes: f64| (minutes * 60_000.0).round() as i64;
    let from = report.flags.from_min.map_or(0, ms);
    let to = report
        .flags
        .to_min
        .map(ms)
        .or_else(|| report.run.last_fed_ms.map(|end| end + 1))
        .unwrap_or(i64::MAX);
    from..to
}

fn project_section(corpus: &Corpus) -> String {
    let mut text = String::from("# Проект\n\n");
    let Some(project) = &corpus.project else {
        text.push_str("Проект не выбран.\n");
        return text;
    };
    let _ = writeln!(text, "Название: {}", one_line(&project.name));
    let description = one_line(&project.description);
    if !description.is_empty() {
        let _ = writeln!(text, "Описание: {description}");
    }
    let notes = one_line(&project.notes);
    if !notes.is_empty() {
        let _ = writeln!(text, "Заметки менеджера: {notes}");
    }
    if let Some(brief) = &project.brief {
        text.push_str("\n## Бриф\n\n");
        for item in assembly::brief_items(brief) {
            let _ = writeln!(text, "- {item}");
        }
        let gaps = assembly::brief_gaps(brief);
        if !gaps.is_empty() {
            text.push_str("\n## Неясно до звонка\n\n");
            for (lens, gap) in gaps {
                let _ = writeln!(text, "- ({}) {gap}", lens.label());
            }
        }
    }
    text
}

/// A shown question with the time it was first shown.
type Shown<'a> = (&'a ReportQuestion, i64);

fn question_block((question, shown_at): Shown<'_>) -> String {
    let mut text = format!(
        "[Q:{}] {} тема «{}», поле {}, тип {}\n  Вопрос: {}\n",
        question.id,
        clock(shown_at),
        one_line(question.topic.as_deref().unwrap_or("—")),
        question.card_field.map_or_else(
            || "—".to_owned(),
            |lens| format!("{} ({})", lens.as_str(), lens.label())
        ),
        question.gap_type.as_str(),
        one_line(&question.text),
    );
    let description = one_line(&question.description);
    if !description.is_empty() {
        let _ = writeln!(text, "  Зачем: {description}");
    }
    let evidence: Vec<String> = question
        .evidence
        .iter()
        .map(|item| {
            let id = match item.source {
                EvidenceSource::Segment => format!("S:{}", item.id),
                EvidenceSource::Project => item.id.clone(),
                EvidenceSource::Document => format!("находка {}", item.id),
            };
            format!("{id} «{}»", one_line(&item.quote))
        })
        .collect();
    if !evidence.is_empty() {
        let _ = writeln!(text, "  Основание: {}", evidence.join("; "));
    }
    text
}

/// The message of one part: the project, the run, the questions to label
/// and the earlier ones, the part's transcript.
fn message(
    corpus: &Corpus,
    span: &Range<i64>,
    (index, count, range): (usize, usize, &Range<i64>),
    to_label: &[Shown<'_>],
    earlier: &[Shown<'_>],
    segments: &[&Segment],
) -> String {
    let mut text = project_section(corpus);
    text.push_str("\n# Прогон\n\n");
    let to = if span.end == i64::MAX {
        "конец".to_owned()
    } else {
        clock(span.end)
    };
    let _ = writeln!(
        text,
        "Прогон охватил отрезок звонка {}–{to}. Вопросы менеджера выписывай только из него.",
        clock(span.start)
    );
    if span.start > 0 {
        let _ = writeln!(
            text,
            "Расшифровка начинается не раньше чем за {} мин до отрезка: это то, что уже было сказано.",
            CONTEXT_MS / 60_000
        );
    }
    if count > 1 {
        let _ = writeln!(
            text,
            "Звонок длинный, он передан частями. Это часть {} из {count}: расшифровка с {} по {}.",
            index + 1,
            clock(range.start),
            clock(range.end)
        );
    }
    text.push_str("\n# Вопросы для разметки\n\n");
    if to_label.is_empty() {
        text.push_str("Нет.\n");
    }
    for question in to_label {
        text.push_str(&question_block(*question));
    }
    if !earlier.is_empty() {
        text.push_str(
            "\n# Вопросы, показанные раньше этой части\n\nНе размечай их: они нужны для `coveredBy` и повторов.\n\n",
        );
        for question in earlier {
            text.push_str(&question_block(*question));
        }
    }
    text.push_str("\n# Расшифровка\n\n");
    for segment in segments {
        text.push_str(&segment_line(segment));
    }
    text.push_str("\nПередай ответ одним вызовом инструмента StructuredOutput.");
    text
}

/* The run */

/// Labels the shown questions of `report` (a replay of `corpus`) with
/// `agent`. The rules go to a file in `prompt_dir`. `Err` only when the
/// first call could not answer at all (no login, a timeout); a reply not by
/// the schema, or a failed later part, gives an unlabeled [`Judge`] with
/// the cost so far.
pub async fn run(
    corpus: &Corpus,
    report: &Report,
    agent: Arc<dyn Agent>,
    prompt_dir: &Path,
) -> Result<Judge, String> {
    let (pass, segments) = transcript(corpus);
    let span = span(report);
    let ranges = parts(segments, &span);
    let shown: Vec<Shown<'_>> = report.shown().collect();
    let prompt = prompt_dir.join("judge.md");
    std::fs::create_dir_all(prompt_dir)
        .and_then(|()| std::fs::write(&prompt, PROMPT))
        .map_err(|error| format!("Не удалось записать промпт судьи: {error}"))?;

    let mut judge = Judge {
        version: FORMAT,
        corpus: corpus.name.clone(),
        model: MODEL.to_owned(),
        transcript: pass,
        parts: ranges.len(),
        labeled: true,
        error: None,
        labels: Vec::new(),
        manager_questions: Vec::new(),
        dropped: Vec::new(),
        cost_usd: None,
        duration_ms: 0,
    };
    let mut replies = Vec::new();
    for (index, range) in ranges.iter().enumerate() {
        // A question is labeled in the first part that holds its shown
        // time (the last part takes those after the transcript's end).
        let owner = |shown_at: i64| {
            ranges
                .iter()
                .position(|range| range.contains(&shown_at))
                .unwrap_or(ranges.len() - 1)
        };
        let to_label: Vec<Shown<'_>> = shown
            .iter()
            .copied()
            .filter(|(_, shown_at)| owner(*shown_at) == index)
            .collect();
        let earlier: Vec<Shown<'_>> = shown
            .iter()
            .copied()
            .filter(|(_, shown_at)| owner(*shown_at) < index)
            .collect();
        let in_part: Vec<&Segment> = segments
            .iter()
            .filter(|segment| range.contains(&segment.start_ms))
            .collect();
        let text = message(
            corpus,
            &span,
            (index, ranges.len(), range),
            &to_label,
            &earlier,
            &in_part,
        );
        let (_cancel, cancelled) = oneshot::channel();
        let request = AgentRequest {
            system_prompt_file: prompt.clone(),
            user_message: text,
            schema: schema_argument().to_owned(),
            process: TreeSlot::default(),
            options: CallOptions {
                model: Some(MODEL),
                effort: Some(EFFORT),
                timeout: Some(TIMEOUT),
                output: OutputKind::Object,
                on_output: None,
            },
        };
        let part = if ranges.len() > 1 {
            format!(" (часть {})", index + 1)
        } else {
            String::new()
        };
        let failed = match agent.run(request, cancelled).await {
            Ok(reply) => {
                judge.duration_ms += reply.usage.duration_ms;
                if let Some(cost) = reply.usage.cost_usd {
                    judge.cost_usd = Some(judge.cost_usd.unwrap_or(0.0) + cost);
                }
                match serde_json::from_value::<Reply>(reply.patch) {
                    Ok(parsed) => {
                        replies.push((to_label, parsed));
                        continue;
                    }
                    Err(error) => format!("Судья ответил не по схеме{part}: {error}"),
                }
            }
            Err(AgentError::InvalidOutput(error)) => {
                format!("Судья ответил не по схеме{part}: {error}")
            }
            // Nothing was spent on the first part: the command fails.
            Err(error) if index == 0 => return Err(format!("Судья{part}: {error}")),
            Err(error) => format!("Судья{part}: {error}"),
        };
        let _ = std::fs::remove_file(&prompt);
        // The earlier parts' labels stay for a look; none of them counts.
        check(&mut judge, corpus, report, &span, replies);
        judge.labeled = false;
        judge.error = Some(failed);
        return Ok(judge);
    }
    let _ = std::fs::remove_file(&prompt);
    check(&mut judge, corpus, report, &span, replies);
    Ok(judge)
}

/// Keeps what the replies cite correctly; the rest goes to `dropped`.
fn check(
    judge: &mut Judge,
    corpus: &Corpus,
    report: &Report,
    span: &Range<i64>,
    replies: Vec<(Vec<Shown<'_>>, Reply)>,
) {
    // Both passes: the judge reads one, the questions cite the live one.
    let known: HashMap<&str, &Segment> = corpus
        .live
        .iter()
        .chain(corpus.refined.iter().flatten())
        .map(|segment| (segment.id.as_str(), segment))
        .collect();
    // The shown questions with their shown time; the others are not
    // labeled and cover nothing.
    let questions: HashMap<&str, i64> = report
        .shown()
        .map(|(question, shown_at)| (question.id.as_str(), shown_at))
        .collect();
    let never_shown: HashSet<&str> = report.never_shown().map(|q| q.id.as_str()).collect();
    let mut labeled: HashSet<String> = HashSet::new();
    let mut managers: Vec<ManagerQuestion> = Vec::new();
    for (to_label, reply) in replies {
        let ours: HashSet<&str> = to_label.iter().map(|(q, _)| q.id.as_str()).collect();
        for label in reply.labels {
            let question_id = bare(&label.question_id);
            let segment_id = label
                .segment_id
                .as_deref()
                .map(bare)
                .filter(|id| !id.is_empty());
            let Some(&shown_at) = questions.get(question_id.as_str()) else {
                judge
                    .dropped
                    .push(if never_shown.contains(question_id.as_str()) {
                        format!("Метка вопроса {question_id}: он не показывался")
                    } else {
                        format!("Метка неизвестного вопроса {question_id}")
                    });
                continue;
            };
            let segment = match &segment_id {
                Some(id) => match known.get(id.as_str()) {
                    Some(segment) => Some(*segment),
                    None => {
                        judge.dropped.push(format!(
                            "Метка вопроса {question_id} ссылается на неизвестный сегмент {id}"
                        ));
                        continue;
                    }
                },
                None => None,
            };
            // «Уже отвечено» points at the answer, said before the question
            // was shown.
            let answered_before = segment.is_some_and(|segment| segment.start_ms <= shown_at);
            if label.label == Label::AlreadyAnswered && !answered_before {
                judge.dropped.push(format!(
                    "Метка «уже отвечено» вопроса {question_id}: нет сегмента ответа до его показа"
                ));
                continue;
            }
            if !ours.contains(question_id.as_str()) || !labeled.insert(question_id.clone()) {
                judge.dropped.push(format!(
                    "Лишняя метка вопроса {question_id}: он размечен в другом месте"
                ));
                continue;
            }
            judge.labels.push(QuestionLabel {
                question_id,
                label: label.label,
                reason: one_line(&label.reason),
                segment_id,
            });
        }
        for manager in reply.manager_questions {
            let segment_id = bare(&manager.segment_id);
            let Some(segment) = known.get(segment_id.as_str()) else {
                judge.dropped.push(format!(
                    "Вопрос менеджера: неизвестный сегмент {segment_id}"
                ));
                continue;
            };
            if segment.channel != TranscriptChannel::Me {
                judge.dropped.push(format!(
                    "Вопрос менеджера: сегмент {segment_id} — реплика клиента"
                ));
                continue;
            }
            if !span.contains(&segment.start_ms) {
                judge.dropped.push(format!(
                    "Вопрос менеджера: сегмент {segment_id} вне отрезка прогона"
                ));
                continue;
            }
            let covered_by = manager
                .covered_by
                .as_deref()
                .map(bare)
                .filter(|id| !id.is_empty())
                .and_then(|id| match questions.get(id.as_str()) {
                    Some(&shown_at) if shown_at < segment.start_ms => Some(id),
                    Some(_) => {
                        judge.dropped.push(format!(
                            "Вопрос менеджера {segment_id}: вопрос {id} появился позже"
                        ));
                        None
                    }
                    None if never_shown.contains(id.as_str()) => {
                        judge.dropped.push(format!(
                            "Вопрос менеджера {segment_id}: вопрос {id} не показывался"
                        ));
                        None
                    }
                    None => {
                        judge.dropped.push(format!(
                            "Вопрос менеджера {segment_id}: неизвестный вопрос {id}"
                        ));
                        None
                    }
                });
            match managers
                .iter_mut()
                .find(|known| known.segment_id == segment_id)
            {
                Some(known) => {
                    if known.covered_by.is_none() {
                        known.covered_by = covered_by;
                    }
                }
                None => managers.push(ManagerQuestion {
                    segment_id,
                    at_ms: segment.start_ms,
                    text: one_line(&segment.text),
                    covered_by,
                }),
            }
        }
    }
    managers.sort_by(|a, b| (a.at_ms, &a.segment_id).cmp(&(b.at_ms, &b.segment_id)));
    judge.manager_questions = managers;
}

/// Against a fake `claude` script, never the real CLI.
#[cfg(all(test, unix))]
mod tests;
