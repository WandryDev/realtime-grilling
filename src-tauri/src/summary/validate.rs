//! The checks of the agent's replies before they are saved (design.md,
//! decisions 4 and 6). What fails is dropped (or downgraded) and the reason
//! logged; the rest becomes what `summaries::save_build` saves.
//!
//! - A reference (`S#`, `T#`, `Q#`, `H#`, `P#`, `B#`) that was not in the
//!   message is dropped.
//! - A quote must be long enough and found in its source
//!   (`fast_loop::evidence`, negations and numbers exactly), a segment of
//!   the chosen pass as sent. What is kept is the segment's own text of
//!   the match, never the agent's wording. A point or a fact needs a quote
//!   of at least [`MIN_CLAIM_QUOTE_CHARS`] letters: «Да.» backs an answer,
//!   not a fact.
//! - A point of a topic and an answer rest on a phrase of the client
//!   («Остальные»); a point without one is dropped (`call-summary`: a point
//!   whose basis is not in the transcript is not shown), and so is a topic
//!   left without points. A fact of a card may rest on the project instead;
//!   a fact without a found quote becomes «вывод агента» (an assumption
//!   without a quote). A `said` proposal needs a phrase of the client, else
//!   it becomes `inferred`; an `inferred` one keeps the client's quotes it
//!   rests on.
//! - A contradiction needs two different phrases of the client; with fewer
//!   it becomes an assumption.
//! - A question for the next call on a field of a card has the gap that
//!   field has (none: it is dropped); when no question is about an empty
//!   field and a card has one, the code adds one (`call-task-cards`,
//!   «Пустое поле»).
//! - At most 12 topics, 6 points per topic, 4 facts per field, 5 questions
//!   for the next call, 12 proposals; titles and the TL;DR are cut to
//!   [`MAX_TITLE_CHARS`] and [`MAX_TLDR_CHARS`].
//! - No title from the agent: the first topic's, without topics the
//!   project's.
//! - A proposal's `before` is the current value, taken from the brief or the
//!   profile, never from the agent; a proposal equal to it, to one the
//!   manager already accepted or rejected, or (for the brief) to a line the
//!   notes already hold is dropped; the levels `tech` and `project` are only
//!   1–5.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::{
    input::{PORTRAIT_LABELS, SegmentRef, SummaryMessage},
    reply::{EvidenceReply, FactReply, ProposalsReply, SummaryReply},
};
use crate::{
    agent::fast_loop::evidence::{letter_count, normalize, quote_long_enough, quote_span},
    storage::{
        call_state::{
            CardLens, Evidence, EvidenceSource, GapType, QuestionStatus, TaskCardDecision,
        },
        new_id,
        people::Person,
        proposals::{
            NewProposal, Proposal, ProposalDecision, ProposalKind, ProposalTarget, apply::noted,
        },
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
/// Points per topic (the prompt asks for 1–6).
pub const MAX_POINTS: usize = 6;
/// Facts per field of a card (the prompt asks for 1–4).
pub const MAX_FACTS: usize = 4;
/// The call's, a topic's and a card's title (the prompt asks for 2–6
/// words).
pub const MAX_TITLE_CHARS: usize = 120;
/// The TL;DR (2–3 sentences).
pub const MAX_TLDR_CHARS: usize = 600;
/// Letters and digits a quote backing a point or a fact has at least,
/// whatever its source: a one-word reply («Да.») proves no fact.
pub const MIN_CLAIM_QUOTE_CHARS: usize = 10;
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
    /// The reply had topics and none passed the checks: the build fails
    /// rather than save an empty summary over a good one.
    pub nothing_left: bool,
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

/// The text of `source` the quote matched, if it is long enough and found.
fn found<'a>(quote: &str, source: &'a str) -> Option<&'a str> {
    quote_long_enough(quote, source)
        .then(|| quote_span(quote, source))
        .flatten()
}

/// The segment's own words of the match: what the client said.
fn evidence_of(segment: &SegmentRef, span: &str) -> CallEvidence {
    CallEvidence {
        recording_id: segment.recording_id.clone(),
        segment_id: segment.segment_id.clone(),
        start_ms: segment.start_ms,
        quote: span.trim().to_owned(),
    }
}

/// What a cited list backs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Claim {
    /// A point or a fact: a quote of at least [`MIN_CLAIM_QUOTE_CHARS`].
    Statement,
    /// An answer or a proposal: a short reply may be quoted whole.
    Reply,
}

fn check(
    evidence: &[EvidenceReply],
    message: &SummaryMessage,
    what: &str,
    claim: Claim,
    dropped: &mut Vec<String>,
) -> Basis {
    let mut basis = Basis::default();
    for item in evidence {
        let id = bare(&item.id);
        if let Some(segment) = message.segments.get(&id) {
            let Some(span) = found(&item.quote, &segment.text) else {
                dropped.push(format!("{what}: цитаты «{}» нет в {id}", item.quote));
                continue;
            };
            if claim == Claim::Statement && letter_count(span) < MIN_CLAIM_QUOTE_CHARS {
                dropped.push(format!(
                    "{what}: цитата «{span}» из {id} слишком короткая, чтобы на неё опереться"
                ));
                continue;
            }
            if segment.channel != TranscriptChannel::Others {
                dropped.push(format!("{what}: {id} — реплика «Вы», а не клиента"));
                continue;
            }
            let seen = basis
                .client
                .iter()
                .any(|known| known.segment_id == segment.segment_id);
            if !seen && basis.client.len() < MAX_EVIDENCE {
                basis.client.push(evidence_of(segment, span));
            }
        } else if let Some(text) = message.project_items.get(&id) {
            if found(&item.quote, text).is_some() {
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
    let basis = check(
        &reply.evidence,
        message,
        &format!("факт «{text}»"),
        Claim::Statement,
        dropped,
    );
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

/// `text` cut to `max` characters (with «…»), the cut logged.
fn capped(text: &str, max: usize, what: &str, dropped: &mut Vec<String>) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    dropped.push(format!("{what}: длиннее {max} символов, обрезано"));
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.truncate(cut.trim_end().len());
    cut.push('…');
    cut
}

/// The gap of a lens of a card, from its facts: a contradiction, else an
/// assumption, else empty (no facts, or only `empty` ones); `None` when
/// every fact is confirmed.
fn gap_of(card: &SummaryCard, lens: CardLens) -> Option<GapType> {
    let facts: Vec<&CardFact> = card
        .fields
        .iter()
        .filter(|field| field.field == lens)
        .flat_map(|field| &field.facts)
        .collect();
    let has = |status| facts.iter().any(|fact| fact.status == status);
    if has(FactStatus::Contradiction) {
        Some(GapType::Contradiction)
    } else if has(FactStatus::Assumption) {
        Some(GapType::Assumption)
    } else if facts.iter().all(|fact| fact.status == FactStatus::Empty) {
        Some(GapType::Empty)
    } else {
        None
    }
}

/// The question the code asks about an empty lens of a card.
fn empty_lens_question(card: &SummaryCard, lens: CardLens) -> String {
    let question = match lens {
        CardLens::Goal => "зачем это бизнесу?",
        CardLens::Users => "кто этим пользуется и кого это затрагивает?",
        CardLens::Scenarios => "какие основные сценарии?",
        CardLens::EdgeCases => "что делать в крайних и нештатных случаях?",
        CardLens::Integrations => "с какими системами и данными это связано?",
        CardLens::Constraints => "какие сроки, бюджет и ограничения?",
        CardLens::Acceptance => "по каким критериям считать задачу готовой?",
    };
    format!("«{}»: {question}", card.title)
}

/// The first empty lens of the cards, in the call's order: one the agent
/// marked `empty` (it matters for the task), else one it left out.
fn first_empty_lens(cards: &[SummaryCard]) -> Option<(&SummaryCard, CardLens)> {
    let marked = cards.iter().find_map(|card| {
        card.fields
            .iter()
            .find(|field| {
                !field.facts.is_empty()
                    && field
                        .facts
                        .iter()
                        .all(|fact| fact.status == FactStatus::Empty)
            })
            .map(|field| (card, field.field))
    });
    marked.or_else(|| {
        cards.iter().find_map(|card| {
            CardLens::ALL
                .into_iter()
                .find(|lens| card.fields.iter().all(|field| field.field != *lens))
                .map(|lens| (card, lens))
        })
    })
}

/// Call A's reply as a summary of `pass`, with the answered questions.
pub fn summary(
    reply: SummaryReply,
    message: &SummaryMessage,
    pass: SummaryTranscriptPass,
) -> CheckedSummary {
    let mut dropped = Vec::new();
    // (position in the reply, the topic, its card, its order in the call)
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
        let title = capped(&title, MAX_TITLE_CHARS, &what, &mut dropped);
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
                Claim::Statement,
                &mut dropped,
            );
            if basis.client.is_empty() {
                dropped.push(format!("пункт «{text}»: нет фразы клиента"));
                continue;
            }
            if points.len() == MAX_POINTS {
                dropped.push(format!("пункт «{text}»: больше {MAX_POINTS} пунктов темы"));
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
        if points.is_empty() {
            dropped.push(format!("{what}: ни один пункт не прошёл проверку"));
            continue;
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
        let mut named = |reference: &str, end: &str| {
            let found = message.segments.get(&bare(reference));
            if found.is_none() && !reference.trim().is_empty() {
                dropped.push(format!("{what}: {end} {reference} не было во входе"));
            }
            found
        };
        let named_from = named(&topic.from, "начала");
        let named_to = named(&topic.to, "конца");
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
            let known = match fields
                .iter_mut()
                .position(|known| known.field == field.field)
            {
                Some(at) => &mut fields[at],
                None => {
                    fields.push(SummaryCardField {
                        field: field.field,
                        facts: Vec::new(),
                    });
                    fields.last_mut().expect("just pushed")
                }
            };
            for fact in facts {
                if known.facts.len() == MAX_FACTS {
                    dropped.push(format!(
                        "факт «{}»: больше {MAX_FACTS} фактов в поле {}",
                        fact.text,
                        field.field.as_str()
                    ));
                    continue;
                }
                known.facts.push(fact);
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
                capped(
                    card_title,
                    MAX_TITLE_CHARS,
                    &format!("карточка «{card_title}»"),
                    &mut dropped,
                )
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
    let nothing_left = topics.is_empty() && !reply.topics.is_empty();
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
            Claim::Reply,
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
        let card = topic_id.as_ref().and_then(|topic_id| {
            topics
                .iter()
                .find(|(_, topic, _, _)| &topic.id == topic_id)
                .map(|(_, _, card, _)| card)
        });
        // The gap is the field's, as its facts have it.
        let gap = match (card, question.field) {
            (Some(card), Some(lens)) => match gap_of(card, lens) {
                Some(gap) => {
                    if gap != question.gap {
                        dropped.push(format!(
                            "вопрос на следующий раз «{text}»: в поле {} не {}, а {}",
                            lens.as_str(),
                            question.gap.as_str(),
                            gap.as_str()
                        ));
                    }
                    gap
                }
                None => {
                    dropped.push(format!(
                        "вопрос на следующий раз «{text}»: поле {} подтверждено, пробела нет",
                        lens.as_str()
                    ));
                    continue;
                }
            },
            _ => question.gap,
        };
        next.push(NextQuestion {
            text,
            topic_id,
            field: question.field,
            gap,
        });
    }

    let cards: Vec<SummaryCard> = topics.iter().map(|(_, _, card, _)| card.clone()).collect();
    if !next.iter().any(|question| question.gap == GapType::Empty)
        && let Some((card, lens)) = first_empty_lens(&cards)
    {
        if next.len() == MAX_NEXT
            && let Some(last) = next.pop()
        {
            dropped.push(format!(
                "вопрос на следующий раз «{}»: уступил место вопросу о пустом поле",
                last.text
            ));
        }
        dropped.push(format!(
            "вопрос о пустом поле {} карточки «{}» добавлен кодом",
            lens.as_str(),
            card.title
        ));
        next.push(NextQuestion {
            text: empty_lens_question(card, lens),
            topic_id: Some(card.topic_id.clone()),
            field: Some(lens),
            gap: GapType::Empty,
        });
    }

    let mut title = capped(
        &reply.title,
        MAX_TITLE_CHARS,
        "название звонка",
        &mut dropped,
    );
    if title.is_empty() {
        // `call-summary`: by the first topic, without topics by the project.
        match topics.first() {
            Some((_, topic, _, _)) => title.clone_from(&topic.title),
            None => {
                if let Some(project) = &message.project_name {
                    title = capped(project, MAX_TITLE_CHARS, "название проекта", &mut dropped);
                }
            }
        }
    }
    let tldr = capped(&reply.tldr, MAX_TLDR_CHARS, "TL;DR", &mut dropped);
    let topics = topics.into_iter().map(|(_, topic, _, _)| topic).collect();
    CheckedSummary {
        summary: ReadySummary {
            title,
            tldr,
            transcript_pass: pass,
            content: SummaryContent {
                topics,
                cards,
                next,
            },
        },
        answered,
        dropped,
        nothing_left,
    }
}

/* Proposals */

/// The current brief, notes and people of the call's project and the
/// call's proposals, read just before saving.
#[derive(Debug, Clone, Copy)]
pub struct Knowledge<'a> {
    pub brief: Option<&'a Value>,
    /// The project's notes: accepted brief proposals are lines of it.
    pub notes: &'a str,
    pub people: &'a [Person],
    /// Every proposal of the call so far; the decided ones are not
    /// proposed again.
    pub proposals: &'a [Proposal],
}

fn text_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.trim().to_owned()).filter(|text| !text.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

/// Cyrillic letters that look like Latin ones, as the Latin ones: «1С»
/// typed in Cyrillic is «1C».
fn fold_look_alikes(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'а' => 'a',
            'в' => 'b',
            'е' => 'e',
            'і' => 'i',
            'к' => 'k',
            'м' => 'm',
            'н' => 'h',
            'о' => 'o',
            'р' => 'p',
            'с' => 'c',
            'т' => 't',
            'у' => 'y',
            'х' => 'x',
            c => c,
        })
        .collect()
}

/// A value as [`same`] compares it.
fn comparable(text: &str) -> String {
    fold_look_alikes(&normalize(text))
}

fn same(a: &str, b: &str) -> bool {
    comparable(a) == comparable(b)
}

/// `name` of `name — about` (also `name - about`, `name: about`): up to the
/// earliest of these separators.
fn entry_name(text: &str) -> &str {
    ["—", " - ", ":"]
        .iter()
        .filter_map(|separator| text.find(separator))
        .min()
        .map_or(text, |at| &text[..at])
        .trim()
}

/// Whether the manager already accepted or rejected the same proposal.
fn decided(
    proposals: &[Proposal],
    target: ProposalTarget,
    person_id: Option<&str>,
    field: &str,
    after: &str,
) -> Option<ProposalDecision> {
    proposals
        .iter()
        .filter(|known| known.decision != ProposalDecision::Pending)
        .find(|known| {
            known.target == target
                && known.person_id.as_deref() == person_id
                && known.field == field
                && (same(&known.after, after)
                    || known
                        .edited
                        .as_deref()
                        .is_some_and(|edited| same(edited, after)))
        })
        .map(|known| known.decision)
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
        if let Some(decision) = decided(
            knowledge.proposals,
            target,
            person_id.as_deref(),
            &field,
            &after,
        ) {
            let how = match decision {
                ProposalDecision::Rejected => "отклонено",
                _ => "принято",
            };
            dropped.push(format!("{what}: уже {how} менеджером"));
            continue;
        }
        if target == ProposalTarget::Brief && noted(knowledge.notes, &after) {
            dropped.push(format!("{what}: уже в заметках проекта"));
            continue;
        }
        if !seen.insert((person_id.clone(), field.clone(), comparable(&after))) {
            continue;
        }
        if kept.len() == MAX_PROPOSALS {
            dropped.push(format!("{what}: больше {MAX_PROPOSALS} предложений"));
            continue;
        }
        // «said» is the client's words: the project alone makes it the
        // agent's inference. Either kind keeps the client's quotes found.
        let basis = check(&proposal.evidence, message, &what, Claim::Reply, dropped);
        let kind = match proposal.kind {
            ProposalKind::Said if !basis.client.is_empty() => ProposalKind::Said,
            ProposalKind::Said => {
                dropped.push(if basis.project {
                    format!("{what}: опирается только на проект, это вывод агента")
                } else {
                    format!("{what}: цитаты клиента не нашлись, это вывод агента")
                });
                ProposalKind::Inferred
            }
            ProposalKind::Inferred => ProposalKind::Inferred,
        };
        let evidence = basis.client;
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
