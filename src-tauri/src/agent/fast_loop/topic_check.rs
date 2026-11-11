//! The topic check (question-volume design.md, decision 2): when the current
//! topic has gone on long, a short call of its own asks the agent whether
//! the last minutes moved to another task or part of the process. The fast
//! loop's call has too much to do to notice a slow drift; this one has one
//! question and a narrow schema.
//!
//! - [`PROMPT`] is the system prompt, the same for every recording;
//! - [`message`] gives the topics, the current one and how long it goes,
//!   and the transcript of the last [`WINDOW`]. Not the card: the fast loop
//!   writes into it everything said, the drift too, and the check then took
//!   the drift for the same topic (05.11: one topic for the whole call);
//! - [`parse`] reads the reply, [`check`] turns it into a topic operation
//!   after its quote is found in a phrase of «Остальные» of that window.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::Connection;
use serde_json::Value;

use super::{
    assembly::{segment_line, transcript_window},
    evidence::{quote_long_enough, quote_matches},
};
use crate::{
    error::CommandResult,
    storage::{
        call_state::{self, CallState, ValidatedOp},
        transcript::{self, TranscriptChannel, TranscriptSegment},
    },
};

/// How much of the transcript the check reads.
pub const WINDOW: Duration = Duration::from_secs(6 * 60);
/// The longest title of a new topic, in characters.
pub const TITLE_CHARS: usize = 60;

/// The system prompt of the check.
pub const PROMPT: &str = r#"# Проверка темы

Ты проверяешь, не сменилась ли тема discovery-звонка. Менеджер (канал «Я») расспрашивает клиента (канал «Остальные») о задачах для разработки. Тема — одна задача или одна часть процесса клиента: что делает система или участник процесса, для кого и как.

В сообщении: темы звонка с ID, текущая тема, сколько минут она идёт, и расшифровка последних минут строками `[S:<id>] мм:сс Остальные|Я: текст`. Расшифровка автоматическая, в ней бывают ошибки.

Ответь одним из трёх способов:
- `same` — разговор всё ещё о текущей теме: уточнения, примеры, отступления, small talk, та же задача с другой стороны.
- `new` — последние минуты разговор идёт о другой задаче или другой части процесса, которой нет среди тем. `title` — короткое название новой темы по-русски, 2–6 слов. `evidence` — фраза «Остальные», с которой начался разговор о другом: `id` сегмента без `S:` и дословная цитата из неё, 3–15 слов.
- `switch` — разговор вернулся к теме из списка. `topicId` — её ID без `T:`, `evidence` — как у `new`.

Новая тема — когда несколько минут говорят о другом участнике (операторы, кассиры, колл-центр, бухгалтерия) или о другом звене цепочки, чем в названии текущей темы, даже если всё служит той же цели и никто не сказал «теперь о другом». Пример: тема «Бронь через Телеграм-бот», а последние минуты клиент объясняет, как операторы колл-центра отвечают клиентам с одного номера и как делить между ними чаты: это новая тема «Работа операторов в чатах».

Одна-две фразы о другом — ещё не новая тема. Но если последние минуты целиком о другой части процесса, заводи новую тему, даже если название текущей формально её включает: название бывает слишком широким («Телеграм-бот», «CRM», «Личный кабинет»), а тема — одна задача.

Передай ответ одним вызовом инструмента StructuredOutput.
"#;

/// The JSON Schema of the reply.
pub const SCHEMA: &str = r#"{"type":"object","additionalProperties":false,"required":["decision"],"properties":{"decision":{"type":"string","enum":["same","new","switch"]},"title":{"type":"string","minLength":1,"maxLength":60},"topicId":{"type":"string"},"evidence":{"type":"object","additionalProperties":false,"required":["id","quote"],"properties":{"id":{"type":"string"},"quote":{"type":"string"}}}}}"#;

/// Where the prompt is written: not a recording's prefix file, so the sweep
/// of those leaves it.
pub fn prompt_path(dir: &Path) -> PathBuf {
    dir.join("topic-check.md")
}

/// Writes [`PROMPT`] for the CLI (creating `dir`) and returns the file.
pub fn write_prompt(dir: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = prompt_path(dir);
    fs::write(&path, PROMPT)?;
    Ok(path)
}

/// What the agent answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Same,
    New {
        title: String,
        segment_id: String,
        quote: String,
    },
    Switch {
        topic_id: String,
        segment_id: String,
        quote: String,
    },
}

/// The reply as a [`Decision`]; why not, when it is off the schema.
pub fn parse(reply: &Value) -> Result<Decision, String> {
    let text = |key: &str| {
        reply
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let evidence = || -> Result<(String, String), String> {
        let evidence = reply.get("evidence").ok_or("нет evidence")?;
        let field = |key: &str| {
            evidence
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
                .ok_or_else(|| format!("нет evidence.{key}"))
        };
        let id = field("id")?;
        let id = id.strip_prefix("S:").map_or(id.clone(), str::to_owned);
        Ok((id, field("quote")?))
    };
    match reply.get("decision").and_then(Value::as_str) {
        Some("same") => Ok(Decision::Same),
        Some("new") => {
            let title = text("title").ok_or("нет title")?;
            let title: String = title.chars().take(TITLE_CHARS).collect();
            let (segment_id, quote) = evidence()?;
            Ok(Decision::New {
                title,
                segment_id,
                quote,
            })
        }
        Some("switch") => {
            let topic_id = text("topicId").ok_or("нет topicId")?;
            let topic_id = topic_id
                .strip_prefix("T:")
                .map_or(topic_id.clone(), str::to_owned);
            let (segment_id, quote) = evidence()?;
            Ok(Decision::Switch {
                topic_id,
                segment_id,
                quote,
            })
        }
        _ => Err("нет decision".to_owned()),
    }
}

/// The user message: the topics, the current one and how long it goes, the
/// transcript of the last `window_minutes`.
pub fn message(
    state: &CallState,
    window: &[&TranscriptSegment],
    topic_minutes: i64,
    window_minutes: u64,
) -> String {
    let mut text = String::from("# Темы звонка\n\n");
    for topic in &state.topics {
        let current = if state.current_topic_id.as_deref() == Some(topic.id.as_str()) {
            " (текущая)"
        } else {
            ""
        };
        text.push_str(&format!(
            "- [T:{}] {}{current}\n",
            topic.id,
            one_line(&topic.title)
        ));
    }
    let current = state
        .current_topic_id
        .as_deref()
        .and_then(|id| state.topics.iter().find(|topic| topic.id == id));
    if let Some(topic) = current {
        text.push_str(&format!(
            "\n# Текущая тема: {}, идёт {topic_minutes} мин\n",
            one_line(&topic.title)
        ));
    }
    text.push_str(&format!(
        "\n# Расшифровка за последние {window_minutes} мин\n\n"
    ));
    for segment in window {
        text.push_str(&segment_line(segment));
        text.push('\n');
    }
    text.push_str("\nПередай ответ одним вызовом инструмента StructuredOutput.");
    text
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A call ready to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembled {
    pub user_message: String,
    /// The phrases of «Остальные» in the window, `(id, text)`: a quote must
    /// be in one of them.
    pub client_phrases: Vec<(String, String)>,
}

/// Reads the state and the transcript of `recording_id`.
pub fn assemble(
    connection: &Connection,
    recording_id: &str,
    topic_minutes: i64,
    window: Duration,
) -> CommandResult<Assembled> {
    let state = call_state::get(connection, recording_id)?;
    let segments = transcript::for_recording(connection, recording_id)?;
    let minutes = window.as_secs() / 60;
    let window = transcript_window(&segments, window);
    Ok(Assembled {
        user_message: message(&state, &window, topic_minutes, minutes),
        client_phrases: window
            .iter()
            .filter(|segment| segment.channel == TranscriptChannel::Others)
            .map(|segment| (segment.id.clone(), segment.text.clone()))
            .collect(),
    })
}

/// The operation a decision makes, once its quote is in the phrase it
/// names (a phrase of «Остальные» of the window) and a switch names a topic
/// of the call other than the current one. `Ok(None)` for `same`; `Err`
/// with the reason when the decision doesn't hold.
pub fn check(
    decision: &Decision,
    assembled: &Assembled,
    state: &CallState,
) -> Result<Option<ValidatedOp>, String> {
    let quoted = |segment_id: &str, quote: &str| -> Result<(), String> {
        let (_, text) = assembled
            .client_phrases
            .iter()
            .find(|(id, _)| id == segment_id)
            .ok_or_else(|| format!("нет фразы «Остальные» {segment_id} в окне"))?;
        if quote_long_enough(quote, text) && quote_matches(quote, text) {
            Ok(())
        } else {
            Err(format!("цитаты «{quote}» нет в {segment_id}"))
        }
    };
    match decision {
        Decision::Same => Ok(None),
        Decision::New {
            title,
            segment_id,
            quote,
        } => {
            quoted(segment_id, quote)?;
            Ok(Some(ValidatedOp::CreateTopic {
                title: title.clone(),
            }))
        }
        Decision::Switch {
            topic_id,
            segment_id,
            quote,
        } => {
            if !state.topics.iter().any(|topic| &topic.id == topic_id) {
                return Err(format!("нет темы {topic_id}"));
            }
            if state.current_topic_id.as_deref() == Some(topic_id.as_str()) {
                return Ok(None);
            }
            quoted(segment_id, quote)?;
            Ok(Some(ValidatedOp::SwitchTopic {
                topic_id: topic_id.clone(),
            }))
        }
    }
}

#[cfg(test)]
mod tests;
