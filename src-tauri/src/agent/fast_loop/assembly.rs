//! What one agent call gets (design.md, decision 3), in three parts:
//!
//! 1. the stable prefix, built once per recording when its scheduler starts
//!    and passed as a file (`--system-prompt-file`): the rules, the project
//!    (`P1` the description, `B1…Bn` the brief items), the client's people
//!    with their profiles, the glossary. It never changes during the
//!    recording, so the CLI's prompt cache holds;
//! 2. the state with ids: the mode, the topics, the current topic's card,
//!    the questions;
//! 3. the last 10 minutes of the live transcript, one line per segment:
//!    `[S:<id>] mm:ss Остальные|Я: текст`.
//!
//! Parts 2 and 3 go to stdin, ending with the line about StructuredOutput
//! (without it the CLI makes a second request).

use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::Connection;
use serde_json::Value;

use super::validate::{CallContext, SourceText};
use crate::{
    error::CommandResult,
    speech::context,
    storage::{
        call_state::{
            self, CallState, CardLens, Evidence, EvidenceSource, Question, QuestionStatus,
        },
        people::{self, Person},
        projects, recordings,
        transcript::{self, TranscriptChannel, TranscriptPass, TranscriptSegment},
    },
};

/// How much of the transcript a call gets.
pub const TRANSCRIPT_WINDOW: Duration = Duration::from_secs(10 * 60);

/// The last line of every user message.
pub const STRUCTURED_OUTPUT: &str = "Передай патч одним вызовом инструмента StructuredOutput.";

/// The rules: the patch protocol, the quality rules of `docs/concept.md`
/// («Качество вопросов»), the ASR caveat, facts only from «Остальные».
pub const RULES: &str = r#"# Правила

Ты — быстрый контур ассистента для грилинга клиента во время discovery-звонка. Менеджер (канал «Я») разговаривает с клиентом (канал «Остальные»). Приложение вызывает тебя после законченной фразы клиента, но не чаще раза в 10–45 секунд. Каждый вызов независим: памяти о прошлых вызовах у тебя нет, всё состояние приходит в сообщении. Инструментов, кроме StructuredOutput, нет — работай только с тем, что дано.

Задача — вернуть ПАТЧ к текущему состоянию: обновить карточку задачи текущей темы и, если есть настоящий пробел, предложить менеджеру 1–2 вопроса. Менеджер читает вопросы краем глаза прямо во время разговора. Точность важнее полноты: если половина списка — шум, менеджер перестанет его читать. Пустой патч `{"ops": []}` — нормальный и частый ответ.

## Что приходит

1. Этот промпт, затем проект (`P1` — описание, `B1…Bn` — пункты брифа), люди клиента с профилями и глоссарий.
2. В сообщении: режим, темы с ID, карточка текущей темы, вопросы звонка с ID и состоянием.
3. Расшифровка последних 10 минут: строки `[S:<id>] мм:сс Остальные|Я: текст`.

## Протокол патча

`ops` — список операций, выполняются по порядку. Порядок в одном вызове: `topic` → `card` → `answered` → `question` → `finalCheck`.

- `topic`: `action: "create"` с `title` — новая тема, она становится текущей; `action: "switch"` с `topicId` — вернуться к теме из списка. Создавай тему, только когда клиент явно перешёл к другой задаче; small talk — не тема.
- `card`: `field`, `value`, `evidence` — поле карточки текущей темы. `field` — строго одна из семи линз: `goal` — цель, зачем это бизнесу; `users` — пользователи, кто пользуется и кого затрагивает; `scenarios` — основные сценарии; `edgeCases` — крайние и нештатные случаи; `integrations` — интеграции, системы и данные; `constraints` — ограничения: сроки, бюджет, законы, техника; `acceptance` — критерии готовности, как поймём, что готово. Других полей нет. Новое значение целиком заменяет старое: включай прежние факты, если они верны. Пиши сжато, до 300 символов, не больше 3 операций `card` за вызов.
- `question`: `title` — вопрос одним предложением, до 25 слов, на русском; `description` — почему это важно, одно короткое предложение; `cardField` — линза поля карточки текущей темы; для `assumption` и `contradiction` поле уже заполнено или задано операцией `card` раньше в этом патче, для `empty` — пустое поле; `gapType` — `empty` (в поле пусто), `assumption` (кто-то предположил, клиент не подтвердил) или `contradiction` (две реплики или реплика и проект расходятся); `priority` — 3: без ответа нельзя оценить или реализовать задачу, 2: влияет на объём или архитектуру, 1: уточнение; `evidence`.
- `answered`: `questionId` открытого или заданного менеджером вопроса и `evidence` с цитатой ответа клиента. Заданный вопрос менеджер уже задал и ждёт ответа: когда клиент ответил, отмечай его отвеченным. Частичный ответ — не ответ: вопрос остаётся открытым.
- `finalCheck`: разговор идёт к завершению (прощание, «давайте подведём итог», договорённость о следующем шаге) — начать финальную проверку.

`evidence` — список из 1–3 оснований `{"source", "id", "quote"}`:
- `source: "segment"`, `id` — ID сегмента из `[S:<id>]` без `S:`;
- `source: "project"`, `id` — `P1` или `B1…Bn`.

`quote` — короткая ДОСЛОВНАЯ цитата (3–15 слов) из этого источника: не пересказывай, копируй. Код проверяет, что ID был в этом сообщении, цитата не короче трёх слов (если в источнике их не меньше) и совпадает с текстом; иначе операция отбрасывается. У `card` и `answered` хотя бы одно основание — фраза «Остальные» или пункт проекта; фраза «Я» одна не годится. Противоречие ссылается на обе фразы клиента: два основания из разных сегментов «Остальные». ID тем и вопросов передавай без префиксов `T:` и `Q:`.

## Качество вопросов

- Вопрос рождается только там, где в карточке текущей темы пусто, допущение или противоречие. Вопрос не о поле карточки текущей темы будет отброшен.
- Первый вопрос темы — сразу. Как только у текущей темы есть цель, а у неё нет ни одного открытого вопроса, в том же патче предложи 1 вопрос по самому важному пустому полю: обычно `users`, `integrations` или `acceptance` — то, без чего задачу нельзя оценить. Пустое ключевое поле — настоящий пробел, а не повод ждать: не возвращай патч только из `card`, если такое поле пусто. Основание — фраза клиента, где он описал задачу; `gapType: "empty"`.
- Не больше 2 новых вопросов за вызов. В деталях сомневаешься — не спрашивай.
- Не задавай вопрос, если ответ уже есть в расшифровке, в проекте или в карточке.
- Не повторяй вопросы звонка — открытые, отвеченные, заданные и скрытые; сверяйся по смыслу, а не по словам. Скрытые менеджер отклонил: не предлагай их снова в другой формулировке.
- Не задавай общих вопросов «по чек-листу», не связанных с тем, что прозвучало. Не выдумывай факты, которых никто не произносил.
- Формулировку подстраивай под профиль собеседника: нетехническому — простыми словами, без жаргона; техническому — по существу, можно термины.

## Расшифровка

- Текст получен автоматическим распознаванием речи: в нём есть ошибки, искажённые имена и термины, пропущенные слова. Одно странное слово — не повод для вопроса. Но числа и отрицания важны: если клиент сам себе противоречит в числах или в «нужно / не нужно» — это противоречие.
- Факты о задаче бери ТОЛЬКО из канала «Остальные» и из проекта. Слова менеджера («Я») — вопросы и гипотезы, а не факты: если менеджер предположил, а клиент не подтвердил, это допущение.

## Финальная проверка

В режиме «финальная проверка» новых тем не создавай. Отмечай отвеченные вопросы; новый вопрос — только если без него нельзя оценить или реализовать задачу.
"#;

/// Brief keys that point at sources instead of stating facts.
const BRIEF_SKIPPED: [&str; 2] = ["keyDocuments", "keyDocumentsNote"];
/// Fields of a brief entry that name it, so they come first.
const ENTRY_NAMES: [&str; 3] = ["term", "name", "title"];
/// Profile fields of a person in the order and words of the prompt.
const PROFILE_FIELDS: [(&str, &str); 6] = [
    ("howToAsk", "Как спрашивать"),
    ("askStyle", "Стиль вопросов"),
    ("tech", "Технический уровень (1–5)"),
    ("project", "Понимание проекта (1–5)"),
    ("portrait", "Портрет"),
    ("notes", "Заметки"),
];
/// Profile fields that are only for the screens.
const PROFILE_SKIPPED: [&str; 2] = ["initials", "edits"];

/// The stable prefix of a recording and the project items it numbers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prefix {
    pub text: String,
    /// `P1`, `B1…Bn`: what `evidence` with `source: project` may cite.
    pub project_items: Vec<SourceText>,
}

/// The prefix of `recording_id` from what the storage has now: its project,
/// the participants (all the project's people when none were picked) and
/// the glossary. `NotFound` for an unknown recording.
#[cfg(test)]
pub fn build_prefix(connection: &Connection, recording_id: &str) -> CommandResult<Prefix> {
    build_prefix_with_rules(connection, recording_id, RULES)
}

/// [`build_prefix`] opened by `rules` instead of [`RULES`]: a replay tries
/// a variant of the rules without a rebuild (`grill-eval replay --rules`).
pub fn build_prefix_with_rules(
    connection: &Connection,
    recording_id: &str,
    rules: &str,
) -> CommandResult<Prefix> {
    let recording = recordings::get(connection, recording_id)?;
    let glossary = context::load(connection, recording_id)?.glossary;
    let mut text = String::from(rules);
    let mut project_items = Vec::new();

    text.push_str("\n# Проект\n\n");
    let project = match &recording.project_id {
        Some(project_id) => Some(projects::get(connection, project_id)?),
        None => None,
    };
    match &project {
        Some(project) => {
            text.push_str(&format!("Название: {}\n", one_line(&project.name)));
            let description = one_line(&project.description);
            if !description.is_empty() {
                project_items.push(SourceText::new("P1", description));
            }
            let brief = project.brief.as_ref().map(brief_items).unwrap_or_default();
            for (index, item) in brief.into_iter().enumerate() {
                project_items.push(SourceText::new(format!("B{}", index + 1), item));
            }
            if project_items.is_empty() {
                text.push_str("Описания и брифа пока нет.\n");
            }
            for item in &project_items {
                text.push_str(&format!("{}: {}\n", item.id, item.text));
            }
        }
        None => text.push_str("Проект не выбран.\n"),
    }

    text.push_str("\n# Люди клиента на звонке\n\n");
    let people = match &project {
        Some(project) => {
            let all = people::list(connection, &project.id)?;
            let picked: Vec<Person> = recording
                .participant_ids
                .iter()
                .filter_map(|id| all.iter().find(|person| &person.id == id).cloned())
                .collect();
            if picked.is_empty() { all } else { picked }
        }
        None => Vec::new(),
    };
    if people.is_empty() {
        text.push_str("Неизвестны.\n");
    }
    for person in &people {
        text.push_str(&person_line(person));
    }

    text.push_str("\n# Глоссарий\n\n");
    if glossary.full().is_empty() {
        text.push_str("Пуст.\n");
    } else {
        text.push_str(glossary.full());
        text.push('\n');
    }
    Ok(Prefix {
        text,
        project_items,
    })
}

/// `- Имя — роль. Как спрашивать: …. Технический уровень (1–5): 1.`
fn person_line(person: &Person) -> String {
    let mut line = format!("- {}", one_line(&person.name));
    let role = one_line(&person.role);
    if !role.is_empty() {
        line.push_str(&format!(" — {role}"));
    }
    line.push('.');
    let mut known: Vec<(&str, String)> = Vec::new();
    for (key, label) in PROFILE_FIELDS {
        if let Some(value) = person.profile.get(key).and_then(scalar) {
            known.push((label, value));
        }
    }
    if let Some(profile) = person.profile.as_object() {
        for (key, value) in profile {
            let listed = PROFILE_FIELDS.iter().any(|(name, _)| name == key);
            if listed || PROFILE_SKIPPED.contains(&key.as_str()) {
                continue;
            }
            if let Some(value) = scalar(value) {
                known.push((key.as_str(), value));
            }
        }
    }
    for (label, value) in known {
        line.push_str(&format!(" {label}: {value}."));
    }
    line.push('\n');
    line
}

/// A string (trimmed, on one line) or a number; nothing for an empty
/// string, `null`, lists and objects.
fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(one_line(text)).filter(|text| !text.is_empty()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(if *flag { "да" } else { "нет" }.to_owned()),
        _ => None,
    }
}

/// The brief as numbered items: its texts first, then every entry of its
/// lists (a string, or an object's texts joined with « — », its name
/// first). Keys that only point at documents are left out.
pub fn brief_items(brief: &Value) -> Vec<String> {
    let Some(brief) = brief.as_object() else {
        return brief.as_str().map(one_line).into_iter().collect();
    };
    let kept = || {
        brief
            .iter()
            .filter(|(key, _)| !BRIEF_SKIPPED.contains(&key.as_str()))
    };
    let mut items: Vec<String> = kept().filter_map(|(_, value)| scalar(value)).collect();
    for (_, value) in kept() {
        let Some(entries) = value.as_array() else {
            continue;
        };
        for entry in entries {
            let item = match entry {
                Value::Object(fields) => {
                    let named = ENTRY_NAMES
                        .iter()
                        .filter_map(|name| fields.get(*name).and_then(scalar));
                    let others = fields
                        .iter()
                        .filter(|(key, _)| !ENTRY_NAMES.contains(&key.as_str()))
                        .filter_map(|(_, value)| scalar(value));
                    let texts: Vec<String> = named.chain(others).collect();
                    Some(texts.join(" — ")).filter(|text| !text.is_empty())
                }
                other => scalar(other),
            };
            items.extend(item);
        }
    }
    items
}

/// Whitespace and line breaks collapsed: one segment, one line.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The name of a prefix file after its recording id.
const PROMPT_SUFFIX: &str = ".prompt.md";

/// Where the prefix of `recording_id` is written.
pub fn prompt_path(dir: &Path, recording_id: &str) -> PathBuf {
    dir.join(format!("{recording_id}{PROMPT_SUFFIX}"))
}

/// Removes the prefix files in `dir` of the recordings `keep` doesn't
/// keep; other files stay. Returns how many went; a missing `dir` has none.
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

/// Writes the prefix for the CLI (creating `dir`) and returns the file.
pub fn write_prompt(dir: &Path, recording_id: &str, prefix: &Prefix) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let path = prompt_path(dir, recording_id);
    fs::write(&path, prefix.text.as_bytes())?;
    Ok(path)
}

/* The volatile part */

/// The live segments of the last `window` before the latest one ends,
/// oldest first. A segment that ends inside the window is in it.
pub fn transcript_window(
    segments: &[TranscriptSegment],
    window: Duration,
) -> Vec<&TranscriptSegment> {
    let live = || {
        segments
            .iter()
            .filter(|segment| segment.pass == TranscriptPass::Live)
    };
    let Some(latest) = live().map(|segment| segment.end_ms).max() else {
        return Vec::new();
    };
    let window = i64::try_from(window.as_millis()).unwrap_or(i64::MAX);
    let from = latest.saturating_sub(window);
    let mut kept: Vec<&TranscriptSegment> =
        live().filter(|segment| segment.end_ms >= from).collect();
    kept.sort_by(|a, b| (a.start_ms, a.end_ms, &a.id).cmp(&(b.start_ms, b.end_ms, &b.id)));
    kept
}

/// `mm:ss` from the start of the recording (minutes go past 59).
fn clock(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

fn speaker(channel: TranscriptChannel) -> &'static str {
    match channel {
        TranscriptChannel::Others => "Остальные",
        TranscriptChannel::Me => "Я",
    }
}

/// `[S:<id>] mm:ss Остальные: текст`.
pub fn segment_line(segment: &TranscriptSegment) -> String {
    format!(
        "[S:{}] {} {}: {}",
        one_line(&segment.id),
        clock(segment.start_ms),
        speaker(segment.channel),
        one_line(&segment.text)
    )
}

fn sources(evidence: &[Evidence]) -> String {
    let ids: Vec<String> = evidence
        .iter()
        .map(|item| match item.source {
            EvidenceSource::Segment => format!("S:{}", one_line(&item.id)),
            EvidenceSource::Project => one_line(&item.id),
        })
        .collect();
    ids.join(", ")
}

fn question_line(question: &Question, state: &CallState) -> String {
    let mut line = format!("- [Q:{}]", one_line(&question.id));
    let other_topic = question.topic_id.is_some() && question.topic_id != state.current_topic_id;
    if other_topic && let Some(topic_id) = &question.topic_id {
        line.push_str(&format!(" (тема T:{})", one_line(topic_id)));
    }
    line.push_str(&format!(
        " поле {}, {}, приоритет {}: {}",
        question.card_field.map_or("—", CardLens::as_str),
        question.gap_type.as_str(),
        question.priority,
        one_line(&question.text)
    ));
    line.push('\n');
    line
}

/// The user message of a call: the mode, the state with ids, the
/// transcript window, the line about StructuredOutput.
pub fn user_message(state: &CallState, window: &[&TranscriptSegment]) -> String {
    let mut text = String::new();
    if state.final_check.is_some() {
        text.push_str(
            "Режим: финальная проверка. Разговор идёт к завершению: новых тем не создавай, отмечай отвеченные.\n",
        );
    } else {
        text.push_str("Режим: обычный.\n");
    }

    text.push_str("\n# Темы\n\n");
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

    text.push_str("\n# Карточка текущей темы\n\n");
    match state.current_card() {
        Some(card) if !card.fields.is_empty() => {
            for field in &card.fields {
                text.push_str(&format!(
                    "- {}: {} (основания: {})\n",
                    field.field.as_str(),
                    one_line(&field.value),
                    sources(&field.evidence)
                ));
            }
        }
        _ if state.current_topic_id.is_none() => text.push_str("Текущей темы нет.\n"),
        _ => text.push_str("Полей пока нет.\n"),
    }

    text.push_str("\n# Вопросы звонка\n");
    for (status, title) in [
        (QuestionStatus::Open, "Открытые"),
        (QuestionStatus::Answered, "Отвеченные"),
        (QuestionStatus::Asked, "Заданные менеджером"),
        (
            QuestionStatus::Hidden,
            "Скрытые менеджером — не предлагай снова",
        ),
    ] {
        text.push_str(&format!("\n{title}:\n"));
        let questions: Vec<&Question> = state
            .questions
            .iter()
            .filter(|question| question.status == status)
            .collect();
        if questions.is_empty() {
            text.push_str("нет\n");
        }
        for question in questions {
            text.push_str(&question_line(question, state));
        }
    }

    text.push_str("\n# Расшифровка за последние 10 минут\n\n");
    if window.is_empty() {
        text.push_str("Расшифровки пока нет.\n");
    }
    for segment in window {
        text.push_str(&segment_line(segment));
        text.push('\n');
    }
    text.push('\n');
    text.push_str(STRUCTURED_OUTPUT);
    text
}

/// A call ready to run: its message and what it was given, for the checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assembled {
    pub user_message: String,
    pub context: CallContext,
}

/// Reads the state and the transcript of `recording_id` and assembles a
/// call with `prefix`.
pub fn assemble(
    connection: &Connection,
    recording_id: &str,
    prefix: &Prefix,
) -> CommandResult<Assembled> {
    let state = call_state::get(connection, recording_id)?;
    let segments = transcript::for_recording(connection, recording_id)?;
    let window = transcript_window(&segments, TRANSCRIPT_WINDOW);
    let user_message = user_message(&state, &window);
    let sources = window
        .iter()
        .map(|segment| SourceText::said(segment.id.clone(), segment.channel, segment.text.clone()))
        .collect();
    Ok(Assembled {
        user_message,
        context: CallContext::new(&state, sources, prefix.project_items.clone()),
    })
}

/// The ids as the message shows them (`S:…`, `T:…`, `Q:…`, in brackets)
/// back to the bare ids the storage has, should the agent copy them so.
pub fn strip_id_prefixes(patch: &mut Value) {
    let Some(ops) = patch.get_mut("ops").and_then(Value::as_array_mut) else {
        return;
    };
    for op in ops {
        for (key, prefix) in [("topicId", "T:"), ("questionId", "Q:")] {
            strip(op.get_mut(key), prefix);
        }
        let evidence = op.get_mut("evidence").and_then(Value::as_array_mut);
        for item in evidence.into_iter().flatten() {
            strip(item.get_mut("id"), "S:");
        }
    }
}

fn strip(value: Option<&mut Value>, prefix: &str) {
    let Some(Value::String(text)) = value else {
        return;
    };
    let bare = text.trim().trim_start_matches('[').trim_end_matches(']');
    let bare = bare.strip_prefix(prefix).unwrap_or(bare).trim().to_owned();
    *text = bare;
}

#[cfg(test)]
mod tests;
