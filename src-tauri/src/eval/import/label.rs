//! Who said what in a mono recording (question-quality design.md, decision
//! 2a, step 4): one Claude Code call with a schema labels every phrase of
//! the refined transcript «Я» or «Остальные» by its text, then the labels
//! go to the live phrases by time. A reply off the schema, or one that
//! misses a phrase, fails the import: a corpus with guessed channels would
//! skew every replay of it.

use std::{collections::HashMap, fmt::Write as _, path::Path, sync::Arc, time::Duration};

use serde_json::Value;
use tokio::sync::oneshot;

use super::passes::{Heard, Track};
use crate::{
    agent::{
        claude_cli::{Agent, AgentRequest, CallOptions, MODEL, OutputKind, Usage},
        process::TreeSlot,
    },
    eval::judge::PART_LIMIT_CHARS,
    storage::transcript::TranscriptChannel,
};

const PROMPT: &str = include_str!("label_prompt.md");
const SCHEMA: &str = include_str!("label.schema.json");
const EFFORT: &str = "medium";
/// A long call's transcript is labeled phrase by phrase: minutes of output.
const TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The schema as `--json-schema` takes it: on one line.
fn schema_argument() -> String {
    serde_json::from_str::<Value>(SCHEMA).map_or_else(|_| SCHEMA.to_owned(), |v| v.to_string())
}

/// `mm:ss` (or `h:mm:ss`) from the start.
fn clock(ms: i64) -> String {
    let seconds = ms.max(0) / 1_000;
    let (hours, minutes, seconds) = (seconds / 3_600, seconds / 60 % 60, seconds % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

/// The phrase ids of the call: `S1`, `S2`, … in time order.
fn phrase_id(index: usize) -> String {
    format!("S{}", index + 1)
}

/// The message: the project, the manager and the transcript.
pub fn message(transcript: &[Heard], description: &str, manager: Option<&str>) -> String {
    let mut text = String::new();
    let description = description.trim();
    let _ = writeln!(
        text,
        "Описание проекта:\n{}\n",
        if description.is_empty() {
            "(нет)"
        } else {
            description
        }
    );
    match manager.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => {
            let _ = writeln!(text, "Менеджер: {name}\n");
        }
        None => text.push_str("Имя менеджера не задано.\n\n"),
    }
    text.push_str("Расшифровка (id [начало–конец] текст):\n");
    for (index, phrase) in transcript.iter().enumerate() {
        let _ = writeln!(
            text,
            "{} [{}–{}] {}",
            phrase_id(index),
            clock(phrase.start_ms),
            clock(phrase.end_ms),
            phrase.text.trim()
        );
    }
    text.push_str("\nРазметь каждую фразу: `me` или `others`.");
    text
}

/// The labels of `reply` for `count` phrases, by index; an error when the
/// reply is off the schema or misses a phrase.
pub fn parse(reply: &Value, count: usize) -> Result<Vec<TranscriptChannel>, String> {
    let off = |why: String| format!("Разметка моно ответила не по схеме: {why}");
    let labels = reply
        .get("labels")
        .and_then(Value::as_array)
        .ok_or_else(|| off("нет списка labels".to_owned()))?;
    let ids: HashMap<String, usize> = (0..count).map(|index| (phrase_id(index), index)).collect();
    let mut channels: Vec<Option<TranscriptChannel>> = vec![None; count];
    for label in labels {
        let id = label
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| off(format!("метка без id: {label}")))?;
        let channel = match label.get("speaker").and_then(Value::as_str) {
            Some("me") => TranscriptChannel::Me,
            Some("others") => TranscriptChannel::Others,
            _ => return Err(off(format!("у {id} нет speaker me|others"))),
        };
        let index = *ids.get(id).ok_or_else(|| off(format!("нет фразы {id}")))?;
        if channels[index].replace(channel).is_some() {
            return Err(off(format!("фраза {id} размечена дважды")));
        }
    }
    let missing: Vec<String> = channels
        .iter()
        .enumerate()
        .filter(|(_, channel)| channel.is_none())
        .map(|(index, _)| phrase_id(index))
        .collect();
    if !missing.is_empty() {
        let shown: Vec<&str> = missing.iter().take(5).map(String::as_str).collect();
        return Err(format!(
            "Разметка моно пропустила {} из {count} фраз: {}{}",
            missing.len(),
            shown.join(", "),
            if missing.len() > shown.len() {
                ", …"
            } else {
                ""
            }
        ));
    }
    Ok(channels.into_iter().flatten().collect())
}

/// Labels `transcript` (the refined pass, in time order) with one call. A
/// message over the judge's limit ([`PART_LIMIT_CHARS`]) fails before the
/// call: one call would not hold it.
pub async fn label(
    agent: &Arc<dyn Agent>,
    transcript: &[Heard],
    description: &str,
    manager: Option<&str>,
    prompt_dir: &Path,
) -> Result<(Vec<TranscriptChannel>, Usage), String> {
    let user_message = message(transcript, description, manager);
    let chars = user_message.chars().count();
    if chars > PART_LIMIT_CHARS {
        return Err(format!(
            "Моно-запись слишком длинная для разметки одним вызовом: {} тыс. символов \
             расшифровки, предел {} тыс. Разрежьте запись на части (ffmpeg -ss … -t …) и \
             импортируйте их по отдельности",
            chars / 1_000,
            PART_LIMIT_CHARS / 1_000
        ));
    }
    std::fs::create_dir_all(prompt_dir)
        .map_err(|error| format!("Не удалось создать {}: {error}", prompt_dir.display()))?;
    let prompt = prompt_dir.join("label.md");
    std::fs::write(&prompt, PROMPT)
        .map_err(|error| format!("Не удалось записать {}: {error}", prompt.display()))?;
    let request = AgentRequest {
        system_prompt_file: prompt,
        user_message,
        schema: schema_argument(),
        process: TreeSlot::default(),
        options: CallOptions {
            model: Some(MODEL),
            effort: Some(EFFORT),
            timeout: Some(TIMEOUT),
            output: OutputKind::Object,
            on_output: None,
        },
    };
    // Held until the call ends: a dropped sender cancels it.
    let (_cancel, cancelled) = oneshot::channel();
    let reply = agent
        .run(request, cancelled)
        .await
        .map_err(|error| format!("Разметка моно не удалась: {error}"))?;
    Ok((parse(&reply.patch, transcript.len())?, reply.usage))
}

/// The channel of each of `phrases` from the labeled `labeled`: the one it
/// overlaps most in time, or the nearest when it overlaps none.
pub fn by_time(
    phrases: &[Heard],
    labeled: &[(Heard, TranscriptChannel)],
) -> Vec<TranscriptChannel> {
    phrases
        .iter()
        .map(|phrase| {
            let overlap = |other: &Heard| {
                phrase.end_ms.min(other.end_ms) - phrase.start_ms.max(other.start_ms)
            };
            let gap = |other: &Heard| {
                (phrase.start_ms - other.end_ms)
                    .max(other.start_ms - phrase.end_ms)
                    .max(0)
            };
            labeled
                .iter()
                .max_by_key(|(other, _)| {
                    let overlap = overlap(other);
                    if overlap > 0 {
                        (1, overlap)
                    } else {
                        (0, -gap(other))
                    }
                })
                .map_or(TranscriptChannel::Others, |(_, channel)| *channel)
        })
        .collect()
}

/// Every mixed phrase as labeled.
pub fn apply(phrases: &[Heard], channels: &[TranscriptChannel]) -> Vec<Heard> {
    phrases
        .iter()
        .zip(channels)
        .map(|(phrase, channel)| Heard {
            track: match channel {
                TranscriptChannel::Me => Track::Me,
                TranscriptChannel::Others => Track::Others,
            },
            ..phrase.clone()
        })
        .collect()
}
