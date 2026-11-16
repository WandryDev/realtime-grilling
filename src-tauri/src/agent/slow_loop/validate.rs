//! The reply of a slow-loop call and its checks (agent-slow-loop design.md,
//! decision 4). A finding is dropped, with its reason in
//! `agent_calls.rejected`, when its candidate was not in the call, its
//! quote is shorter than three words or not (fuzzily) in the candidate's
//! text (the thresholds of the fast loop, `evidence.rs`), its question is
//! not open, it repeats a finding of the recording (the same chunk, or a
//! quote with a trigram similarity of [`REPEAT_SIMILARITY`] or more, shown,
//! hidden or evicted), or it is past the second of the call.

use std::{collections::HashSet, fmt};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::search::Candidate;
use crate::{
    agent::fast_loop::{
        assembly::one_line,
        evidence::{quote_long_enough, quote_matches, quote_span},
        similarity::{QuestionSimilarity, TrigramSimilarity},
    },
    storage::context_findings::KnownFinding,
};

/// Findings accepted from one call.
pub const MAX_FINDINGS: usize = 2;
/// Queries kept for the next call…
pub const MAX_QUERIES: usize = 3;
/// … each of at most this many words.
pub const QUERY_WORDS: usize = 8;
/// A note is cut to this many characters.
pub const NOTE_CHARS: usize = 140;
/// From this similarity of the quotes on, a finding repeats another.
pub const REPEAT_SIMILARITY: f64 = 0.8;

/// A finding as the agent returned it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingReply {
    pub candidate: String,
    pub quote: String,
    pub note: String,
    #[serde(default)]
    pub question_id: Option<String>,
}

/// The agent's reply.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Reply {
    pub findings: Vec<FindingReply>,
    #[serde(default)]
    pub queries: Vec<String>,
}

/// `[C1]`, `Q:…` as the message shows them, back to bare ids.
fn bare(text: &str, prefix: &str) -> String {
    let text = text.trim().trim_start_matches('[').trim_end_matches(']');
    text.strip_prefix(prefix).unwrap_or(text).trim().to_owned()
}

impl Reply {
    /// The reply of `value`: the ids without their brackets and prefixes,
    /// at most [`MAX_QUERIES`] queries of at most [`QUERY_WORDS`] words.
    /// `Err` with the reason when it is not a reply.
    pub fn parse(value: Value) -> Result<Self, String> {
        let mut reply: Self = serde_json::from_value(value).map_err(|error| error.to_string())?;
        for finding in &mut reply.findings {
            finding.candidate = bare(&finding.candidate, "").to_uppercase();
            finding.question_id = finding
                .question_id
                .as_deref()
                .map(|id| bare(id, "Q:"))
                .filter(|id| !id.is_empty());
        }
        reply.queries = reply
            .queries
            .iter()
            .map(|query| {
                query
                    .split_whitespace()
                    .take(QUERY_WORDS)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .filter(|query| !query.is_empty())
            .take(MAX_QUERIES)
            .collect();
        Ok(reply)
    }
}

/// What a call was given and what the recording has: the candidates
/// (`C1` first), the open questions, the findings so far.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SlowContext {
    pub candidates: Vec<Candidate>,
    pub open_questions: Vec<String>,
    pub known: Vec<KnownFinding>,
}

impl SlowContext {
    fn candidate(&self, id: &str) -> Option<&Candidate> {
        let number: usize = id.strip_prefix('C')?.parse().ok()?;
        self.candidates.get(number.checked_sub(1)?)
    }
}

/// Why a finding was dropped.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SlowRejectReason {
    UnknownCandidate,
    /// «цитата не найдена».
    QuoteNotFound {
        quote: String,
    },
    QuoteTooShort {
        quote: String,
    },
    Blank {
        field: &'static str,
    },
    /// The question is not an open one of the recording.
    QuestionNotOpen {
        question_id: String,
    },
    /// The same chunk or quote as a finding of the recording (`of`: its id)
    /// or an earlier one of the reply (`finding <index>`).
    Repeat {
        of: String,
        score: f64,
    },
    /// Past [`MAX_FINDINGS`].
    OverLimit,
    /// [`MAX_VISIBLE`](crate::storage::context_findings::MAX_VISIBLE) are
    /// shown and each is about a question.
    NoRoom,
    /// Passed with the state the call was given, not with the state it was
    /// stored in.
    Stale {
        cause: Box<SlowRejectReason>,
    },
}

/// A dropped finding, for `agent_calls.rejected` (the shape of the fast
/// loop's: `index`, `op`, `subject`, `reason`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlowRejection {
    pub index: usize,
    pub op: &'static str,
    /// The candidate it named.
    pub subject: String,
    #[serde(flatten)]
    pub reason: SlowRejectReason,
}

impl fmt::Display for SlowRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = serde_json::to_string(&self.reason).unwrap_or_default();
        write!(f, "finding {} ({}): {reason}", self.index, self.subject)
    }
}

/// A finding that passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accepted {
    pub candidate: Candidate,
    /// In the candidate's own spelling.
    pub quote: String,
    /// On one line, at most [`NOTE_CHARS`].
    pub note: String,
    pub question_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlowValidation {
    /// With their index in the reply.
    pub accepted: Vec<(usize, Accepted)>,
    pub rejected: Vec<SlowRejection>,
}

#[cfg(test)]
impl SlowValidation {
    /// `rejected` as `agent_calls.rejected` stores it.
    pub fn rejected_json(&self) -> Value {
        serde_json::to_value(&self.rejected).unwrap_or_else(|_| Value::Array(Vec::new()))
    }
}

fn note(text: &str) -> String {
    let line = one_line(text);
    match line.char_indices().nth(NOTE_CHARS) {
        Some((at, _)) => line[..at].trim_end().to_owned(),
        None => line,
    }
}

/// One finding on its own, against the context and what was taken before.
fn check(
    finding: &FindingReply,
    context: &SlowContext,
    taken: &[(usize, Accepted)],
) -> Result<Accepted, SlowRejectReason> {
    let Some(candidate) = context.candidate(&finding.candidate) else {
        return Err(SlowRejectReason::UnknownCandidate);
    };
    let quote = finding.quote.trim();
    if !quote_long_enough(quote, &candidate.text) {
        return Err(SlowRejectReason::QuoteTooShort {
            quote: quote.to_owned(),
        });
    }
    if !quote_matches(quote, &candidate.text) {
        return Err(SlowRejectReason::QuoteNotFound {
            quote: quote.to_owned(),
        });
    }
    let note = note(&finding.note);
    if note.is_empty() {
        return Err(SlowRejectReason::Blank { field: "note" });
    }
    if let Some(question_id) = &finding.question_id
        && !context.open_questions.contains(question_id)
    {
        return Err(SlowRejectReason::QuestionNotOpen {
            question_id: question_id.clone(),
        });
    }
    let quote = quote_span(quote, &candidate.text)
        .map_or_else(|| quote.to_owned(), |span| span.trim().to_owned());
    let similarity = TrigramSimilarity::default();
    let known = context.known.iter().map(|known| {
        (
            known.id.clone(),
            known.chunk_key.as_str(),
            known.quote.as_str(),
        )
    });
    let earlier = taken.iter().map(|(index, accepted)| {
        (
            format!("finding {index}"),
            accepted.candidate.key.as_str(),
            accepted.quote.as_str(),
        )
    });
    let repeat = known
        .chain(earlier)
        .map(|(of, chunk, other)| {
            let score = if chunk == candidate.key {
                1.0
            } else {
                similarity.score(&quote, other)
            };
            (of, score)
        })
        .filter(|(_, score)| *score >= REPEAT_SIMILARITY)
        .max_by(|a, b| a.1.total_cmp(&b.1));
    if let Some((of, score)) = repeat {
        return Err(SlowRejectReason::Repeat { of, score });
    }
    Ok(Accepted {
        candidate: candidate.clone(),
        quote,
        note,
        question_id: finding.question_id.clone(),
    })
}

/// Checks the findings of `reply` in their order; at most [`MAX_FINDINGS`]
/// are accepted. Never fails: what doesn't pass is in `rejected`.
pub fn validate(reply: &Reply, context: &SlowContext) -> SlowValidation {
    let mut validation = SlowValidation::default();
    for (index, finding) in reply.findings.iter().enumerate() {
        let reject = |reason| SlowRejection {
            index,
            op: "finding",
            subject: finding.candidate.clone(),
            reason,
        };
        match check(finding, context, &validation.accepted) {
            Err(reason) => validation.rejected.push(reject(reason)),
            Ok(_) if validation.accepted.len() >= MAX_FINDINGS => {
                validation
                    .rejected
                    .push(reject(SlowRejectReason::OverLimit));
            }
            Ok(accepted) => validation.accepted.push((index, accepted)),
        }
    }
    validation
}

/// `checked` checked once more with `fresh`, the context of the
/// transaction that stores it: what passed only the first check is
/// [`SlowRejectReason::Stale`].
pub fn recheck(reply: &Reply, checked: SlowValidation, fresh: &SlowContext) -> SlowValidation {
    let again = validate(reply, fresh);
    let passed: HashSet<usize> = again.accepted.iter().map(|(index, _)| *index).collect();
    let mut rejected = checked.rejected;
    let mut accepted = Vec::new();
    for (index, finding) in checked.accepted {
        if passed.contains(&index) {
            accepted.push((index, finding));
        } else if let Some(failed) = again.rejected.iter().find(|r| r.index == index) {
            rejected.push(SlowRejection {
                reason: SlowRejectReason::Stale {
                    cause: Box::new(failed.reason.clone()),
                },
                ..failed.clone()
            });
        }
    }
    rejected.sort_by_key(|rejection| rejection.index);
    SlowValidation { accepted, rejected }
}

#[cfg(test)]
mod tests;
