//! Hallucination filters (speech-recognition design.md decision 8).
//!
//! Silero VAD in front of the model removes nearly all of them (spike: 0 of
//! 120 silent clips); these filters are the defence in depth behind it:
//!
//! 1. segments the model itself doubts: `no_speech_prob > 0.6` or
//!    `avg_logprob < −1.0`;
//! 2. stock phantoms of Whisper on ru/uk audio («Продолжение следует...»,
//!    «Дякую за перегляд!», subtitle credits, «[Музыка]»): a segment made of
//!    them only is dropped, and so is a phrase. Plain «Дякую.» / «Спасибо.» is
//!    a real word, so it is dropped only as the whole phrase;
//! 3. the prompt leaking into the text: three or more glossary terms in a row
//!    that neither neighbouring phrase of the channel mentions (the spike's
//!    `small` returned «Техноком, Олег Ковальчук, Bitrix24, ClickUp…» on
//!    silence with logprob −0.07, which no threshold catches).

use super::{glossary::Glossary, recognizer::Segment};

pub const MAX_NO_SPEECH_PROB: f32 = 0.6;
pub const MIN_AVG_LOGPROB: f32 = -1.0;
/// Glossary terms in a row that make a phrase an echo of the prompt.
pub const GLOSSARY_RUN: usize = 3;

/// Whole-phrase phantoms after [`normalize`]. A phrase made of one or more
/// of them (repeats included) is dropped.
const PHANTOMS: &[&str] = &[
    // ru
    "продолжение следует",
    "спасибо за просмотр",
    "подписывайтесь на канал",
    "музыка",
    "веселая музыка",
    "спокойная музыка",
    "динамичная музыка",
    "тревожная музыка",
    "грустная музыка",
    "аплодисменты",
    "смех",
    // uk
    "дякую за перегляд",
    "продовження слідує",
    "підписуйтесь на канал",
    "музика",
    "оплески",
    "сміх",
];

/// Phantoms that run to the end of the phrase whatever follows (credits with
/// names: «Субтитры сделал DimaTorzok», «Редактор субтитров Н.Закомолдина
/// Корректор А.Егорова»).
const PHANTOM_PREFIXES: &[&str] = &[
    "субтитры",
    "редактор субтитров",
    "субтитри",
    "редактор субтитрів",
];

/// Real words, phantoms only when they are the whole phrase.
const WEAK_PHANTOMS: &[&str] = &["дякую", "спасибо"];

/// Lowercase, `ё` → `е`, apostrophes removed, every other non-alphanumeric
/// character a space, whitespace collapsed.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars().flat_map(char::to_lowercase) {
        match c {
            'ё' => out.push('е'),
            '\'' | '’' | 'ʼ' | '`' => {}
            c if c.is_alphanumeric() => out.push(c),
            _ => out.push(' '),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The phrase text after the filters, or `None` when nothing is left.
///
/// `neighbours` are the channel's finished phrases around this one (up to
/// two), for the glossary-echo check.
pub fn filter(segments: &[Segment], glossary: &Glossary, neighbours: &[&str]) -> Option<String> {
    let kept: Vec<&str> = segments
        .iter()
        .filter(|segment| confident(segment))
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty() && !is_phantom(&normalize(text)))
        .collect();
    let text = kept.join(" ");
    let normalized = normalize(&text);
    if normalized.is_empty()
        || is_phantom(&normalized)
        || WEAK_PHANTOMS.contains(&normalized.as_str())
        || echoes_glossary(&normalized, glossary.terms(), neighbours)
    {
        return None;
    }
    Some(text)
}

fn confident(segment: &Segment) -> bool {
    segment.no_speech_prob <= MAX_NO_SPEECH_PROB && segment.avg_logprob >= MIN_AVG_LOGPROB
}

/// Whether normalized text is one or more strong phantoms and nothing else.
fn is_phantom(normalized: &str) -> bool {
    let mut rest = normalized;
    loop {
        if rest.is_empty() {
            return true;
        }
        if PHANTOM_PREFIXES
            .iter()
            .any(|prefix| starts_with_words(rest, prefix))
        {
            return true;
        }
        let Some(phantom) = PHANTOMS
            .iter()
            .find(|phantom| starts_with_words(rest, phantom))
        else {
            return false;
        };
        rest = rest[phantom.len()..].trim_start();
    }
}

/// `text` starts with `words` on a word boundary.
fn starts_with_words(text: &str, words: &str) -> bool {
    text.strip_prefix(words)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
}

/// Three or more glossary terms in a row, none of them in the neighbours.
fn echoes_glossary(normalized: &str, terms: &[String], neighbours: &[&str]) -> bool {
    let words: Vec<&str> = normalized.split(' ').collect();
    let mut terms: Vec<Vec<String>> = terms
        .iter()
        .map(|term| {
            normalize(term)
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|term| !term.is_empty())
        .collect();
    if terms.len() < GLOSSARY_RUN {
        return false;
    }
    // Longest first, so «Google Таблицы» wins over a shorter «Google».
    terms.sort_by_key(|term| std::cmp::Reverse(term.len()));
    let neighbours: Vec<Vec<String>> = neighbours
        .iter()
        .map(|text| normalize(text).split(' ').map(str::to_owned).collect())
        .collect();
    let known = |term: &[String]| {
        neighbours
            .iter()
            .any(|neighbour| neighbour.windows(term.len()).any(|window| window == term))
    };

    let mut run = 0;
    let mut index = 0;
    while index < words.len() {
        let matched = terms.iter().find(|term| {
            words.len() - index >= term.len()
                && term.iter().zip(&words[index..]).all(|(t, w)| t == w)
        });
        match matched {
            Some(term) => {
                run = if known(term) { 0 } else { run + 1 };
                if run >= GLOSSARY_RUN {
                    return true;
                }
                index += term.len();
            }
            None => {
                run = 0;
                index += 1;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str) -> Segment {
        Segment {
            text: text.to_owned(),
            no_speech_prob: 0.05,
            avg_logprob: -0.3,
        }
    }

    fn glossary() -> Glossary {
        let names = |names: &[&str]| names.iter().map(ToString::to_string).collect::<Vec<_>>();
        Glossary::build(
            Some("Техноком"),
            &names(&["Олег Ковальчук", "Марина Швец"]),
            &names(&["Андрей Литвиненко"]),
            Some(&serde_json::json!({
                "stack": ["Bitrix24", "ClickUp", "amoCRM", "Google Таблицы", "CRM"]
            })),
        )
    }

    fn run(texts: &[&str], neighbours: &[&str]) -> Option<String> {
        let segments: Vec<Segment> = texts.iter().map(|text| segment(text)).collect();
        filter(&segments, &glossary(), neighbours)
    }

    #[test]
    fn normalization() {
        assert_eq!(
            normalize("  Ещё раз: «Продолжение   следует...»! "),
            "еще раз продолжение следует"
        );
        assert_eq!(normalize("П'ять, п’ять — [Музыка]"), "пять пять музыка");
        assert_eq!(normalize("Bitrix24, CRM."), "bitrix24 crm");
    }

    #[test]
    fn the_table() {
        let cases: &[(&[&str], &[&str], Option<&str>)] = &[
            // Stock phantoms.
            (&[" Продолжение следует..."], &[], None),
            (&[" Дякую за перегляд!"], &[], None),
            (&[" ПРОДОЛЖЕНИЕ СЛЕДУЕТ"], &[], None),
            (
                &[" Продолжение следует... Продолжение следует..."],
                &[],
                None,
            ),
            (&[" Спасибо за просмотр!"], &[], None),
            (&[" Субтитры сделал DimaTorzok"], &[], None),
            (&[" Субтитры создавал DimaTorzok"], &[], None),
            (
                &[" Редактор субтитров Н.Закомолдина Корректор А.Егорова"],
                &[],
                None,
            ),
            (&[" [Музыка]"], &[], None),
            (&[" [Музика]"], &[], None),
            (&[" (музыка)", " Дякую за перегляд!"], &[], None),
            // «Дякую» is a word: only the whole phrase is dropped.
            (&[" Дякую."], &[], None),
            (&[" Спасибо!"], &[], None),
            (
                &[" Дякую, все зрозуміло."],
                &[],
                Some("Дякую, все зрозуміло."),
            ),
            // A phantom segment after real speech goes, the speech stays.
            (
                &[" Задачи ставим прямо в CRM.", " Продолжение следует..."],
                &[],
                Some("Задачи ставим прямо в CRM."),
            ),
            // Phantoms inside a real sentence are not phantoms.
            (
                &[" Продолжение следует обсудить на следующей неделе."],
                &[],
                Some("Продолжение следует обсудить на следующей неделе."),
            ),
            (
                &[" Спасибо за просмотр документа, вопросов нет."],
                &[],
                Some("Спасибо за просмотр документа, вопросов нет."),
            ),
            // The glossary verbatim.
            (&[" Техноком, Олег Ковальчук, Bitrix24, ClickUp"], &[], None),
            (&[" Bitrix24, ClickUp, amoCRM."], &[], None),
            (
                &[" Олег Ковальчук, Марина Швец, Андрей Литвиненко."],
                &[],
                None,
            ),
            // A real phrase with two names passes.
            (
                &[" Олег Ковальчук и Марина Швец будут на следующем звонке."],
                &[],
                Some("Олег Ковальчук и Марина Швец будут на следующем звонке."),
            ),
            (
                &[" Свяжитесь, пожалуйста, с Олегом Ковальчуком и Мариной Швец."],
                &[],
                Some("Свяжитесь, пожалуйста, с Олегом Ковальчуком и Мариной Швец."),
            ),
            // Terms split by words are not a run.
            (
                &[" Сделки в Bitrix24, задачи в ClickUp, отчёты в Google Таблицы."],
                &[],
                Some("Сделки в Bitrix24, задачи в ClickUp, отчёты в Google Таблицы."),
            ),
            // The neighbours talk about those terms: a list is fine.
            (
                &[" Bitrix24, ClickUp, amoCRM."],
                &["Какие системы у вас сейчас: Bitrix24, ClickUp?", "Понятно."],
                Some("Bitrix24, ClickUp, amoCRM."),
            ),
            // Empty and blank.
            (&[], &[], None),
            (&["   ", " ... "], &[], None),
        ];
        for (segments, neighbours, expected) in cases {
            assert_eq!(
                run(segments, neighbours).as_deref(),
                *expected,
                "{segments:?} next to {neighbours:?}"
            );
        }
    }

    #[test]
    fn doubtful_segments_are_dropped() {
        let doubtful_speech = Segment {
            no_speech_prob: 0.61,
            ..segment(" Алло.")
        };
        let low_logprob = Segment {
            avg_logprob: -1.01,
            ..segment(" Какой-то шум.")
        };
        let on_the_edge = Segment {
            no_speech_prob: 0.6,
            avg_logprob: -1.0,
            ..segment(" Да, верно.")
        };
        assert_eq!(
            filter(
                &[doubtful_speech.clone(), low_logprob.clone(), on_the_edge],
                &glossary(),
                &[]
            )
            .as_deref(),
            Some("Да, верно.")
        );
        assert_eq!(
            filter(&[doubtful_speech, low_logprob], &glossary(), &[]),
            None
        );
    }

    #[test]
    fn no_glossary_no_echo_check() {
        let segments = [segment(" Bitrix24, ClickUp, amoCRM.")];
        assert_eq!(
            filter(&segments, &Glossary::empty(), &[]).as_deref(),
            Some("Bitrix24, ClickUp, amoCRM.")
        );
    }
}
