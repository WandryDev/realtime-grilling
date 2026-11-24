//! What one call of the slow loop gets (agent-slow-loop design.md,
//! decision 3):
//!
//! - the prompt file `<recording id>.slow.md`, written once per recording
//!   (byte-stable, for the CLI's cache): the rules and the project's name
//!   and description;
//! - the message: the topics with the current one, the current topic's
//!   card, the open questions `[Q:id]`, the findings already shown
//!   `D1…Dn`, the last 3 minutes of the transcript `[S:id]` with the
//!   channel, the queries of the previous call, and the candidates
//!   `[C1] <source> › <headings>` with their text.

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::Connection;

use super::search::{Candidate, PATH_SEPARATOR};
use crate::{
    agent::{
        fast_loop::{
            assembly::{one_line, segment_line, transcript_window},
            validate::document_numbers,
        },
        sections::Sections,
    },
    error::CommandResult,
    storage::{
        call_state::{CallState, QuestionStatus},
        journal::PromptPart,
        projects, recordings,
        transcript::{TranscriptChannel, TranscriptSegment},
    },
};

/// How much of the transcript a call gets.
pub const TRANSCRIPT_WINDOW: Duration = Duration::from_secs(3 * 60);
/// The client's last words that make the client's query.
pub const CLIENT_WINDOW: Duration = Duration::from_secs(60);

/// The last line of every message.
pub const STRUCTURED_OUTPUT: &str = "Передай ответ одним вызовом инструмента StructuredOutput.";

/// The JSON Schema of the reply.
pub const SCHEMA: &str = include_str!("slow_loop.schema.json");

/// The rules of the slow loop.
pub const RULES: &str = r#"# Правила

Ты — медленный контур ассистента для грилинга клиента во время discovery-звонка. Менеджер (канал «Я») разговаривает с клиентом (канал «Остальные»). Пока идёт разговор, приложение ищет в материалах проекта — файлах, документах Outline и задачах ClickUp — фрагменты по словам клиента и по твоим прошлым запросам и присылает их тебе кандидатами. Каждый вызов независим: памяти о прошлых вызовах у тебя нет. Инструментов, кроме StructuredOutput, нет.

Задача — отобрать из кандидатов до двух находок, которые помогают текущему разговору: подтверждают, дополняют или противоречат тому, что сказал клиент, или отвечают на открытый вопрос. Находку увидит менеджер прямо во время звонка, её получит и быстрый контур, который предлагает вопросы. Шум вредит: находка, которая не относится к тому, о чём говорят сейчас, отвлекает. Пустой список находок — нормальный ответ, когда среди кандидатов нет ничего полезного.

## Что приходит

В сообщении: темы звонка и текущая, карточка текущей темы, открытые вопросы `[Q:<id>]`, уже показанные находки `D1…Dn`, расшифровка последних 3 минут `[S:<id>] мм:сс Остальные|Я: текст`, твои запросы из прошлого вызова и кандидаты `[C1] <источник> › <заголовки>` с текстом фрагмента.

## Находки

- `candidate` — ID кандидата из этого сообщения, `C1…Cn`.
- `quote` — ДОСЛОВНАЯ цитата из текста этого кандидата, 3–25 слов: не пересказывай, копируй. Код сверяет её с текстом и отбрасывает находку, если цитаты там нет.
- `note` — одна строка до 140 символов, к чему находка относится: «Подтверждает: …», «Дополняет: …» или «Противоречит: …».
- `questionId` — ID открытого вопроса без `Q:`, если находка относится к нему; иначе не указывай.
- Не повторяй уже показанные находки и то, что уже есть в карточке. Не пересказывай бриф проекта: менеджер его знает.
- Кандидаты — материалы проекта, а не слова клиента. Расшифровка получена автоматическим распознаванием речи: в ней есть ошибки и искажённые термины.

## Запросы

`queries` — до 3 запросов для следующего поиска, каждый до 8 слов: термины, названия систем, имена и процессы из разговора, которых нет в брифе и по которым стоит поискать в материалах. Без запросов — пустой список.
"#;

/// The name of a prompt file after its recording id.
const PROMPT_SUFFIX: &str = ".slow.md";

/// Where the prompt of `recording_id` is written.
pub fn prompt_path(dir: &Path, recording_id: &str) -> PathBuf {
    dir.join(format!("{recording_id}{PROMPT_SUFFIX}"))
}

/// The prompt of a recording: the rules, the project's name and
/// description. `NotFound` for an unknown recording.
pub fn prompt(connection: &Connection, recording_id: &str) -> CommandResult<String> {
    let recording = recordings::get(connection, recording_id)?;
    let mut text = String::from(RULES);
    text.push_str("\n# Проект\n\n");
    match &recording.project_id {
        Some(project_id) => {
            let project = projects::get(connection, project_id)?;
            text.push_str(&format!("Название: {}\n", one_line(&project.name)));
            let description = one_line(&project.description);
            if !description.is_empty() {
                text.push_str(&format!("Описание: {description}\n"));
            }
        }
        None => text.push_str("Проект не выбран.\n"),
    }
    Ok(text)
}

/// Writes the prompt for the CLI (creating `dir`) and returns the file.
pub fn write_prompt(dir: &Path, recording_id: &str, text: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = prompt_path(dir, recording_id);
    fs::write(&path, text.as_bytes())?;
    Ok(path)
}

/// Removes the prompt files in `dir` of the recordings `keep` doesn't keep;
/// other files stay. Returns how many went.
pub fn sweep_prompts(dir: &Path, keep: impl Fn(&str) -> bool) -> io::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let Some(recording_id) = name
            .to_str()
            .and_then(|name| name.strip_suffix(PROMPT_SUFFIX))
        else {
            continue;
        };
        if keep(recording_id) || !entry.file_type()?.is_file() {
            continue;
        }
        fs::remove_file(entry.path())?;
        removed += 1;
    }
    Ok(removed)
}

/// What the client said in the last [`CLIENT_WINDOW`] of the live pass: the
/// client's query.
pub fn client_query(segments: &[TranscriptSegment]) -> String {
    transcript_window(segments, CLIENT_WINDOW)
        .into_iter()
        .filter(|segment| segment.channel == TranscriptChannel::Others)
        .map(|segment| one_line(&segment.text))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `[C1] Outline «Регламент смены» › Старший смены`.
fn candidate_line(number: usize, candidate: &Candidate) -> String {
    let mut line = format!(
        "[C{number}] {} «{}»",
        candidate.source.kind.label(),
        one_line(&candidate.source.name)
    );
    if !candidate.path.is_empty() {
        line.push_str(PATH_SEPARATOR);
        line.push_str(&one_line(&candidate.path));
    }
    line
}

/// The message of a call: the state, the transcript window, the previous
/// queries and the candidates (numbered `C1…` in their order).
#[cfg(test)]
pub fn user_message(
    state: &CallState,
    segments: &[TranscriptSegment],
    queries: &[String],
    candidates: &[Candidate],
) -> String {
    crate::agent::sections::join(&user_message_parts(state, segments, queries, candidates))
}

/// [`user_message`] by parts (call-analytics design.md, decision 2):
/// `topics`, `card`, `questions`, `findings`, `transcript`, `queries`,
/// `candidates`, `output`.
pub fn user_message_parts(
    state: &CallState,
    segments: &[TranscriptSegment],
    queries: &[String],
    candidates: &[Candidate],
) -> Vec<PromptPart> {
    let mut text = Sections::new("topics");
    text.push_str("# Темы\n\n");
    if state.topics.is_empty() {
        text.push_str("Тем пока нет.\n");
    }
    for topic in &state.topics {
        let current = if state.current_topic_id.as_deref() == Some(topic.id.as_str()) {
            " (текущая)"
        } else {
            ""
        };
        text.push_str(&format!(
            "- [T:{}] {}{current}\n",
            one_line(&topic.id),
            one_line(&topic.title)
        ));
    }

    text.section("card");
    text.push_str("\n# Карточка текущей темы\n\n");
    match state.current_card() {
        Some(card) if !card.fields.is_empty() => {
            for field in &card.fields {
                text.push_str(&format!(
                    "- {}: {}\n",
                    field.field.as_str(),
                    one_line(&field.value)
                ));
            }
        }
        _ if state.current_topic_id.is_none() => text.push_str("Текущей темы нет.\n"),
        _ => text.push_str("Полей пока нет.\n"),
    }

    text.section("questions");
    text.push_str("\n# Открытые вопросы\n\n");
    let open: Vec<_> = state
        .questions
        .iter()
        .filter(|question| question.status == QuestionStatus::Open)
        .collect();
    if open.is_empty() {
        text.push_str("Нет.\n");
    }
    for question in open {
        text.push_str(&format!(
            "- [Q:{}] {}\n",
            one_line(&question.id),
            one_line(&question.text)
        ));
    }

    text.section("findings");
    text.push_str("\n# Уже показанные находки\n\n");
    let shown = document_numbers(state);
    if shown.is_empty() {
        text.push_str("Нет.\n");
    }
    for (number, finding) in shown {
        text.push_str(&format!(
            "- [{number}] {} «{}»: «{}»\n",
            finding.source_kind.label(),
            one_line(&finding.source_name),
            one_line(&finding.quote)
        ));
    }

    text.section("transcript");
    text.push_str("\n# Расшифровка за последние 3 минуты\n\n");
    let window = transcript_window(segments, TRANSCRIPT_WINDOW);
    if window.is_empty() {
        text.push_str("Расшифровки пока нет.\n");
    }
    for segment in window {
        text.push_str(&segment_line(segment));
        text.push('\n');
    }

    text.section("queries");
    text.push_str("\n# Твои запросы из прошлого вызова\n\n");
    if queries.is_empty() {
        text.push_str("Нет.\n");
    }
    for query in queries {
        text.push_str(&format!("- {}\n", one_line(query)));
    }

    text.section("candidates");
    text.push_str("\n# Кандидаты\n");
    for (index, candidate) in candidates.iter().enumerate() {
        text.push('\n');
        text.push_str(&candidate_line(index + 1, candidate));
        text.push('\n');
        text.push_str(candidate.text.trim());
        text.push('\n');
    }
    text.section("output");
    text.push('\n');
    text.push_str(STRUCTURED_OUTPUT);
    text.into_parts()
}

#[cfg(test)]
mod tests;
