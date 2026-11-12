use super::*;
use crate::{
    agent::{
        fast_loop::testing::{database, recording, say},
        slow_loop::search::IndexSource,
    },
    storage::{
        call_state::{
            self, CardLens, Evidence, EvidenceSource, GapType, NewQuestion, ValidatedOp,
            ValidatedPatch,
        },
        context_findings::{self, FindingSourceKind, NewFinding},
        projects::{self, ProjectUpdate},
        transcript,
    },
};

const OTHERS: TranscriptChannel = TranscriptChannel::Others;
const ME: TranscriptChannel = TranscriptChannel::Me;

fn candidate(key: &str, kind: FindingSourceKind, name: &str, path: &str, text: &str) -> Candidate {
    Candidate {
        key: key.to_owned(),
        source: IndexSource {
            id: key.split('#').next().unwrap().to_owned(),
            name: name.to_owned(),
            kind,
            url: None,
        },
        path: path.to_owned(),
        text: text.to_owned(),
    }
}

/// Task 3.1: the message of a call on a fixed state.
#[test]
fn the_message_has_the_state_the_transcript_the_queries_and_the_candidates() {
    let db = database();
    let id = recording(&db);
    let evidence = vec![Evidence {
        source: EvidenceSource::Project,
        id: "P1".to_owned(),
        quote: "система приёма звонков".to_owned(),
    }];
    call_state::apply_patch(
        &db,
        &id,
        &ValidatedPatch {
            ops: vec![
                ValidatedOp::CreateTopic {
                    title: "Регистрация".to_owned(),
                },
                ValidatedOp::CreateTopic {
                    title: "Очередь операторов".to_owned(),
                },
                ValidatedOp::SetCardField {
                    field: CardLens::Users,
                    value: "Пять операторов\nв смену".to_owned(),
                    evidence: evidence.clone(),
                },
                ValidatedOp::AddQuestion(NewQuestion {
                    text: "Кто распределяет звонки?".to_owned(),
                    description: String::new(),
                    card_field: CardLens::Scenarios,
                    gap_type: GapType::Empty,
                    priority: 2,
                    evidence,
                }),
            ],
        },
    )
    .unwrap();
    context_findings::insert_at(
        &db,
        &id,
        &NewFinding {
            source_id: None,
            source_kind: FindingSourceKind::ClickUp,
            source_name: "Интеграция с МИС".to_owned(),
            source_url: None,
            chunk_key: "t#0".to_owned(),
            quote: "Клиент ответил: до марта".to_owned(),
            note: "Дополняет: срок".to_owned(),
            question_id: None,
            agent_call_id: None,
        },
        10,
    )
    .unwrap();
    // 4 minutes ago: out of the window.
    say(&db, &id, OTHERS, 0, "Давно сказанное");
    let manager = say(&db, &id, ME, 200_000, "Сколько у вас операторов?");
    let client = say(&db, &id, OTHERS, 230_000, "Операторы смены,\nпять человек");
    let state = call_state::get(&db, &id).unwrap();
    let segments = transcript::for_recording(&db, &id).unwrap();
    let topic = |n: usize| state.topics[n].id.clone();
    let question = state.questions[0].id.clone();

    let message = user_message(
        &state,
        &segments,
        &["старший смены".to_owned()],
        &[
            candidate(
                "reg#0",
                FindingSourceKind::Outline,
                "Регламент смены",
                "Регламент › Старший смены",
                "Оператор смены отвечает за звонки.\nВ смене три оператора.",
            ),
            candidate(
                "tz#2",
                FindingSourceKind::File,
                "ТЗ.docx",
                "",
                "  Пять линий.  ",
            ),
        ],
    );
    let expected = format!(
        "# Темы\n\n\
         - [T:{t0}] Регистрация\n\
         - [T:{t1}] Очередь операторов (текущая)\n\
         \n# Карточка текущей темы\n\n\
         - users: Пять операторов в смену\n\
         \n# Открытые вопросы\n\n\
         - [Q:{question}] Кто распределяет звонки?\n\
         \n# Уже показанные находки\n\n\
         - [D1] ClickUp «Интеграция с МИС»: «Клиент ответил: до марта»\n\
         \n# Расшифровка за последние 3 минуты\n\n\
         [S:{manager}] 03:20 Я: Сколько у вас операторов?\n\
         [S:{client}] 03:50 Остальные: Операторы смены, пять человек\n\
         \n# Твои запросы из прошлого вызова\n\n\
         - старший смены\n\
         \n# Кандидаты\n\
         \n[C1] Outline «Регламент смены» › Регламент › Старший смены\n\
         Оператор смены отвечает за звонки.\nВ смене три оператора.\n\
         \n[C2] Файл «ТЗ.docx»\n\
         Пять линий.\n\
         \nПередай ответ одним вызовом инструмента StructuredOutput.",
        t0 = topic(0),
        t1 = topic(1),
        manager = manager.id,
        client = client.id,
    );
    assert_eq!(message, expected);
    assert_eq!(client_query(&segments), "Операторы смены, пять человек");
}

#[test]
fn an_empty_state_says_so() {
    let db = database();
    let id = recording(&db);
    let state = call_state::get(&db, &id).unwrap();
    let message = user_message(&state, &[], &[], &[]);
    for line in [
        "Тем пока нет.",
        "Текущей темы нет.",
        "# Открытые вопросы\n\nНет.",
        "# Уже показанные находки\n\nНет.",
        "Расшифровки пока нет.",
        "# Твои запросы из прошлого вызова\n\nНет.",
    ] {
        assert!(message.contains(line), "no «{line}» in {message}");
    }
    assert_eq!(client_query(&[]), "");
}

/// The prompt: the rules, the project's name and description; the same
/// bytes for the same storage, the file under the recording's id.
#[test]
fn the_prompt_has_the_rules_and_the_project() {
    let db = database();
    let id = recording(&db);
    let text = prompt(&db, &id).unwrap();
    assert!(text.starts_with(RULES));
    assert!(text.ends_with(
        "# Проект\n\nНазвание: Телемедиа\nОписание: Единая система приёма звонков для сети клиник\n"
    ));
    assert_eq!(prompt(&db, &id).unwrap(), text);
    for rule in [
        "до двух находок",
        "Пустой список находок — нормальный ответ",
        "ДОСЛОВНАЯ цитата из текста этого кандидата, 3–25 слов",
        "«Подтверждает: …», «Дополняет: …» или «Противоречит: …»",
        "Не пересказывай бриф проекта",
        "Кандидаты — материалы проекта, а не слова клиента",
        "до 3 запросов для следующего поиска, каждый до 8 слов",
    ] {
        assert!(RULES.contains(rule), "no «{rule}» in the rules");
    }

    let project_id = crate::storage::recordings::get(&db, &id)
        .unwrap()
        .project_id
        .unwrap();
    projects::update(
        &db,
        &project_id,
        ProjectUpdate {
            description: Some(String::new()),
            ..ProjectUpdate::default()
        },
    )
    .unwrap();
    assert!(prompt(&db, &id).unwrap().ends_with("Название: Телемедиа\n"));

    let dir = tempfile::tempdir().unwrap();
    let path = write_prompt(dir.path(), &id, &text).unwrap();
    assert_eq!(path, prompt_path(dir.path(), &id));
    assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    assert!(path.to_string_lossy().ends_with(".slow.md"));
    std::fs::write(dir.path().join("other.prompt.md"), "fast").unwrap();
    assert_eq!(sweep_prompts(dir.path(), |kept| kept == id).unwrap(), 0);
    assert_eq!(sweep_prompts(dir.path(), |_| false).unwrap(), 1);
    assert!(
        dir.path().join("other.prompt.md").exists(),
        "the fast loop's stay"
    );
}

/// The reply schema is short enough for the command line.
#[test]
fn the_schema_is_one_short_line() {
    let argument = crate::agent::slow_loop::scheduler::schema_argument();
    assert!(argument.len() < 2 * 1024, "{} bytes", argument.len());
    assert!(!argument.contains('\n'));
}
