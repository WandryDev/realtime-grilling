//! What the build sends on stdin (design.md, decision 4): the description,
//! the notes, the people and the documents as `F1…Fn` with their names and
//! text. Over [`BUDGET_CHARS`] the documents are shortened in proportion to
//! their size, each keeping its head, and the agent is told so.

use std::collections::HashMap;

use serde_json::Value;

use crate::projects::brief_inputs::{BriefInputs, BriefPerson};

/// The whole message, in characters (~100k tokens).
pub const BUDGET_CHARS: usize = 300_000;

/// Profile fields of a person in the words of the message.
const PROFILE_FIELDS: [(&str, &str); 6] = [
    ("portrait", "Портрет"),
    ("notes", "Заметки"),
    ("howToAsk", "Как спрашивать"),
    ("askStyle", "Стиль вопросов"),
    ("tech", "Технический уровень (1–5)"),
    ("project", "Понимание проекта (1–5)"),
];
/// Profile fields that are only for the screens.
const PROFILE_SKIPPED: [&str; 2] = ["initials", "edits"];

const SHORTENED: &str = "Материалы сокращены, чтобы уместиться в лимит: от каждого документа \
передано начало, пропорционально его размеру. Документы с пометкой «сокращён» переданы не \
полностью — не делай выводов о том, чего в них нет.";
const CLOSING: &str =
    "Собери бриф по правилам и передай его одним вызовом инструмента StructuredOutput.";

/// The message and what it numbered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BriefMessage {
    pub text: String,
    /// `F1` → the document's id.
    pub documents: HashMap<String, String>,
    /// A document was shortened: here, or when its text was read.
    pub truncated: bool,
}

/// The message for `inputs`, at most about [`BUDGET_CHARS`] characters.
pub fn compose(inputs: &BriefInputs) -> BriefMessage {
    compose_within(inputs, BUDGET_CHARS)
}

pub fn compose_within(inputs: &BriefInputs, budget: usize) -> BriefMessage {
    let mut head = String::from("# Проект\n\n");
    head.push_str(&format!("Название: {}\n", one_line(&inputs.project_name)));
    section(&mut head, "Описание", &inputs.description);
    section(&mut head, "Заметки менеджера", &inputs.notes);
    head.push_str("\n## Люди клиента\n\n");
    if inputs.people.is_empty() {
        head.push_str("Неизвестны.\n");
    }
    for person in &inputs.people {
        head.push_str(&person_line(person));
    }
    head.push_str("\n## Документы\n");

    let titles: Vec<String> = inputs
        .sources
        .iter()
        .enumerate()
        .map(|(index, source)| format!("\n### F{}. {}", index + 1, one_line(&source.name)))
        .collect();
    let lengths: Vec<usize> = inputs
        .sources
        .iter()
        .map(|source| source.text.chars().count())
        .collect();
    let total: usize = lengths.iter().sum();
    // Everything but the documents' text, the shortening note included.
    let frame = [&head, CLOSING, SHORTENED]
        .iter()
        .map(|part| part.chars().count())
        .sum::<usize>()
        + titles
            .iter()
            .map(|title| title.chars().count() + " (сокращён)\n\n\n".chars().count())
            .sum::<usize>()
        + 16;
    let available = budget.saturating_sub(frame);
    let shorten = total > available;

    let mut text = head;
    if inputs.sources.is_empty() {
        text.push_str("\nДокументов нет.\n");
    } else if shorten {
        text.push('\n');
        text.push_str(SHORTENED);
        text.push('\n');
    }
    let mut documents = HashMap::new();
    let mut truncated = false;
    for (index, source) in inputs.sources.iter().enumerate() {
        documents.insert(format!("F{}", index + 1), source.id.clone());
        let keep = if shorten {
            share(lengths[index], available, total)
        } else {
            lengths[index]
        };
        let cut = keep < lengths[index];
        let shortened = cut || source.truncated;
        truncated |= shortened;
        text.push_str(&titles[index]);
        if shortened {
            text.push_str(" (сокращён)");
        }
        text.push_str("\n\n");
        text.push_str(head_of(&source.text, keep).trim_end());
        text.push('\n');
    }
    text.push_str("\n---\n\n");
    text.push_str(CLOSING);
    BriefMessage {
        text,
        documents,
        truncated,
    }
}

/// `length × available / total`, rounded down.
fn share(length: usize, available: usize, total: usize) -> usize {
    if total == 0 {
        return length;
    }
    let share = (length as u128 * available as u128) / total as u128;
    usize::try_from(share).unwrap_or(length).min(length)
}

/// The first `chars` characters.
fn head_of(text: &str, chars: usize) -> &str {
    match text.char_indices().nth(chars) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

fn section(out: &mut String, title: &str, body: &str) {
    out.push_str(&format!("\n## {title}\n\n"));
    let body = body.trim();
    out.push_str(if body.is_empty() { "Нет." } else { body });
    out.push('\n');
}

/// `- Имя — роль. Портрет: ….`
fn person_line(person: &BriefPerson) -> String {
    let mut line = format!("- {}", one_line(&person.name));
    let role = one_line(&person.role);
    if !role.is_empty() {
        line.push_str(&format!(" — {role}"));
    }
    line.push('.');
    for (key, label) in PROFILE_FIELDS {
        if let Some(value) = person.profile.get(key).and_then(scalar) {
            line.push_str(&format!(" {label}: {value}."));
        }
    }
    if let Some(profile) = person.profile.as_object() {
        for (key, value) in profile {
            let listed = PROFILE_FIELDS.iter().any(|(name, _)| name == key);
            if listed || PROFILE_SKIPPED.contains(&key.as_str()) {
                continue;
            }
            if let Some(value) = scalar(value) {
                line.push_str(&format!(" {key}: {value}."));
            }
        }
    }
    line.push('\n');
    line
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(one_line(text)).filter(|text| !text.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(if *flag { "да" } else { "нет" }.to_owned()),
        _ => None,
    }
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
