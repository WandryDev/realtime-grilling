use std::time::Instant;

use super::*;

fn source(id: &str, kind: FindingSourceKind, name: &str, text: &str) -> SearchableSource {
    SearchableSource {
        id: id.to_owned(),
        name: name.to_owned(),
        kind,
        url: (kind != FindingSourceKind::File).then(|| format!("https://example/{id}")),
        text: text.to_owned(),
    }
}

fn file(id: &str, text: &str) -> SearchableSource {
    source(id, FindingSourceKind::File, &format!("{id}.md"), text)
}

fn queries(list: &[&str]) -> Vec<String> {
    list.iter().map(|query| (*query).to_owned()).collect()
}

fn keys(found: &[Candidate]) -> Vec<&str> {
    found
        .iter()
        .map(|candidate| candidate.key.as_str())
        .collect()
}

const REGULATION: &str = "# Регламент смены\n\n\
## Старший смены\n\n\
Оператор смены отвечает за распределение звонков между линиями. В смене три оператора, \
старший смены следит за очередью и подменяет тех, кто ушёл на перерыв.\n\n\
## Ночь\n\n\
Ночью звонки уходят на автоответчик клиники, утром их разбирает первая смена.";

#[test]
fn words_are_stemmed_numbers_kept_and_stop_words_dropped() {
    assert_eq!(terms("Операторы смены"), terms("оператор смены"));
    assert_eq!(terms("операторов"), terms("оператору"));
    assert_eq!(terms("Ёлка"), terms("елка"));
    assert_eq!(terms("integrations"), terms("integration"));
    assert_eq!(terms("и в на не к"), Vec::<String>::new());
    assert_eq!(
        terms("5 операторов"),
        vec!["5".to_owned(), terms("оператор")[0].clone()]
    );
    assert_eq!(terms("amoCRM v4, 1С"), ["amocrm", "v4", "1с"]);
}

/// Spec «Словоформы»: the client said «операторы смены», the Outline
/// document says «оператор смены отвечает за…».
#[test]
fn word_forms_find_the_chunk() {
    let index = Index::build(vec![
        source(
            "reg",
            FindingSourceKind::Outline,
            "Регламент смены",
            REGULATION,
        ),
        file(
            "other",
            "Интеграция с amoCRM через API v4: сделки и контакты.",
        ),
    ]);
    let found = index.search(&queries(&["операторы смены"]));
    assert_eq!(found[0].key, "reg#0");
    assert_eq!(found[0].path, "Регламент смены › Старший смены");
    assert!(found[0].text.starts_with("Оператор смены отвечает"));
    assert_eq!(found[0].source.kind, FindingSourceKind::Outline);
    assert_eq!(found[0].source.url.as_deref(), Some("https://example/reg"));
    assert!(found.iter().all(|candidate| candidate.source.id == "reg"));
    // A heading's words find its chunk.
    assert_eq!(keys(&index.search(&queries(&["ночь"])))[0], "reg#1");
}

#[test]
fn numbers_match_exactly() {
    let index = Index::build(vec![
        file(
            "five",
            "В смене 5 операторов, они принимают звонки клиники.",
        ),
        file("fifty", "В смене 50 операторов, они принимают звонки сети."),
    ]);
    assert_eq!(keys(&index.search(&queries(&["50"]))), ["fifty#0"]);
    assert_eq!(keys(&index.search(&queries(&["5"]))), ["five#0"]);
}

#[test]
fn an_empty_query_finds_nothing() {
    let index = Index::build(vec![file("reg", REGULATION)]);
    assert!(index.search(&[]).is_empty());
    assert!(index.search(&queries(&["", "  ", "и в на"])).is_empty());
    assert!(index.search(&queries(&["криптовалюта"])).is_empty());
    assert!(Index::build(Vec::new()).is_empty());
    assert!(Index::build(vec![file("blank", "  \n\n ")]).is_empty());
}

/// At most three chunks of a source, twelve in all; the queries fused.
#[test]
fn three_per_source_and_twelve_in_all() {
    let section = |n: usize| {
        format!(
            "## Раздел {n}\n\nОператор смены принимает звонки, раздел номер {n}. {}\n\n",
            "Подробности регламента. ".repeat(14)
        )
    };
    let long: String = (0..10).map(section).collect();
    let mut sources = vec![file("big", &long)];
    for n in 0..10 {
        sources.push(file(
            &format!("s{n}"),
            &format!("Оператор смены, заметка {n}."),
        ));
    }
    let index = Index::build(sources);
    let found = index.search(&queries(&["оператор смены", "регламент"]));
    assert_eq!(found.len(), TOP);
    let from_big = found
        .iter()
        .filter(|candidate| candidate.source.id == "big")
        .count();
    assert_eq!(from_big, PER_SOURCE);
    // «регламент» is only in the big one: its chunks lead after the fusion.
    assert!(
        found[..PER_SOURCE]
            .iter()
            .all(|candidate| candidate.source.id == "big")
    );
}

/// Chunks of 300–1 200 characters on blank lines and headings, with the
/// path of headings.
#[test]
fn texts_are_cut_on_blank_lines_and_headings() {
    let paragraph = |n: usize| format!("Абзац {n}. {}", "Текст абзаца документа. ".repeat(8));
    let mut text = String::from("# Документ\n\nВведение.\n\n## Первый\n\n");
    for n in 0..8 {
        text.push_str(&paragraph(n));
        text.push_str("\n\n");
    }
    text.push_str("### Вложенный\n\nКоротко.\n\n## Второй\n\n");
    text.push_str(&"Очень длинная строка без пустых строк. ".repeat(80));
    let chunks = chunk(&text);
    let paths: Vec<&str> = chunks.iter().map(|(path, _)| path.as_str()).collect();
    assert_eq!(paths[0], "Документ");
    assert_eq!(chunks[0].1, "Введение.");
    assert!(paths.contains(&"Документ › Первый › Вложенный"));
    let second: Vec<&(String, String)> = chunks
        .iter()
        .filter(|(path, _)| path == "Документ › Второй")
        .collect();
    assert!(second.len() >= 3, "{second:?}");
    let first: Vec<&(String, String)> = chunks
        .iter()
        .filter(|(path, _)| path == "Документ › Первый")
        .collect();
    assert!(first.len() >= 2);
    for (_, text) in first.iter().chain(&second) {
        let length = text.chars().count();
        assert!(
            (MIN_CHUNK..=MAX_CHUNK).contains(&length),
            "{length}: {text}"
        );
    }
    // Paragraphs are kept whole.
    assert!(first[0].1.starts_with("Абзац 0."));
}

/// A ClickUp task: its description and its comments are separate chunks.
#[test]
fn a_clickup_task_is_cut_by_its_sections() {
    let comments: Vec<String> = (0..40)
        .map(|n| {
            format!("**Аня, 01.03.2026 10:{n:02}:** Комментарий номер {n} про сроки интеграции.")
        })
        .collect();
    let text = format!(
        "# Интеграция с МИС\nСтатус: to do · Список: Телемедиа\n\nНужна **интеграция** с МИС.\
         \n\n## Комментарии\n{}",
        comments.join("\n")
    );
    let chunks = chunk(&text);
    assert_eq!(chunks[0].0, "Интеграция с МИС");
    assert!(chunks[0].1.contains("Нужна **интеграция** с МИС."));
    assert!(!chunks[0].1.contains("Комментарий"));
    let rest: Vec<&(String, String)> = chunks[1..].iter().collect();
    assert!(rest.len() >= 2);
    for (path, text) in rest {
        assert_eq!(path, "Интеграция с МИС › Комментарии");
        assert!(text.chars().count() <= MAX_CHUNK);
        assert!(text.starts_with("**Аня"), "a comment is not cut: {text}");
    }
}

/// Task 2.1: 200 documents of 50 000 characters index in under a second
/// (a release build: `cargo test --release --lib -- index_of_200`).
#[test]
#[cfg_attr(debug_assertions, ignore = "timing: run with --release")]
fn index_of_200_documents_builds_in_under_a_second() {
    let words = [
        "оператор",
        "смены",
        "звонки",
        "клиника",
        "очередь",
        "регламент",
        "пациент",
        "запись",
        "интеграция",
        "амоцрм",
        "телефония",
        "распределение",
        "старший",
        "перерыв",
        "ночью",
        "автоответчик",
        "договор",
        "сроки",
        "бюджет",
        "отчёт",
        "операторов",
        "сменами",
        "звонков",
        "клиники",
        "очереди",
        "регламента",
        "пациентам",
        "записью",
        "интеграции",
        "телефонией",
        "распределяет",
        "старшему",
        "перерыва",
        "договора",
        "срокам",
        "бюджета",
    ];
    let documents: Vec<SearchableSource> = (0..200)
        .map(|doc| {
            let mut text = String::new();
            let mut n = doc;
            while text.chars().count() < 50_000 {
                if n % 97 == 0 {
                    text.push_str(&format!("\n\n## Раздел {n}\n\n"));
                } else if n % 13 == 0 {
                    text.push_str(".\n\n");
                }
                text.push_str(words[n % words.len()]);
                text.push(' ');
                if n % 11 == 0 {
                    text.push_str(&format!("{} ", n % 500));
                }
                n = n.wrapping_mul(31).wrapping_add(17) % 100_003;
            }
            file(&format!("d{doc}"), &text)
        })
        .collect();
    let started = Instant::now();
    let index = Index::build(documents);
    let took = started.elapsed();
    eprintln!("{} chunks indexed in {took:?}", index.chunk_count());
    assert!(index.chunk_count() > 200 * 40);
    assert!(took.as_secs_f64() < 1.0, "built in {took:?}");
    let started = Instant::now();
    let found = index.search(&queries(&[
        "оператор смены",
        "амоцрм интеграция",
        "сроки 5",
    ]));
    assert_eq!(found.len(), TOP);
    assert!(
        started.elapsed().as_millis() < 200,
        "searched in {:?}",
        started.elapsed()
    );
}
