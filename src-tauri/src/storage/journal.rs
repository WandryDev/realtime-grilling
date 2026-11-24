//! The agent's journal for the team's analytics (call-analytics design.md,
//! decisions 1, 2 and 4): every call's prompt by parts, the fate of each
//! operation of its reply, and what became of the questions and the
//! findings. Everything here writes in the caller's transaction, next to the
//! change it describes; the rows that point at a call may come before the
//! call's own row (the references are checked at the commit).

use rusqlite::{Connection, params};
use serde_json::Value;

use super::{
    Storage, analytics,
    call_state::{self, AgentCallInput},
    context_findings::FindingSourceKind,
    json::Json,
    new_id, now_ms,
};
use crate::{error::CommandResult, projects::sha256_hex};

/// One part of a prompt: what it is (`file`, `mode`, `transcript`, …) and
/// its text, exactly as it went to the CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptPart {
    pub label: String,
    pub text: String,
}

impl PromptPart {
    pub fn new(label: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            text: text.into(),
        }
    }
}

/// Records the prompt of call `call_id` part by part, in order. A text is
/// stored once however many calls send it. Returns the hashes of the texts
/// stored for the first time (the analytics send each text once).
pub fn prompt(
    connection: &Connection,
    call_id: &str,
    parts: &[PromptPart],
    now: i64,
) -> CommandResult<Vec<String>> {
    let mut new = Vec::new();
    let mut store = connection.prepare_cached(
        "INSERT OR IGNORE INTO prompt_parts (hash, text, bytes, created_at)
         VALUES (?1, ?2, ?3, ?4)",
    )?;
    let mut link = connection.prepare_cached(
        "INSERT INTO agent_call_parts (agent_call_id, ord, label, hash) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (ord, part) in parts.iter().enumerate() {
        let hash = sha256_hex(part.text.as_bytes());
        let bytes = i64::try_from(part.text.len()).unwrap_or(i64::MAX);
        if store.execute(params![hash, part.text, bytes, now])? > 0 && !new.contains(&hash) {
            new.push(hash.clone());
        }
        link.execute(params![call_id, ord_index(ord), part.label, hash])?;
    }
    Ok(new)
}

/// What an operation of a reply created or changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubjectKind {
    Question,
    Topic,
    Card,
    Finding,
}

impl SubjectKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Question => "question",
            Self::Topic => "topic",
            Self::Card => "card",
            Self::Finding => "finding",
        }
    }
}

/// One operation of a call's reply and what became of it.
#[derive(Debug, Clone, PartialEq)]
pub struct CallOp {
    /// The operation's kind as the agent named it (`addQuestion`, …).
    pub op: String,
    /// The operation as the agent returned it.
    pub body: Value,
    pub applied: bool,
    /// Why it was rejected (`RejectReason` and the like, as JSON).
    pub reason: Option<Value>,
    /// The question, topic, card or finding it created or changed.
    pub subject: Option<(SubjectKind, String)>,
}

/// Records the operations of call `call_id` in the reply's order.
pub fn call_ops(connection: &Connection, call_id: &str, ops: &[CallOp]) -> CommandResult<()> {
    let mut insert = connection.prepare_cached(
        "INSERT INTO agent_call_ops
           (agent_call_id, idx, op, body, applied, reason, subject_kind, subject_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    for (idx, op) in ops.iter().enumerate() {
        insert.execute(params![
            call_id,
            ord_index(idx),
            op.op,
            Json(op.body.clone()),
            op.applied,
            op.reason.clone().map(Json),
            op.subject.as_ref().map(|(kind, _)| kind.as_str()),
            op.subject.as_ref().map(|(_, id)| id.as_str()),
        ])?;
    }
    Ok(())
}

/// Records an agent call outside the loops (the summary, the proposals,
/// the brief) in its own transaction. A failure is only logged: the build
/// it belongs to goes on.
pub async fn record(storage: Option<&Storage>, call: AgentCallInput) {
    let Some(storage) = storage else {
        return;
    };
    let kind = call.kind.as_str();
    let saved = storage
        .read(move |connection| {
            let transaction = connection.unchecked_transaction()?;
            call_state::insert_agent_call_at(&transaction, &call, now_ms())?;
            transaction.commit()?;
            Ok(())
        })
        .await;
    if let Err(error) = saved {
        eprintln!("grill: the agent call ({kind}) was not recorded: {error}");
    }
}

/// A chunk of the project's sources the slow loop showed the agent, as the
/// journal keeps it (`C1…` by its place in the search results).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub label: String,
    /// 1 for the best match.
    pub rank: i64,
    pub chunk_key: String,
    pub source_id: Option<String>,
    pub source_kind: FindingSourceKind,
    pub source_name: String,
    pub source_url: Option<String>,
    /// The headings it is under; empty when none.
    pub heading_path: String,
    pub text: String,
}

/// Records the candidates of call `call_id`.
pub fn candidates(
    connection: &Connection,
    call_id: &str,
    candidates: &[Candidate],
) -> CommandResult<()> {
    let mut insert = connection.prepare_cached(
        "INSERT INTO slow_loop_candidates
           (agent_call_id, label, rank, chunk_key, source_id, source_kind, source_name,
            source_url, heading_path, text)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    )?;
    for candidate in candidates {
        insert.execute(params![
            call_id,
            candidate.label,
            candidate.rank,
            candidate.chunk_key,
            candidate.source_id,
            candidate.source_kind.as_str(),
            candidate.source_name,
            candidate.source_url,
            Some(candidate.heading_path.as_str()).filter(|path| !path.is_empty()),
            candidate.text,
        ])?;
    }
    Ok(())
}

/// A step in a question's life (`question_events.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuestionEventKind {
    Created,
    Shown,
    Requeued,
    Unshown,
    Pinned,
    Unpinned,
    Hidden,
    Restored,
    Asked,
    Answered,
}

impl QuestionEventKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Shown => "shown",
            Self::Requeued => "requeued",
            Self::Unshown => "unshown",
            Self::Pinned => "pinned",
            Self::Unpinned => "unpinned",
            Self::Hidden => "hidden",
            Self::Restored => "restored",
            Self::Asked => "asked",
            Self::Answered => "answered",
        }
    }
}

/// Records a step of question `question_id` of recording `recording_id`.
/// `agent_call_id`: the call that did it; `None` for the manager's actions
/// and the window's own changes. Returns the event's id.
pub fn question_event(
    connection: &Connection,
    question_id: &str,
    recording_id: &str,
    kind: QuestionEventKind,
    agent_call_id: Option<&str>,
    at: i64,
) -> CommandResult<String> {
    let id = new_id();
    connection
        .prepare_cached(
            "INSERT INTO question_events (id, question_id, recording_id, kind, agent_call_id, at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?
        .execute(params![
            id,
            question_id,
            recording_id,
            kind.as_str(),
            agent_call_id,
            at
        ])?;
    analytics::question_step(connection, &id)?;
    Ok(id)
}

/// A step in a finding's life on the screen (`finding_events.kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FindingEventKind {
    Shown,
    Hidden,
    Evicted,
}

impl FindingEventKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Shown => "shown",
            Self::Hidden => "hidden",
            Self::Evicted => "evicted",
        }
    }
}

/// Records a step of finding `finding_id`. Returns the event's id.
pub fn finding_event(
    connection: &Connection,
    finding_id: &str,
    kind: FindingEventKind,
    at: i64,
) -> CommandResult<String> {
    let id = new_id();
    connection
        .prepare_cached(
            "INSERT INTO finding_events (id, finding_id, kind, at) VALUES (?1, ?2, ?3, ?4)",
        )?
        .execute(params![id, finding_id, kind.as_str(), at])?;
    analytics::finding_step(connection, &id)?;
    Ok(id)
}

/// A call whose prompt still rests on a transcript that is kept: a loop's
/// call of a recording with its transcript, a summary or proposals of a call
/// with a recording that keeps its transcript, a project's brief (no
/// transcript in it). `a` is the call.
const ALIVE: &str = "(a.recording_id IS NOT NULL
        AND (SELECT r.transcript_deleted_at FROM recordings r WHERE r.id = a.recording_id) IS NULL)
     OR (a.call_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM recordings r
                     WHERE r.call_id = a.call_id AND r.transcript_deleted_at IS NULL))
     OR a.project_id IS NOT NULL";

/// Clears the texts of the journal that carry the transcript of recording
/// `recording_id`, once its transcript was deleted (`transcriptRetention`,
/// call-analytics design.md, decision 2): the calls' raw replies, the slow
/// loop's candidates, and the parts of the prompts that no call with a kept
/// transcript shares. The summary and the proposals of its call go too once
/// none of the call's recordings keeps a transcript. The calls, their
/// tokens, operations and links stay. Parts no call refers to any more are
/// removed.
pub fn clear_texts(connection: &Connection, recording_id: &str) -> CommandResult<()> {
    let calls: Vec<String> = connection
        .prepare(
            "SELECT a.id FROM agent_calls a WHERE a.recording_id = ?1
             UNION
             SELECT a.id FROM agent_calls a
               JOIN recordings r ON r.call_id = a.call_id
              WHERE r.id = ?1
                AND NOT EXISTS (SELECT 1 FROM recordings o
                                 WHERE o.call_id = a.call_id AND o.transcript_deleted_at IS NULL)",
        )?
        .query_map([recording_id], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let calls = Json(Value::from(calls));
    connection.execute(
        "UPDATE agent_calls SET raw_reply = NULL
          WHERE id IN (SELECT value FROM json_each(?1)) AND raw_reply IS NOT NULL",
        [&calls],
    )?;
    connection.execute(
        "UPDATE slow_loop_candidates SET text = NULL
          WHERE agent_call_id IN (SELECT value FROM json_each(?1)) AND text IS NOT NULL",
        [&calls],
    )?;
    connection.execute(
        &format!(
            "UPDATE prompt_parts SET text = NULL
              WHERE text IS NOT NULL
                AND hash IN (SELECT p.hash FROM agent_call_parts p
                              WHERE p.agent_call_id IN (SELECT value FROM json_each(?1)))
                AND NOT EXISTS (SELECT 1 FROM agent_call_parts p
                                  JOIN agent_calls a ON a.id = p.agent_call_id
                                 WHERE p.hash = prompt_parts.hash AND ({ALIVE}))"
        ),
        [&calls],
    )?;
    connection.execute(
        "DELETE FROM prompt_parts
          WHERE NOT EXISTS (SELECT 1 FROM agent_call_parts p WHERE p.hash = prompt_parts.hash)",
        [],
    )?;
    Ok(())
}

fn ord_index(index: usize) -> i64 {
    i64::try_from(index).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests;
