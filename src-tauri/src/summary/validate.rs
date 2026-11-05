//! The checks of the agent's replies before they are saved (design.md,
//! decisions 4 and 6). What fails is dropped (or downgraded) and the reason
//! logged; the rest becomes what `summaries::save_build` saves.
//!
//! - A reference (`S#`, `T#`, `Q#`, `H#`, `P#`, `B#`) that was not in the
//!   message is dropped.
//! - A quote must be long enough and found in its source
//!   (`fast_loop::evidence`), a segment of the chosen pass as sent.
//! - A point of a topic and an answer rest on a phrase of the client
//!   («Остальные»); a point without one is dropped (`call-summary`: a point
//!   whose basis is not in the transcript is not shown). A fact of a card
//!   and a `said` proposal may rest on the project instead; a fact without
//!   a found quote becomes «вывод агента» (an assumption without a quote),
//!   a proposal without one becomes `inferred`.
//! - A contradiction needs two different phrases of the client; with fewer
//!   it becomes an assumption.
//! - At most 12 topics, 5 questions for the next call, 12 proposals.
//! - A proposal's `before` is the current value, taken from the brief or the
//!   profile, never from the agent; a proposal equal to it is dropped; the
//!   levels `tech` and `project` are only 1–5.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    input::{PORTRAIT_LABELS, SegmentRef, SummaryMessage},
    reply::{EvidenceReply, FactReply, ProposalsReply, SummaryReply},
};
use crate::{
    agent::fast_loop::evidence::{normalize, quote_long_enough, quote_matches},
    storage::{
        call_state::{CardLens, Evidence, EvidenceSource, QuestionStatus, TaskCardDecision},
        new_id,
        people::Person,
        proposals::{NewProposal, ProposalKind, ProposalTarget},
        summaries::{
            AnsweredQuestion, CallEvidence, CardFact, FactSource, FactStatus, NextQuestion,
            PointStatus, ReadySummary, SegmentMoment, SummaryCard, SummaryCardField,
            SummaryContent, SummaryPoint, SummaryTopic, SummaryTranscriptPass,
        },
        transcript::TranscriptChannel,
    },
};

pub const MAX_TOPICS: usize = 12;
pub const MAX_NEXT: usize = 5;
pub const MAX_PROPOSALS: usize = 12;
/// Quotes kept per point, fact or proposal (the schema asks for 1–3).
const MAX_EVIDENCE: usize = 3;

/// The brief's fields a proposal may update.
pub const BRIEF_FIELDS: [&str; 4] = ["product", "stack", "modules", "glossary"];
/// A profile's fields, but the portrait's.
pub const PERSON_FIELDS: [&str; 5] = ["role", "tech", "project", "howToAsk", "notes"];

/// What call A gave, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckedSummary {
    pub summary: ReadySummary,
    pub answered: Vec<AnsweredQuestion>,
    /// Why parts were dropped or downgraded, for the log.
    pub dropped: Vec<String>,
}

/// What the references of an `evidence` list rest on.
#[derive(Debug, Default)]
struct Basis {
    /// Found quotes of the client, one per segment, in the reply's order.
    client: Vec<CallEvidence>,
    /// A found quote of a project item.
    project: bool,
}

/// `S12`, also `[S12]` or `S:12` as the agent may copy them.
fn bare(id: &str) -> String {
    id.trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .replace(':', "")
        .trim()
        .to_owned()
}

fn found(quote: &str, source: &str) -> bool {
    quote_long_enough(quote, source) && quote_matches(quote, source)
}

fn evidence_of(segment: &SegmentRef, quote: &str) -> CallEvidence {
    CallEvidence {
        recording_id: segment.recording_id.clone(),
        segment_id: segment.segment_id.clone(),
        start_ms: segment.start_ms,
        quote: quote.trim().to_owned(),
    }
}

fn check(
    evidence: &[EvidenceReply],
    message: &SummaryMessage,
    what: &str,
    dropped: &mut Vec<String>,
) -> Basis {
    let mut basis = Basis::default();
    for item in evidence {
        let id = bare(&item.id);
        if let Some(segment) = message.segments.get(&id) {
            if !found(&item.quote, &segment.text) {
                dropped.push(format!("{what}: цитаты «{}» нет в {id}", item.quote));
            } else if segment.channel == TranscriptChannel::Others {
                let seen = basis
                    .client
                    .iter()
                    .any(|known| known.segment_id == segment.segment_id);
                if !seen && basis.client.len() < MAX_EVIDENCE {
                    basis.client.push(evidence_of(segment, &item.quote));
                }
            }
        } else if let Some(text) = message.project_items.get(&id) {
            if found(&item.quote, text) {
                basis.project = true;
            } else {
                dropped.push(format!("{what}: цитаты «{}» нет в {id}", item.quote));
            }
        } else {
            dropped.push(format!("{what}: {id} не было во входе"));
        }
    }
    basis
}

fn moment(segment: &SegmentRef) -> SegmentMoment {
    SegmentMoment {
        recording_id: segment.recording_id.clone(),
        segment_id: segment.segment_id.clone(),
        start_ms: segment.start_ms,
        end_ms: segment.end_ms,
    }
}

fn fact(
    reply: &FactReply,
    message: &SummaryMessage,
    dropped: &mut Vec<String>,
) -> Option<CardFact> {
    let text = reply.text.trim().to_owned();
    if text.is_empty() {
        return None;
    }
    let agent = |status| CardFact {
        text: text.clone(),
        status,
        source: FactSource::Agent,
        evidence: Vec::new(),
    };
    if reply.status == FactStatus::Empty {
        return Some(agent(FactStatus::Empty));
    }
    let basis = check(&reply.evidence, message, &format!("факт «{text}»"), dropped);
    let status = match reply.status {
        FactStatus::Contradiction if basis.client.len() < 2 => {
            dropped.push(format!("факт «{text}»: противоречие без двух фраз клиента"));
            FactStatus::Assumption
        }
        status => status,
    };
    if !basis.client.is_empty() {
        return Some(CardFact {
            text,
            status,
            source: FactSource::Client,
            evidence: basis.client,
        });
    }
    if basis.project {
        return Some(CardFact {
            source: FactSource::Project,
            ..agent(status)
        });
    }
    if status != FactStatus::Assumption {
        dropped.push(format!(
            "факт «{text}»: цитаты не нашлись, это вывод агента"
        ));
    }
    Some(agent(FactStatus::Assumption))
}

/// Call A's reply as a summary of `pass`, with the answered questions.
pub fn summary(
    reply: SummaryReply,
    message: &SummaryMessage,
    pass: SummaryTranscriptPass,
) -> CheckedSummary {
    let mut dropped = Vec::new();
    // (position in the reply, the topic, its card)
    let mut topics: Vec<(usize, SummaryTopic, SummaryCard, usize)> = Vec::new();
    for (index, topic) in reply.topics.iter().enumerate() {
        let title = topic.title.trim().to_owned();
        if title.is_empty() {
            dropped.push(format!("тема {}: без названия", index + 1));
            continue;
        }
        if topics.len() == MAX_TOPICS {
            dropped.push(format!("тема «{title}»: больше {MAX_TOPICS} тем"));
            continue;
        }
        let what = format!("тема «{title}»");
        let mut topic_ids = Vec::new();
        for reference in &topic.refs {
            match message.topics.get(&bare(reference)) {
                Some(id) if !topic_ids.contains(id) => topic_ids.push(id.clone()),
                Some(_) => {}
                None => dropped.push(format!("{what}: {reference} не было во входе")),
            }
        }
        let mut points = Vec::new();
        for point in &topic.points {
            let text = point.text.trim().to_owned();
            if text.is_empty() {
                continue;
            }
            let basis = check(
                &point.evidence,
                message,
                &format!("пункт «{text}»"),
                &mut dropped,
            );
            if basis.client.is_empty() {
                dropped.push(format!("пункт «{text}»: нет фразы клиента"));
                continue;
            }
            let status = match point.status {
                PointStatus::Contradiction if basis.client.len() < 2 => {
                    dropped.push(format!(
                        "пункт «{text}»: противоречие без двух фраз клиента"
                    ));
                    PointStatus::Assumption
                }
                status => status,
            };
            points.push(SummaryPoint {
                text,
                status,
                evidence: basis.client,
            });
        }
        // The range: as named, else from its points' phrases.
        let quoted: Vec<&SegmentRef> = points
            .iter()
            .flat_map(|point| &point.evidence)
            .filter_map(|evidence| {
                message
                    .segments
                    .values()
                    .find(|segment| segment.segment_id == evidence.segment_id)
            })
            .collect();
        let named_from = message.segments.get(&bare(&topic.from));
        let named_to = message.segments.get(&bare(&topic.to));
        let from = named_from
            .or_else(|| quoted.iter().min_by_key(|segment| segment.number).copied())
            .or(named_to);
        let to = named_to
            .or_else(|| quoted.iter().max_by_key(|segment| segment.number).copied())
            .or(named_from);
        let (Some(mut from), Some(mut to)) = (from, to) else {
            dropped.push(format!("{what}: нет ни начала, ни пунктов"));
            continue;
        };
        if from.number > to.number {
            std::mem::swap(&mut from, &mut to);
        }
        let topic_id = new_id();
        let mut fields: Vec<SummaryCardField> = Vec::new();
        for field in &topic.card.fields {
            let facts: Vec<CardFact> = field
                .facts
                .iter()
                .filter_map(|reply| fact(reply, message, &mut dropped))
                .collect();
            if facts.is_empty() {
                continue;
            }
            match fields.iter_mut().find(|known| known.field == field.field) {
                Some(known) => known.facts.extend(facts),
                None => fields.push(SummaryCardField {
                    field: field.field,
                    facts,
                }),
            }
        }
        fields.sort_by_key(|field| CardLens::ALL.iter().position(|lens| *lens == field.field));
        let card_title = topic.card.title.trim();
        let card = SummaryCard {
            id: new_id(),
            topic_id: topic_id.clone(),
            title: if card_title.is_empty() {
                title.clone()
            } else {
                card_title.to_owned()
            },
            decision: TaskCardDecision::Pending,
            fields,
        };
        let order = from.number;
        topics.push((
            index,
            SummaryTopic {
                id: topic_id,
                topic_ids,
                title,
                from: moment(from),
                to: moment(to),
                points,
            },
            card,
            order,
        ));
    }
    // In the order of the call.
    topics.sort_by_key(|(_, _, _, order)| *order);
    let by_position: HashMap<usize, String> = topics
        .iter()
        .map(|(index, topic, _, _)| (index + 1, topic.id.clone()))
        .collect();

    let mut answered: Vec<AnsweredQuestion> = Vec::new();
    for answer in &reply.answered {
        let id = bare(&answer.question);
        let Some(question) = message.questions.get(&id) else {
            dropped.push(format!("ответ: {id} не было во входе"));
            continue;
        };
        if !matches!(
            question.status,
            QuestionStatus::Open | QuestionStatus::Asked
        ) {
            dropped.push(format!("ответ на {id}: вопрос не открыт"));
            continue;
        }
        if answered
            .iter()
            .any(|known| known.question_id == question.id)
        {
            continue;
        }
        let basis = check(
            &answer.evidence,
            message,
            &format!("ответ на {id}"),
            &mut dropped,
        );
        if basis.client.is_empty() {
            dropped.push(format!("ответ на {id}: нет фразы клиента"));
            continue;
        }
        answered.push(AnsweredQuestion {
            question_id: question.id.clone(),
            evidence: basis
                .client
                .into_iter()
                .map(|evidence| Evidence {
                    source: EvidenceSource::Segment,
                    id: evidence.segment_id,
                    quote: evidence.quote,
                })
                .collect(),
        });
    }

    let mut next = Vec::new();
    for question in &reply.next {
        let text = question.text.trim().to_owned();
        if text.is_empty() {
            continue;
        }
        if next.len() == MAX_NEXT {
            dropped.push(format!(
                "вопрос на следующий раз «{text}»: больше {MAX_NEXT}"
            ));
            continue;
        }
        let topic_id = question
            .topic
            .and_then(|position| usize::try_from(position).ok())
            .and_then(|position| by_position.get(&position).cloned());
        next.push(NextQuestion {
            text,
            topic_id,
            field: question.field,
            gap: question.gap,
        });
    }

    let mut title = reply.title.trim().to_owned();
    if title.is_empty()
        && let Some((_, topic, _, _)) = topics.first()
    {
        title.clone_from(&topic.title);
    }
    let (topics, cards) = topics
        .into_iter()
        .map(|(_, topic, card, _)| (topic, card))
        .unzip();
    CheckedSummary {
        summary: ReadySummary {
            title,
            tldr: reply.tldr.trim().to_owned(),
            transcript_pass: pass,
            content: SummaryContent {
                topics,
                cards,
                next,
            },
        },
        answered,
        dropped,
    }
}

/* Proposals */

/// The current brief and the people of the call's project, read just
/// before saving.
#[derive(Debug, Clone, Copy)]
pub struct Knowledge<'a> {
    pub brief: Option<&'a Value>,
    pub people: &'a [Person],
}

fn text_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.trim().to_owned()).filter(|text| !text.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn same(a: &str, b: &str) -> bool {
    normalize(a) == normalize(b)
}

/// `name` of `name — about` (also `name - about`, `name: about`).
fn entry_name(text: &str) -> &str {
    ["—", " - ", ":"]
        .iter()
        .find_map(|separator| text.split_once(separator))
        .map_or(text, |(name, _)| name)
        .trim()
}

/// Of a list field of the brief: the entry `after` updates, as
/// `name — about`; `None` for a new one.
fn brief_entry(brief: Option<&Value>, field: &str, after: &str) -> Option<String> {
    let entries = brief?.get(field)?.as_array()?;
    let (name_key, about_key) = match field {
        "modules" => ("name", "description"),
        _ => ("term", "definition"),
    };
    let name = entry_name(after);
    entries.iter().find_map(|entry| {
        let known = text_value(entry.get(name_key))?;
        if !same(&known, name) {
            return None;
        }
        Some(match text_value(entry.get(about_key)) {
            Some(about) => format!("{known} — {about}"),
            None => known,
        })
    })
}

/// What the proposal finds now, and whether it would change nothing.
fn current(
    target: ProposalTarget,
    person: Option<&Person>,
    field: &str,
    after: &str,
    knowledge: &Knowledge,
) -> (Option<String>, bool) {
    match (target, person) {
        (ProposalTarget::Brief, _) => match field {
            "product" => {
                let before = text_value(knowledge.brief.and_then(|brief| brief.get("product")));
                let equal = before.as_deref().is_some_and(|before| same(before, after));
                (before, equal)
            }
            "stack" => {
                let known = knowledge
                    .brief
                    .and_then(|brief| brief.get("stack"))
                    .and_then(Value::as_array)
                    .is_some_and(|stack| {
                        stack
                            .iter()
                            .filter_map(|item| text_value(Some(item)))
                            .any(|item| same(&item, after))
                    });
                (None, known)
            }
            _ => {
                let before = brief_entry(knowledge.brief, field, after);
                let equal = before.as_deref().is_some_and(|before| same(before, after));
                (before, equal)
            }
        },
        (ProposalTarget::Person, Some(person)) => {
            let before = if field == "role" {
                Some(person.role.trim().to_owned()).filter(|role| !role.is_empty())
            } else if let Some(label) = field.strip_prefix("portrait:") {
                text_value(
                    person
                        .profile
                        .get("portrait")
                        .and_then(|portrait| portrait.get(label)),
                )
            } else {
                text_value(person.profile.get(field))
            };
            let equal = before.as_deref().is_some_and(|before| same(before, after));
            (before, equal)
        }
        (ProposalTarget::Person, None) => (None, false),
    }
}

/// Call B's reply as the call's new pending proposals. `knowledge` is the
/// brief and the profiles as they are now; nothing for a call without a
/// project.
pub fn proposals(
    reply: ProposalsReply,
    message: &SummaryMessage,
    has_project: bool,
    knowledge: &Knowledge,
    dropped: &mut Vec<String>,
) -> Vec<NewProposal> {
    if !has_project {
        return Vec::new();
    }
    let mut kept: Vec<NewProposal> = Vec::new();
    let mut seen = HashSet::new();
    for proposal in reply.proposals {
        let field = proposal.field.trim().to_owned();
        let mut after = proposal.after.trim().to_owned();
        let what = format!("предложение {} {field} «{after}»", proposal.target);
        if after.is_empty() {
            continue;
        }
        let target = bare(&proposal.target);
        let (target, person) = if target == "brief" {
            if !BRIEF_FIELDS.contains(&field.as_str()) {
                dropped.push(format!("{what}: у брифа нет такого поля"));
                continue;
            }
            (ProposalTarget::Brief, None)
        } else {
            let person = message
                .people
                .get(&target)
                .and_then(|id| knowledge.people.iter().find(|person| &person.id == id));
            let Some(person) = person else {
                dropped.push(format!("{what}: {target} не было во входе"));
                continue;
            };
            let portrait = field
                .strip_prefix("portrait:")
                .is_some_and(|label| PORTRAIT_LABELS.contains(&label));
            if !portrait && !PERSON_FIELDS.contains(&field.as_str()) {
                dropped.push(format!("{what}: у профиля нет такого поля"));
                continue;
            }
            if field == "tech" || field == "project" {
                match after.parse::<u8>() {
                    Ok(level @ 1..=5) => after = level.to_string(),
                    _ => {
                        dropped.push(format!("{what}: уровень только от 1 до 5"));
                        continue;
                    }
                }
            }
            (ProposalTarget::Person, Some(person))
        };
        let (before, equal) = current(target, person, &field, &after, knowledge);
        if equal {
            dropped.push(format!("{what}: уже так"));
            continue;
        }
        let person_id = person.map(|person| person.id.clone());
        if !seen.insert((person_id.clone(), field.clone(), normalize(&after))) {
            continue;
        }
        if kept.len() == MAX_PROPOSALS {
            dropped.push(format!("{what}: больше {MAX_PROPOSALS} предложений"));
            continue;
        }
        let (kind, evidence) = match proposal.kind {
            ProposalKind::Said => {
                let basis = check(&proposal.evidence, message, &what, dropped);
                if basis.client.is_empty() && !basis.project {
                    dropped.push(format!("{what}: цитаты не нашлись, это вывод агента"));
                    (ProposalKind::Inferred, Vec::new())
                } else {
                    (ProposalKind::Said, basis.client)
                }
            }
            ProposalKind::Inferred => (ProposalKind::Inferred, Vec::new()),
        };
        kept.push(NewProposal {
            target,
            person_id,
            field,
            before,
            after,
            kind,
            evidence,
        });
    }
    kept
}
