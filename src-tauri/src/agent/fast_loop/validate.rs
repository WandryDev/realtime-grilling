//! The checks of a patch before it is applied (design.md, decisions 5–6,
//! 8): every quote is long enough and in a source that was sent, facts
//! (card fields, answers, contradictions) come from «Остальные» or the
//! project, a question is about a field of the current topic's card, no
//! topic is created in the final check, no repeats, at most two new
//! questions per call. What fails is dropped and logged with its reason; the
//! rest becomes a [`ValidatedPatch`].
//!
//! The patch is checked against the state its call was given, then once
//! more ([`recheck`]) against the state of the transaction that applies it:
//! a quick action of the manager during the call drops only the steps it
//! made stale.

use std::{collections::HashMap, fmt};

use serde::Serialize;
use serde_json::Value;

use super::{
    evidence::{quote_long_enough, quote_matches},
    patch::{OpKind, Patch, PatchOp, TopicAction},
    similarity::QuestionSimilarity,
};
use crate::storage::{
    call_state::{
        CallState, CardLens, Evidence, EvidenceSource, GapType, NewQuestion, QuestionStatus,
        ValidatedOp, ValidatedPatch,
    },
    transcript::TranscriptChannel,
};

/// New questions accepted from one call.
pub const MAX_NEW_QUESTIONS: usize = 2;

/// A source the call was given: a transcript segment (`id`: its id, with
/// its channel), a project item (`P1`, `B1…Bn`) or a gap of the brief
/// (`G1…Gn`, «Неясно до звонка»).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceText {
    pub id: String,
    pub text: String,
    pub kind: SourceKind,
}

/// What a [`SourceText`] is, and so what it can prove.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// A phrase of the transcript; only «Остальные» states facts.
    Said(TranscriptChannel),
    /// A fact of the project: its description or the brief.
    Project,
    /// What the materials lack (`source: project`): grounds a question, never
    /// a fact, like a phrase of «Я».
    Gap,
}

impl SourceText {
    /// A project item.
    pub fn new(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            kind: SourceKind::Project,
        }
    }

    /// A gap of the brief.
    pub fn gap(id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::Gap,
            ..Self::new(id, text)
        }
    }

    /// A transcript segment of `channel`.
    pub fn said(
        id: impl Into<String>,
        channel: TranscriptChannel,
        text: impl Into<String>,
    ) -> Self {
        Self {
            kind: SourceKind::Said(channel),
            ..Self::new(id, text)
        }
    }

    /// Who said it; `None` for a project item or a gap.
    pub fn channel(&self) -> Option<TranscriptChannel> {
        match self.kind {
            SourceKind::Said(channel) => Some(channel),
            SourceKind::Project | SourceKind::Gap => None,
        }
    }

    /// Whether it states a fact about the task: the client or the project.
    fn states_a_fact(&self) -> bool {
        matches!(
            self.kind,
            SourceKind::Said(TranscriptChannel::Others) | SourceKind::Project
        )
    }
}

/// A question of the recording the agent knew about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownQuestion {
    pub id: String,
    pub text: String,
    pub status: QuestionStatus,
}

/// What a call was given and the state it was given in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallContext {
    /// The transcript window of this call.
    pub segments: Vec<SourceText>,
    /// The project items and the brief's gaps of the stable prefix.
    pub project_items: Vec<SourceText>,
    pub topic_ids: Vec<String>,
    pub current_topic_id: Option<String>,
    /// The fields of each topic's card.
    pub card_fields: HashMap<String, Vec<CardLens>>,
    pub final_check: bool,
    /// Every question of the recording, in any state.
    pub questions: Vec<KnownQuestion>,
}

impl CallContext {
    /// The context of a call made with `state` and these sources.
    pub fn new(
        state: &CallState,
        segments: Vec<SourceText>,
        project_items: Vec<SourceText>,
    ) -> Self {
        Self {
            segments,
            project_items,
            topic_ids: state.topics.iter().map(|topic| topic.id.clone()).collect(),
            current_topic_id: state.current_topic_id.clone(),
            card_fields: state
                .cards
                .iter()
                .map(|card| {
                    let fields = card.fields.iter().map(|f| f.field).collect();
                    (card.topic_id.clone(), fields)
                })
                .collect(),
            final_check: state.final_check.is_some(),
            questions: state
                .questions
                .iter()
                .map(|question| KnownQuestion {
                    id: question.id.clone(),
                    text: question.text.clone(),
                    status: question.status,
                })
                .collect(),
        }
    }

    /// The same sources with `state`, as it is now.
    pub fn with_state(&self, state: &CallState) -> Self {
        Self::new(state, self.segments.clone(), self.project_items.clone())
    }

    fn source(&self, source: EvidenceSource, id: &str) -> Option<&SourceText> {
        let sources = match source {
            EvidenceSource::Segment => &self.segments,
            EvidenceSource::Project => &self.project_items,
        };
        sources.iter().find(|item| item.id == id)
    }
}

/// Why an operation was dropped.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RejectReason {
    /// The id was not in the call's transcript window or project items.
    UnknownSource {
        source: EvidenceSource,
        id: String,
    },
    /// «цитата не найдена»: the quote is not (fuzzily) in its source.
    QuoteNotFound {
        id: String,
        quote: String,
    },
    /// Fewer words or letters than a quote needs to prove anything.
    QuoteTooShort {
        id: String,
        quote: String,
    },
    NoEvidence,
    /// A card field or an answer cites only the manager («Я») or gaps of
    /// the brief, or a contradiction cites the manager: facts come from
    /// «Остальные» or the project.
    NotFromClient,
    /// A question cites a gap of the brief (`G…`) but no phrase of
    /// «Остальные»: a gap is raised only once the client spoke of its lens,
    /// not as a checklist.
    GapWithoutClient,
    /// A contradiction cites two different segments.
    ContradictionNeedsTwoSegments,
    /// A required text is blank.
    Blank {
        field: &'static str,
    },
    NoCurrentTopic,
    /// The topic op before it in the patch was rejected.
    TopicRejected,
    UnknownTopic {
        topic_id: Option<String>,
    },
    /// No new topics in the final check.
    TopicInFinalCheck,
    /// The card of the current topic has no such field.
    UnknownCardField {
        field: CardLens,
    },
    UnknownQuestion {
        question_id: String,
    },
    /// Only an open or asked question can be answered.
    QuestionClosed {
        question_id: String,
        status: QuestionStatus,
    },
    /// Repeats a question of the recording or an earlier one of the patch.
    Repeat {
        of: String,
        score: f64,
    },
    /// More than [`MAX_NEW_QUESTIONS`] new questions; the less important go.
    OverLimit,
    /// Passed the checks with the state the call was given, but not with
    /// the state it was applied to (a quick action came during the call).
    Stale {
        cause: Box<RejectReason>,
    },
}

/// A dropped operation, for `agent_calls.rejected` and the log.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    /// Index of the operation in the patch.
    pub index: usize,
    pub op: OpKind,
    /// The question title, card field, question id or topic title it was
    /// about.
    pub subject: Option<String>,
    #[serde(flatten)]
    pub reason: RejectReason,
}

impl fmt::Display for Rejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = serde_json::to_string(&self.reason).unwrap_or_default();
        write!(
            f,
            "op {} ({:?}) {}: {reason}",
            self.index,
            self.op,
            self.subject.as_deref().unwrap_or("")
        )
    }
}

/// What is left to apply, and what was dropped.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Validation {
    pub patch: ValidatedPatch,
    /// The index in the patch of each op of `patch`.
    pub indices: Vec<usize>,
    pub rejected: Vec<Rejection>,
}

impl Validation {
    /// `rejected` as `agent_calls.rejected` stores it (a JSON array).
    pub fn rejected_json(&self) -> Value {
        serde_json::to_value(&self.rejected).unwrap_or_else(|_| Value::Array(Vec::new()))
    }
}

/// The current topic while walking the patch.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Current {
    None,
    Known(String),
    /// Created by the op at this index.
    New(usize),
    /// The topic op that would set it was rejected.
    Rejected,
}

/// A new question waiting for the repeat and limit checks.
struct Candidate {
    index: usize,
    priority: u8,
    question: NewQuestion,
}

/// Checks a parsed patch against what its call was given. Never fails: what
/// does not pass is in [`Validation::rejected`].
pub fn validate(
    patch: &Patch,
    context: &CallContext,
    similarity: &dyn QuestionSimilarity,
) -> Validation {
    let mut accepted: Vec<(usize, ValidatedOp)> = Vec::new();
    let mut rejected: Vec<Rejection> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();

    let mut current = context
        .current_topic_id
        .clone()
        .map_or(Current::None, Current::Known);
    let mut fields: Vec<CardLens> = card_fields(context, &current);
    let mut final_check = context.final_check;
    let mut answered: Vec<&str> = Vec::new();

    for (index, op) in patch.ops.iter().enumerate() {
        let reject = |subject: Option<&str>, reason: RejectReason| Rejection {
            index,
            op: op.kind(),
            subject: subject.map(str::to_owned),
            reason,
        };
        match op {
            PatchOp::Topic {
                action,
                topic_id,
                title,
            } => {
                let checked =
                    match topic_op(context, *action, topic_id.as_deref(), title.as_deref()) {
                        Ok(ValidatedOp::CreateTopic { .. }) if final_check => {
                            Err(RejectReason::TopicInFinalCheck)
                        }
                        checked => checked,
                    };
                match checked {
                    Ok(validated) => {
                        current = match &validated {
                            ValidatedOp::SwitchTopic { topic_id } => {
                                Current::Known(topic_id.clone())
                            }
                            _ => Current::New(index),
                        };
                        fields = card_fields(context, &current);
                        accepted.push((index, validated));
                    }
                    Err(reason) => {
                        // What follows was meant for that topic.
                        current = Current::Rejected;
                        fields.clear();
                        rejected.push(reject(title.as_deref().or(topic_id.as_deref()), reason));
                    }
                }
            }
            PatchOp::Card {
                field,
                value,
                evidence,
            } => {
                let subject = Some(field.as_str());
                if let Err(reason) = topic_ready(&current) {
                    rejected.push(reject(subject, reason));
                } else if let Err(reason) = check_fact(context, evidence) {
                    rejected.push(reject(subject, reason));
                } else {
                    if !fields.contains(field) {
                        fields.push(*field);
                    }
                    accepted.push((
                        index,
                        ValidatedOp::SetCardField {
                            field: *field,
                            value: value.trim().to_owned(),
                            evidence: evidence.clone(),
                        },
                    ));
                }
            }
            PatchOp::Question {
                title,
                description,
                card_field,
                gap_type,
                priority,
                evidence,
            } => {
                let subject = Some(title.as_str());
                let contradiction = *gap_type == GapType::Contradiction;
                if let Err(reason) = topic_ready(&current) {
                    rejected.push(reject(subject, reason));
                } else if title.trim().is_empty() {
                    rejected.push(reject(subject, RejectReason::Blank { field: "title" }));
                } else if *gap_type != GapType::Empty && !fields.contains(card_field) {
                    // An empty field is the gap itself; an assumption or a
                    // contradiction is about something the card already says.
                    let field = *card_field;
                    rejected.push(reject(subject, RejectReason::UnknownCardField { field }));
                } else if let Err(reason) =
                    check_evidence(context, evidence).and_then(|()| check_gap(context, evidence))
                {
                    rejected.push(reject(subject, reason));
                } else if let Err(reason) = if contradiction {
                    check_contradiction(context, evidence)
                } else {
                    Ok(())
                } {
                    rejected.push(reject(subject, reason));
                } else {
                    candidates.push(Candidate {
                        index,
                        priority: priority.get(),
                        question: NewQuestion {
                            text: title.trim().to_owned(),
                            description: description.trim().to_owned(),
                            card_field: *card_field,
                            gap_type: *gap_type,
                            priority: i32::from(priority.get()),
                            evidence: evidence.clone(),
                        },
                    });
                }
            }
            PatchOp::Answered {
                question_id,
                evidence,
            } => {
                let subject = Some(question_id.as_str());
                let status = if answered.contains(&question_id.as_str()) {
                    Some(QuestionStatus::Answered)
                } else {
                    context
                        .questions
                        .iter()
                        .find(|question| &question.id == question_id)
                        .map(|question| question.status)
                };
                match status {
                    None => {
                        let question_id = question_id.clone();
                        rejected.push(reject(
                            subject,
                            RejectReason::UnknownQuestion { question_id },
                        ));
                    }
                    Some(status @ (QuestionStatus::Answered | QuestionStatus::Hidden)) => {
                        let reason = RejectReason::QuestionClosed {
                            question_id: question_id.clone(),
                            status,
                        };
                        rejected.push(reject(subject, reason));
                    }
                    Some(QuestionStatus::Open | QuestionStatus::Asked) => {
                        match check_fact(context, evidence) {
                            Err(reason) => rejected.push(reject(subject, reason)),
                            Ok(()) => {
                                answered.push(question_id.as_str());
                                accepted.push((
                                    index,
                                    ValidatedOp::MarkAnswered {
                                        question_id: question_id.clone(),
                                        evidence: evidence.clone(),
                                    },
                                ));
                            }
                        }
                    }
                }
            }
            PatchOp::FinalCheck {} => {
                final_check = true;
                accepted.push((index, ValidatedOp::StartFinalCheck));
            }
        }
    }

    let (questions, dropped) = pick_questions(patch, context, similarity, candidates);
    accepted.extend(questions);
    rejected.extend(dropped);
    accepted.sort_by_key(|(index, _)| *index);
    rejected.sort_by_key(|rejection| rejection.index);
    let (indices, ops) = accepted.into_iter().unzip();
    Validation {
        patch: ValidatedPatch { ops },
        indices,
        rejected,
    }
}

/// `checked` (the patch checked with the state its call was given) checked
/// once more with `fresh`, the state of the transaction that applies it.
/// What passed both is applied; what passed only the first check is
/// rejected as [`RejectReason::Stale`] with the reason of the second. What
/// the first check rejected stays rejected, with its reason.
pub fn recheck(
    patch: &Patch,
    checked: Validation,
    fresh: &CallContext,
    similarity: &dyn QuestionSimilarity,
) -> Validation {
    let again = validate(patch, fresh, similarity);
    let mut passed: HashMap<usize, ValidatedOp> =
        again.indices.into_iter().zip(again.patch.ops).collect();
    let mut failed: HashMap<usize, Rejection> = again
        .rejected
        .into_iter()
        .map(|rejection| (rejection.index, rejection))
        .collect();
    let mut rejected = checked.rejected;
    let mut kept = Vec::new();
    for index in checked.indices {
        if let Some(op) = passed.remove(&index) {
            kept.push((index, op));
        } else if let Some(rejection) = failed.remove(&index) {
            rejected.push(Rejection {
                reason: RejectReason::Stale {
                    cause: Box::new(rejection.reason),
                },
                ..rejection
            });
        }
    }
    rejected.sort_by_key(|rejection| rejection.index);
    let (indices, ops) = kept.into_iter().unzip();
    Validation {
        patch: ValidatedPatch { ops },
        indices,
        rejected,
    }
}

/// A topic op on its own; a create in the final check is refused by the
/// caller, which knows whether an earlier op started it.
fn topic_op(
    context: &CallContext,
    action: TopicAction,
    topic_id: Option<&str>,
    title: Option<&str>,
) -> Result<ValidatedOp, RejectReason> {
    match action {
        TopicAction::Create => {
            let title = title.map(str::trim).unwrap_or_default();
            if title.is_empty() {
                return Err(RejectReason::Blank { field: "title" });
            }
            Ok(ValidatedOp::CreateTopic {
                title: title.to_owned(),
            })
        }
        TopicAction::Switch => match topic_id {
            Some(id) if context.topic_ids.iter().any(|known| known == id) => {
                Ok(ValidatedOp::SwitchTopic {
                    topic_id: id.to_owned(),
                })
            }
            _ => Err(RejectReason::UnknownTopic {
                topic_id: topic_id.map(str::to_owned),
            }),
        },
    }
}

fn topic_ready(current: &Current) -> Result<(), RejectReason> {
    match current {
        Current::None => Err(RejectReason::NoCurrentTopic),
        Current::Rejected => Err(RejectReason::TopicRejected),
        Current::Known(_) | Current::New(_) => Ok(()),
    }
}

/// The fields of the current topic's card when the patch starts on it.
fn card_fields(context: &CallContext, current: &Current) -> Vec<CardLens> {
    match current {
        Current::Known(topic_id) => context
            .card_fields
            .get(topic_id)
            .cloned()
            .unwrap_or_default(),
        Current::None | Current::New(_) | Current::Rejected => Vec::new(),
    }
}

/// Every item names a source of the call and quotes enough of it.
fn check_evidence(context: &CallContext, evidence: &[Evidence]) -> Result<(), RejectReason> {
    if evidence.is_empty() {
        return Err(RejectReason::NoEvidence);
    }
    for item in evidence {
        let Some(source) = context.source(item.source, &item.id) else {
            return Err(RejectReason::UnknownSource {
                source: item.source,
                id: item.id.clone(),
            });
        };
        let quoted = || (item.id.clone(), item.quote.clone());
        if !quote_long_enough(&item.quote, &source.text) {
            let (id, quote) = quoted();
            return Err(RejectReason::QuoteTooShort { id, quote });
        }
        if !quote_matches(&item.quote, &source.text) {
            let (id, quote) = quoted();
            return Err(RejectReason::QuoteNotFound { id, quote });
        }
    }
    Ok(())
}

/// Who said what an item cites: `None` for a project item or a gap.
fn channel_of(context: &CallContext, item: &Evidence) -> Option<TranscriptChannel> {
    context
        .source(item.source, &item.id)
        .and_then(SourceText::channel)
}

/// A fact (a card field, an answer): the evidence holds, and at least one
/// item is the client («Остальные») or the project, not only the manager or
/// a gap of the brief.
fn check_fact(context: &CallContext, evidence: &[Evidence]) -> Result<(), RejectReason> {
    check_evidence(context, evidence)?;
    let from_client = evidence.iter().any(|item| {
        context
            .source(item.source, &item.id)
            .is_some_and(SourceText::states_a_fact)
    });
    if from_client {
        Ok(())
    } else {
        Err(RejectReason::NotFromClient)
    }
}

/// A question on a gap of the brief also cites the client: a gap is raised
/// when the client spoke of its lens (question-quality design.md, decision
/// 6), never on its own.
fn check_gap(context: &CallContext, evidence: &[Evidence]) -> Result<(), RejectReason> {
    let kinds: Vec<SourceKind> = evidence
        .iter()
        .filter_map(|item| context.source(item.source, &item.id))
        .map(|source| source.kind)
        .collect();
    let cites_gap = kinds.contains(&SourceKind::Gap);
    let cites_client = kinds.contains(&SourceKind::Said(TranscriptChannel::Others));
    if cites_gap && !cites_client {
        Err(RejectReason::GapWithoutClient)
    } else {
        Ok(())
    }
}

/// Two different segments, both of «Остальные»: the client contradicts
/// themselves, not the manager.
fn check_contradiction(context: &CallContext, evidence: &[Evidence]) -> Result<(), RejectReason> {
    let segments: Vec<&Evidence> = evidence
        .iter()
        .filter(|item| item.source == EvidenceSource::Segment)
        .collect();
    let mut ids: Vec<&str> = segments.iter().map(|item| item.id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() < 2 {
        return Err(RejectReason::ContradictionNeedsTwoSegments);
    }
    let by_client = segments
        .iter()
        .all(|item| channel_of(context, item) == Some(TranscriptChannel::Others));
    if by_client {
        Ok(())
    } else {
        Err(RejectReason::NotFromClient)
    }
}

/// Decision 6: by priority (the patch order among equals), a question that
/// repeats a known one or one taken before is dropped; the first
/// [`MAX_NEW_QUESTIONS`] of the rest are taken.
fn pick_questions(
    patch: &Patch,
    context: &CallContext,
    similarity: &dyn QuestionSimilarity,
    mut candidates: Vec<Candidate>,
) -> (Vec<(usize, ValidatedOp)>, Vec<Rejection>) {
    candidates.sort_by_key(|candidate| (std::cmp::Reverse(candidate.priority), candidate.index));
    let mut taken: Vec<(usize, NewQuestion)> = Vec::new();
    let mut dropped = Vec::new();
    for candidate in candidates {
        let text = &candidate.question.text;
        let reject = |reason: RejectReason| Rejection {
            index: candidate.index,
            op: patch.ops[candidate.index].kind(),
            subject: Some(text.clone()),
            reason,
        };
        let known = context
            .questions
            .iter()
            .map(|question| (question.id.clone(), question.text.as_str()));
        let earlier = taken
            .iter()
            .map(|(index, question)| (format!("op {index}"), question.text.as_str()));
        let repeat = known
            .chain(earlier)
            .map(|(id, other)| (id, similarity.score(text, other)))
            .filter(|(_, score)| *score >= similarity.threshold())
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((of, score)) = repeat {
            dropped.push(reject(RejectReason::Repeat { of, score }));
        } else if taken.len() >= MAX_NEW_QUESTIONS {
            dropped.push(reject(RejectReason::OverLimit));
        } else {
            taken.push((candidate.index, candidate.question));
        }
    }
    let taken = taken
        .into_iter()
        .map(|(index, question)| (index, ValidatedOp::AddQuestion(question)))
        .collect();
    (taken, dropped)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent::fast_loop::similarity::TrigramSimilarity;

    const S1: &str = "У нас сейчас пять операторов в смену, иногда шесть.";
    const S2: &str = "Ночью никто не дежурит, звонки уходят на автоответчик.";
    const S3: &str = "Вообще-то ночью у нас дежурит один оператор.";
    /// The manager.
    const S4: &str = "То есть у вас пять операторов в смену, а ночью никого?";

    const OTHERS: TranscriptChannel = TranscriptChannel::Others;

    /// A call on topic `T1` whose card has `users`, with `Q1` open, `Q2`
    /// hidden, `Q3` answered and `Q4` asked. `S1`–`S3` are the client's,
    /// `S4` the manager's.
    fn context() -> CallContext {
        CallContext {
            segments: vec![
                SourceText::said("S1", OTHERS, S1),
                SourceText::said("S2", OTHERS, S2),
                SourceText::said("S3", OTHERS, S3),
                SourceText::said("S4", TranscriptChannel::Me, S4),
            ],
            project_items: vec![
                SourceText::new("P1", "Единая система приёма звонков для сети клиник"),
                SourceText::new("B1", "Запись к врачу без ожидания на линии"),
            ],
            topic_ids: vec!["T1".to_owned(), "T0".to_owned()],
            current_topic_id: Some("T1".to_owned()),
            card_fields: HashMap::from([
                ("T1".to_owned(), vec![CardLens::Users]),
                ("T0".to_owned(), vec![CardLens::Goal]),
            ]),
            final_check: false,
            questions: vec![
                KnownQuestion {
                    id: "Q1".to_owned(),
                    text: "Кто отвечает на звонки ночью?".to_owned(),
                    status: QuestionStatus::Open,
                },
                KnownQuestion {
                    id: "Q2".to_owned(),
                    text: "Сколько операторов в смене работает".to_owned(),
                    status: QuestionStatus::Hidden,
                },
                KnownQuestion {
                    id: "Q3".to_owned(),
                    text: "Какая CRM сейчас?".to_owned(),
                    status: QuestionStatus::Answered,
                },
                KnownQuestion {
                    id: "Q4".to_owned(),
                    text: "Есть ли запись разговоров?".to_owned(),
                    status: QuestionStatus::Asked,
                },
            ],
        }
    }

    fn check(ops: serde_json::Value) -> Validation {
        let patch = Patch::from_value(json!({ "ops": ops })).unwrap();
        validate(&patch, &context(), &TrigramSimilarity::default())
    }

    fn segment(id: &str, quote: &str) -> serde_json::Value {
        json!({ "source": "segment", "id": id, "quote": quote })
    }

    fn question(title: &str, priority: u8, evidence: serde_json::Value) -> serde_json::Value {
        json!({
            "op": "question", "title": title, "description": "", "cardField": "users",
            "gapType": "empty", "priority": priority, "evidence": evidence
        })
    }

    fn reasons(validation: &Validation) -> Vec<&RejectReason> {
        validation.rejected.iter().map(|r| &r.reason).collect()
    }

    fn added(validation: &Validation) -> Vec<&str> {
        validation
            .patch
            .ops
            .iter()
            .filter_map(|op| match op {
                ValidatedOp::AddQuestion(question) => Some(question.text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_patch_that_passes_is_kept_as_it_is() {
        let validation = check(json!([
            { "op": "card", "field": "users", "value": "5–6 операторов", "evidence": [segment("S1", "пять операторов в смену")] },
            question("Что с выходными?", 2, json!([segment("S1", "в смену, иногда шесть")])),
            { "op": "answered", "questionId": "Q1", "evidence": [segment("S2", "ночью никто не дежурит")] },
            { "op": "finalCheck" }
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(validation.patch.ops.len(), 4);
        assert_eq!(validation.indices, vec![0, 1, 2, 3]);
        assert!(matches!(
            validation.patch.ops[0],
            ValidatedOp::SetCardField { .. }
        ));
        assert_eq!(added(&validation), vec!["Что с выходными?"]);
        assert!(matches!(
            validation.patch.ops[3],
            ValidatedOp::StartFinalCheck
        ));
    }

    #[test]
    fn an_empty_patch_is_fine() {
        let validation = check(json!([]));
        assert_eq!(validation, Validation::default());
        assert_eq!(validation.rejected_json(), json!([]));
    }

    /// «Выдуманная цитата»: the journal says the quote was not found.
    #[test]
    fn an_invented_quote_is_rejected() {
        let validation = check(json!([question(
            "Сколько стоит лицензия?",
            3,
            json!([segment("S1", "лицензия стоит сто тысяч")])
        )]));
        assert!(validation.patch.ops.is_empty());
        assert_eq!(
            reasons(&validation),
            vec![&RejectReason::QuoteNotFound {
                id: "S1".to_owned(),
                quote: "лицензия стоит сто тысяч".to_owned()
            }]
        );
        let logged = validation.rejected_json();
        assert_eq!(logged[0]["reason"], "quoteNotFound");
        assert_eq!(logged[0]["op"], "question");
        assert_eq!(logged[0]["index"], 0);
        assert_eq!(logged[0]["subject"], "Сколько стоит лицензия?");
        assert!(validation.rejected[0].to_string().contains("quoteNotFound"));
    }

    /// «Несуществующий сегмент»: an id that was not in the call.
    #[test]
    fn a_source_outside_the_call_is_rejected() {
        let validation = check(json!([
            question("Есть ли очередь?", 2, json!([segment("S99", "пять операторов")])),
            // A project item named as a segment, and the other way round.
            question("Что с врачами?", 2, json!([segment("B1", "запись к врачу")])),
            { "op": "answered", "questionId": "Q1",
              "evidence": [{ "source": "project", "id": "S2", "quote": "ночью никто" }] },
            { "op": "card", "field": "users", "value": "?",
              "evidence": [{ "source": "project", "id": "B9", "quote": "запись" }] }
        ]));
        assert!(validation.patch.ops.is_empty());
        assert_eq!(
            reasons(&validation),
            vec![
                &RejectReason::UnknownSource {
                    source: EvidenceSource::Segment,
                    id: "S99".to_owned()
                },
                &RejectReason::UnknownSource {
                    source: EvidenceSource::Segment,
                    id: "B1".to_owned()
                },
                &RejectReason::UnknownSource {
                    source: EvidenceSource::Project,
                    id: "S2".to_owned()
                },
                &RejectReason::UnknownSource {
                    source: EvidenceSource::Project,
                    id: "B9".to_owned()
                },
            ]
        );
        // One bad item drops the whole operation.
        let validation = check(json!([question(
            "Что с выходными?",
            2,
            json!([
                segment("S1", "в смену, иногда шесть"),
                segment("S7", "по выходным никого")
            ])
        )]));
        assert!(validation.patch.ops.is_empty());
    }

    /// «Цитата с ошибкой распознавания»: case, punctuation and one distorted
    /// word.
    #[test]
    fn case_punctuation_and_one_distorted_word_pass() {
        let validation = check(json!([
            question("Что с выходными?", 2, json!([segment("S1", "У НАС СЕЙЧАС — пять операторав в смену!")])),
            { "op": "answered", "questionId": "Q1",
              "evidence": [{ "source": "project", "id": "P1", "quote": "единая система приема звонков" }] }
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(validation.patch.ops.len(), 2);
    }

    /// «Противоречие»: two different segments.
    #[test]
    fn a_contradiction_cites_two_segments() {
        let contradiction = |evidence: serde_json::Value| {
            json!({
                "op": "question", "title": "Так дежурит кто-то ночью или нет?",
                "description": "S2 и S3 расходятся", "cardField": "users",
                "gapType": "contradiction", "priority": 3, "evidence": evidence
            })
        };
        let validation = check(json!([contradiction(json!([
            segment("S2", "ночью никто не дежурит"),
            segment("S3", "ночью у нас дежурит один оператор")
        ]))]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        let ValidatedOp::AddQuestion(question) = &validation.patch.ops[0] else {
            panic!("{:?}", validation.patch.ops);
        };
        assert_eq!(question.gap_type, GapType::Contradiction);
        assert_eq!(question.evidence.len(), 2);

        for evidence in [
            json!([segment("S2", "ночью никто не дежурит")]),
            json!([
                segment("S2", "ночью никто не дежурит"),
                segment("S2", "звонки уходят на автоответчик")
            ]),
            json!([
                segment("S2", "ночью никто не дежурит"),
                { "source": "project", "id": "B1", "quote": "без ожидания на линии" }
            ]),
        ] {
            let validation = check(json!([contradiction(evidence)]));
            assert_eq!(
                reasons(&validation),
                vec![&RejectReason::ContradictionNeedsTwoSegments]
            );
        }
    }

    /// An assumption or a contradiction is about a field the current topic's
    /// card already has; a field set earlier in the same patch counts. An
    /// empty field is the gap itself.
    #[test]
    fn a_question_needs_a_field_of_the_current_card() {
        let empty = json!({
            "op": "question", "title": "Кто будет принимать звонки?", "description": "", "cardField": "users",
            "gapType": "empty", "priority": 3, "evidence": [segment("S1", "пять операторов в смену")]
        });
        assert!(check(json!([empty])).rejected.is_empty());
        let other = json!({
            "op": "question", "title": "Какая цель?", "description": "", "cardField": "goal",
            "gapType": "assumption", "priority": 2, "evidence": [segment("S1", "пять операторов в смену")]
        });
        let validation = check(json!([other.clone()]));
        assert_eq!(
            reasons(&validation),
            vec![&RejectReason::UnknownCardField {
                field: CardLens::Goal
            }]
        );
        // Created by a card op before it.
        let validation = check(json!([
            { "op": "card", "field": "goal", "value": "Не терять звонки", "evidence": [segment("S2", "звонки уходят на автоответчик")] },
            other.clone()
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        // On the topic it switched to.
        let validation = check(json!([
            { "op": "topic", "action": "switch", "topicId": "T0" },
            other
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        // A new topic has an empty card: its first question asks about an
        // empty field in the same patch.
        let validation = check(json!([
            { "op": "topic", "action": "create", "title": "CRM" },
            question("Какие поля в CRM?", 2, json!([segment("S1", "пять операторов в смену")]))
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(validation.patch.ops.len(), 2);
        // An assumption on the new topic's empty card is not.
        let validation = check(json!([
            { "op": "topic", "action": "create", "title": "CRM" },
            {
                "op": "question", "title": "Точно пять операторов?", "description": "", "cardField": "users",
                "gapType": "assumption", "priority": 2, "evidence": [segment("S1", "пять операторов в смену")]
            }
        ]));
        assert_eq!(
            reasons(&validation),
            vec![&RejectReason::UnknownCardField {
                field: CardLens::Users
            }]
        );
    }

    #[test]
    fn without_a_current_topic_nothing_attaches() {
        let patch = Patch::from_value(json!({ "ops": [
            question("Сколько смен?", 2, json!([segment("S1", "в смену")]))
        ] }))
        .unwrap();
        let context = CallContext {
            current_topic_id: None,
            ..context()
        };
        let validation = validate(&patch, &context, &TrigramSimilarity::default());
        assert_eq!(reasons(&validation), vec![&RejectReason::NoCurrentTopic]);
    }

    #[test]
    fn topic_ops_are_checked() {
        let validation = check(json!([
            { "op": "topic", "action": "switch", "topicId": "T9" },
            { "op": "card", "field": "users", "value": "5", "evidence": [segment("S1", "пять операторов")] },
            { "op": "topic", "action": "create", "title": "  " },
            { "op": "topic", "action": "switch" },
            { "op": "topic", "action": "create", "title": " Запись к врачу " }
        ]));
        assert_eq!(
            reasons(&validation),
            vec![
                &RejectReason::UnknownTopic {
                    topic_id: Some("T9".to_owned())
                },
                // Meant for the topic that was rejected.
                &RejectReason::TopicRejected,
                &RejectReason::Blank { field: "title" },
                &RejectReason::UnknownTopic { topic_id: None },
            ]
        );
        assert_eq!(
            validation.patch.ops,
            vec![ValidatedOp::CreateTopic {
                title: "Запись к врачу".to_owned()
            }]
        );
    }

    /// Decision 8: no new topics in the final check, answers still count.
    #[test]
    fn no_new_topics_in_the_final_check() {
        let answered = json!({ "op": "answered", "questionId": "Q1", "evidence": [segment("S3", "дежурит один оператор")] });
        let create = json!({ "op": "topic", "action": "create", "title": "Новая" });
        let patch = Patch::from_value(json!({ "ops": [create, answered] })).unwrap();
        let context = CallContext {
            final_check: true,
            ..context()
        };
        let validation = validate(&patch, &context, &TrigramSimilarity::default());
        assert_eq!(reasons(&validation), vec![&RejectReason::TopicInFinalCheck]);
        assert!(matches!(
            validation.patch.ops[..],
            [ValidatedOp::MarkAnswered { .. }]
        ));

        // Started by an earlier op of the same patch.
        let validation = check(json!([
            { "op": "finalCheck" },
            { "op": "topic", "action": "create", "title": "Новая" }
        ]));
        assert_eq!(reasons(&validation), vec![&RejectReason::TopicInFinalCheck]);
        // Switching back to a known topic is fine.
        let patch = Patch::from_value(json!({ "ops": [
            { "op": "topic", "action": "switch", "topicId": "T0" }
        ] }))
        .unwrap();
        let validation = validate(&patch, &context, &TrigramSimilarity::default());
        assert!(validation.rejected.is_empty());
    }

    /// Open and asked questions can be answered («Задал», then the client
    /// answers); hidden, answered and unknown ones can't.
    #[test]
    fn open_and_asked_questions_are_answered() {
        let answer = |id: &str| json!({ "op": "answered", "questionId": id, "evidence": [segment("S3", "дежурит один оператор")] });
        let validation = check(json!([
            answer("Q9"),
            answer("Q2"),
            answer("Q3"),
            answer("Q1"),
            answer("Q1"),
            answer("Q4")
        ]));
        assert_eq!(
            reasons(&validation),
            vec![
                &RejectReason::UnknownQuestion {
                    question_id: "Q9".to_owned()
                },
                &RejectReason::QuestionClosed {
                    question_id: "Q2".to_owned(),
                    status: QuestionStatus::Hidden
                },
                &RejectReason::QuestionClosed {
                    question_id: "Q3".to_owned(),
                    status: QuestionStatus::Answered
                },
                &RejectReason::QuestionClosed {
                    question_id: "Q1".to_owned(),
                    status: QuestionStatus::Answered
                },
            ]
        );
        assert_eq!(validation.indices, vec![3, 5]);
        let answered: Vec<&str> = validation
            .patch
            .ops
            .iter()
            .filter_map(|op| match op {
                ValidatedOp::MarkAnswered { question_id, .. } => Some(question_id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(answered, ["Q1", "Q4"]);
    }

    /// One or two common words are in almost every phrase: a quote that
    /// short proves nothing.
    #[test]
    fn a_quote_too_short_is_rejected() {
        let validation = check(json!([
            question("Сколько стоит интеграция с 1С?", 3, json!([segment("S1", "нас")])),
            { "op": "answered", "questionId": "Q1", "evidence": [segment("S2", "ночью никто")] },
        ]));
        assert!(validation.patch.ops.is_empty());
        assert_eq!(
            reasons(&validation),
            vec![
                &RejectReason::QuoteTooShort {
                    id: "S1".to_owned(),
                    quote: "нас".to_owned()
                },
                &RejectReason::QuoteTooShort {
                    id: "S2".to_owned(),
                    quote: "ночью никто".to_owned()
                },
            ]
        );
        assert_eq!(validation.rejected_json()[0]["reason"], "quoteTooShort");
    }

    /// Facts come from «Остальные» or the project: the manager's guess is no
    /// answer and fills no card field.
    #[test]
    fn answers_and_card_fields_need_the_client() {
        let me = segment("S4", "у вас пять операторов в смену");
        let validation = check(json!([
            { "op": "answered", "questionId": "Q1", "evidence": [me.clone()] },
            { "op": "card", "field": "users", "value": "5 операторов", "evidence": [me.clone()] }
        ]));
        assert!(validation.patch.ops.is_empty());
        assert_eq!(
            reasons(&validation),
            vec![&RejectReason::NotFromClient, &RejectReason::NotFromClient]
        );

        // With the client or the project next to it, it holds.
        let validation = check(json!([
            { "op": "card", "field": "users", "value": "5 операторов",
              "evidence": [me.clone(), segment("S1", "пять операторов в смену")] },
            { "op": "card", "field": "users", "value": "5 операторов",
              "evidence": [me.clone(), { "source": "project", "id": "B1", "quote": "запись к врачу без ожидания" }] },
            { "op": "answered", "questionId": "Q1",
              "evidence": [me.clone(), segment("S2", "ночью никто не дежурит")] },
            // A question may come from what the manager said.
            question("Пять операторов — это на все клиники?", 2, json!([me]))
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(validation.patch.ops.len(), 4);
    }

    /// A brief's gap of the prefix, «Неясно до звонка».
    const G1: &str = "Не сказано, кто из операторов отвечает на ночные звонки";

    /// [`check`] with `G1` among the project items.
    fn check_with_gap(ops: serde_json::Value) -> Validation {
        let mut context = context();
        context.project_items.push(SourceText::gap("G1", G1));
        let patch = Patch::from_value(json!({ "ops": ops })).unwrap();
        validate(&patch, &context, &TrigramSimilarity::default())
    }

    fn gap(quote: &str) -> serde_json::Value {
        json!({ "source": "project", "id": "G1", "quote": quote })
    }

    /// Spec «Вопрос по пробелу брифа»: the client touched the gap's lens; the
    /// question cites the gap and the client's phrase.
    #[test]
    fn a_question_on_a_gap_of_the_brief_passes() {
        let validation = check_with_gap(json!([{
            "op": "question", "title": "Кто из операторов берёт ночные звонки?",
            "description": "Без этого не понять смены", "cardField": "users",
            "gapType": "empty", "priority": 3, "evidence": [
                gap("кто из операторов отвечает на ночные звонки"),
                segment("S2", "ночью никто не дежурит")
            ]
        }]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(
            added(&validation),
            ["Кто из операторов берёт ночные звонки?"]
        );
        let ValidatedOp::AddQuestion(added_question) = &validation.patch.ops[0] else {
            panic!("{:?}", validation.patch.ops);
        };
        assert_eq!(added_question.evidence[0].id, "G1");
        assert_eq!(added_question.evidence[0].source, EvidenceSource::Project);

        // A gap's quote is checked like any other.
        let validation = check_with_gap(json!([question(
            "Кто дежурит ночью?",
            2,
            json!([gap("в выходные работает автоответчик")])
        )]));
        assert!(matches!(
            reasons(&validation)[..],
            [RejectReason::QuoteNotFound { .. }]
        ));
    }

    /// A question on a gap needs the client too: a gap alone, or with the
    /// manager only, is a checklist question and is rejected; with a
    /// phrase of «Остальные» it passes.
    #[test]
    fn a_question_on_a_gap_alone_is_rejected() {
        let ask = |evidence: serde_json::Value| {
            check_with_gap(json!([{
                "op": "question", "title": "Кто из операторов берёт ночные звонки?",
                "description": "Без этого не понять смены", "cardField": "users",
                "gapType": "empty", "priority": 3, "evidence": evidence
            }]))
        };
        let gap_quote = || gap("кто из операторов отвечает на ночные звонки");

        for evidence in [
            json!([gap_quote()]),
            json!([gap_quote(), segment("S4", "у вас пять операторов в смену")]),
        ] {
            let validation = ask(evidence);
            assert!(validation.patch.ops.is_empty(), "{:?}", validation.patch);
            assert_eq!(reasons(&validation), vec![&RejectReason::GapWithoutClient]);
            assert_eq!(validation.rejected_json()[0]["reason"], "gapWithoutClient");
        }

        let validation = ask(json!([
            gap_quote(),
            segment("S2", "ночью никто не дежурит")
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(
            added(&validation),
            ["Кто из операторов берёт ночные звонки?"]
        );
    }

    /// Spec «Пробел как факт»: a gap is what the materials lack, so on its
    /// own (or with the manager) it fills no card field and answers nothing.
    #[test]
    fn a_gap_of_the_brief_is_no_fact() {
        let validation = check_with_gap(json!([
            { "op": "card", "field": "users", "value": "Ночные операторы",
              "evidence": [gap("кто из операторов отвечает на ночные звонки")] },
            { "op": "answered", "questionId": "Q1",
              "evidence": [gap("кто из операторов отвечает на ночные звонки")] },
            { "op": "answered", "questionId": "Q4",
              "evidence": [gap("кто из операторов отвечает на ночные звонки"),
                           segment("S4", "у вас пять операторов в смену")] }
        ]));
        assert!(validation.patch.ops.is_empty(), "{:?}", validation.patch);
        assert_eq!(
            reasons(&validation),
            vec![
                &RejectReason::NotFromClient,
                &RejectReason::NotFromClient,
                &RejectReason::NotFromClient
            ]
        );

        // With the client's phrase next to it, the fact holds.
        let validation = check_with_gap(json!([
            { "op": "card", "field": "users", "value": "Ночью никто",
              "evidence": [gap("кто из операторов отвечает на ночные звонки"),
                           segment("S2", "ночью никто не дежурит")] },
            { "op": "answered", "questionId": "Q1",
              "evidence": [gap("кто из операторов отвечает на ночные звонки"),
                           segment("S2", "ночью никто не дежурит")] }
        ]));
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(validation.patch.ops.len(), 2);
    }

    /// Spec «Поле заполнено общими словами»: `empty` means «не раскрыто», so
    /// a question about a field the card already has passes.
    #[test]
    fn an_empty_gap_on_a_filled_field_passes() {
        let mut context = context();
        assert!(context.card_fields["T1"].contains(&CardLens::Users));
        context.questions.clear();
        let patch = Patch::from_value(json!({ "ops": [{
            "op": "question", "title": "Кто из сотрудников работает с бронями?",
            "description": "В карточке только «клиенты обменника»", "cardField": "users",
            "gapType": "empty", "priority": 3, "evidence": [segment("S1", "пять операторов в смену")]
        }] }))
        .unwrap();
        let validation = validate(&patch, &context, &TrigramSimilarity::default());
        assert!(validation.rejected.is_empty(), "{:?}", validation.rejected);
        assert_eq!(
            added(&validation),
            ["Кто из сотрудников работает с бронями?"]
        );
    }

    /// A contradiction is the client's with themselves: both phrases are
    /// «Остальные».
    #[test]
    fn a_contradiction_needs_both_phrases_from_the_client() {
        let validation = check(json!([{
            "op": "question", "title": "Сколько операторов в смене?",
            "description": "", "cardField": "users", "gapType": "contradiction",
            "priority": 3, "evidence": [
                segment("S1", "пять операторов в смену"),
                segment("S4", "а ночью никого")
            ]
        }]));
        assert_eq!(reasons(&validation), vec![&RejectReason::NotFromClient]);
    }

    /// A quick action during the call: the answer to a question the manager
    /// hid meanwhile is stale, the rest of the patch still applies.
    #[test]
    fn a_recheck_drops_only_what_went_stale() {
        let patch = Patch::from_value(json!({ "ops": [
            { "op": "card", "field": "users", "value": "5–6 операторов", "evidence": [segment("S1", "пять операторов в смену")] },
            { "op": "answered", "questionId": "Q1", "evidence": [segment("S2", "ночью никто не дежурит")] },
            question("Что с выходными?", 2, json!([segment("S1", "в смену, иногда шесть")])),
            question("Есть ли старший смены?", 2, json!([segment("S1", "лицензия стоит сто тысяч")]))
        ] }))
        .unwrap();
        let given = context();
        let similarity = TrigramSimilarity::default();
        let checked = validate(&patch, &given, &similarity);
        assert_eq!(checked.indices, vec![0, 1, 2]);

        let mut fresh = given.clone();
        fresh.questions[0].status = QuestionStatus::Hidden;
        let rechecked = recheck(&patch, checked, &fresh, &similarity);
        assert_eq!(rechecked.indices, vec![0, 2]);
        assert!(matches!(
            rechecked.patch.ops[..],
            [
                ValidatedOp::SetCardField { .. },
                ValidatedOp::AddQuestion(_)
            ]
        ));
        assert_eq!(
            rechecked
                .rejected
                .iter()
                .map(|r| (r.index, &r.reason))
                .collect::<Vec<_>>(),
            vec![
                (
                    1,
                    &RejectReason::Stale {
                        cause: Box::new(RejectReason::QuestionClosed {
                            question_id: "Q1".to_owned(),
                            status: QuestionStatus::Hidden
                        })
                    }
                ),
                (
                    3,
                    &RejectReason::QuoteNotFound {
                        id: "S1".to_owned(),
                        quote: "лицензия стоит сто тысяч".to_owned()
                    }
                ),
            ]
        );
        let logged = rechecked.rejected_json();
        assert_eq!(logged[0]["reason"], "stale");
        assert_eq!(logged[0]["cause"]["reason"], "questionClosed");

        // Nothing changed: the same patch.
        let again = recheck(
            &patch,
            validate(&patch, &given, &similarity),
            &given,
            &similarity,
        );
        assert_eq!(again, validate(&patch, &given, &similarity));
    }

    /// «Три вопроса за вызов»: the two most important are taken.
    #[test]
    fn at_most_two_new_questions_by_priority() {
        let evidence = json!([segment("S1", "пять операторов в смену")]);
        let validation = check(json!([
            question("Есть ли старший смены?", 1, evidence.clone()),
            question("Что слышит клиент, когда все заняты?", 3, evidence.clone()),
            question("Как распределяются звонки?", 2, evidence.clone()),
            question("Нужны ли отчёты по пропущенным?", 2, evidence)
        ]));
        // In the patch order; equal priorities go in the patch order.
        assert_eq!(
            added(&validation),
            vec![
                "Что слышит клиент, когда все заняты?",
                "Как распределяются звонки?"
            ]
        );
        assert_eq!(
            validation
                .rejected
                .iter()
                .map(|r| (r.index, &r.reason))
                .collect::<Vec<_>>(),
            vec![(0, &RejectReason::OverLimit), (3, &RejectReason::OverLimit)]
        );
    }

    /// «Повтор скрытого вопроса», and repeats of open, answered and earlier
    /// questions of the patch; a repeat does not take one of the two places.
    #[test]
    fn repeats_are_rejected() {
        let evidence = json!([segment("S1", "пять операторов в смену")]);
        let validation = check(json!([
            question("Сколько операторов работает в смену?", 3, evidence.clone()),
            question("Ночью кто отвечает на звонок?", 3, evidence.clone()),
            question("Какая CRM сейчас?", 2, evidence.clone()),
            question("Как распределяются звонки?", 2, evidence.clone()),
            question("Как звонки распределяются?", 1, evidence.clone()),
            question("Что слышит клиент, когда все заняты?", 1, evidence)
        ]));
        let of: Vec<(usize, &str)> = validation
            .rejected
            .iter()
            .map(|r| match &r.reason {
                RejectReason::Repeat { of, score } => {
                    assert!(*score >= TrigramSimilarity::DEFAULT_THRESHOLD);
                    (r.index, of.as_str())
                }
                other => (
                    r.index,
                    if *other == RejectReason::OverLimit {
                        "limit"
                    } else {
                        "?"
                    },
                ),
            })
            .collect();
        assert_eq!(of, vec![(0, "Q2"), (1, "Q1"), (2, "Q3"), (4, "op 3")]);
        assert_eq!(
            added(&validation),
            vec![
                "Как распределяются звонки?",
                "Что слышит клиент, когда все заняты?"
            ]
        );
    }

    #[test]
    fn builds_the_context_from_the_call_state() {
        use crate::storage::call_state::{CallState, CardField, TaskCard, TaskCardDecision, Topic};
        let topic = Topic {
            id: "T1".to_owned(),
            recording_id: "R".to_owned(),
            call_id: None,
            title: "Очередь".to_owned(),
            position: 0,
            created_at: 0,
            updated_at: 0,
        };
        let card = TaskCard {
            id: "K1".to_owned(),
            topic_id: "T1".to_owned(),
            recording_id: "R".to_owned(),
            call_id: None,
            title: "Очередь".to_owned(),
            fields: vec![CardField {
                field: CardLens::Users,
                value: "5".to_owned(),
                evidence: Vec::new(),
                updated_at: 0,
            }],
            decision: TaskCardDecision::Pending,
            created_at: 0,
            updated_at: 0,
        };
        let state = CallState {
            recording_id: "R".to_owned(),
            topics: vec![topic],
            current_topic_id: Some("T1".to_owned()),
            cards: vec![card],
            questions: Vec::new(),
            final_check: None,
        };
        let context =
            CallContext::new(&state, vec![SourceText::said("S1", OTHERS, S1)], Vec::new());
        assert_eq!(context.topic_ids, vec!["T1".to_owned()]);
        assert_eq!(context.card_fields["T1"], vec![CardLens::Users]);
        assert!(!context.final_check);
        assert_eq!(context.segments.len(), 1);
    }
}
