//! Whether a quote is in its source (design.md, decision 5): the transcript
//! has recognition errors, so the match is fuzzy, word by word.

/// Two words match when their Levenshtein similarity is at least this.
pub const WORD_SIMILARITY: f64 = 0.75;
/// A quote matches when at least this share of its words match.
pub const QUOTE_WORDS: f64 = 0.8;
/// A quote has at least this many words (fewer only when its source is
/// shorter): one or two common words are in almost every phrase.
pub const MIN_QUOTE_WORDS: usize = 3;
/// … and at least this many letters and digits (fewer only when its source
/// has fewer).
pub const MIN_QUOTE_CHARS: usize = 10;
/// Words that turn a phrase into its opposite: a quote must keep them as
/// they are, and must not add or drop one.
const NEGATIONS: [&str; 4] = ["не", "нет", "ни", "без"];
/// Of [`NEGATIONS`], those that negate the word after them: a quote that
/// starts right after one dropped it.
const LEADING_NEGATIONS: [&str; 3] = ["не", "ни", "без"];

/// Lower case, `ё` → `е`, punctuation as spaces, spaces collapsed.
pub fn normalize(text: &str) -> String {
    let spaced: String = text
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'ё' => 'е',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A word of [`normalize`]d text and the bytes of the original it comes
/// from.
struct Word {
    chars: Vec<char>,
    start: usize,
    end: usize,
}

/// The words of `text` as [`normalize`] splits them, with where they are.
fn spans(text: &str) -> Vec<Word> {
    let mut found: Vec<Word> = Vec::new();
    let mut current: Option<Word> = None;
    for (at, original) in text.char_indices() {
        let end = at + original.len_utf8();
        for lower in original.to_lowercase() {
            let mapped = if lower == 'ё' { 'е' } else { lower };
            if mapped.is_alphanumeric() {
                let word = current.get_or_insert(Word {
                    chars: Vec::new(),
                    start: at,
                    end,
                });
                word.chars.push(mapped);
                word.end = end;
            } else if let Some(word) = current.take() {
                found.push(word);
            }
        }
    }
    found.extend(current);
    found
}

/// The words of [`normalize`]d text.
pub fn words(text: &str) -> Vec<Vec<char>> {
    spans(text).into_iter().map(|word| word.chars).collect()
}

fn is_one_of(word: &[char], list: &[&str]) -> bool {
    list.iter()
        .any(|known| known.chars().eq(word.iter().copied()))
}

/// A negation or a word with a digit: «не будем» is not «будем», «50» is
/// not «5», so such a word matches only itself.
fn exact_only(word: &[char]) -> bool {
    word.iter().any(|c| c.is_numeric()) || is_one_of(word, &NEGATIONS)
}

/// 1 − distance / longer length: 1 for equal words, 0 for nothing alike.
pub fn word_similarity(a: &[char], b: &[char]) -> f64 {
    let longer = a.len().max(b.len());
    if longer == 0 {
        return 1.0;
    }
    1.0 - levenshtein(a, b) as f64 / longer as f64
}

fn levenshtein(a: &[char], b: &[char]) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    let mut current = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        current[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let substitution = previous[j] + usize::from(ca != cb);
            current[j + 1] = substitution.min(previous[j + 1] + 1).min(current[j] + 1);
        }
        std::mem::swap(&mut previous, &mut current);
    }
    previous[b.len()]
}

/// Letters and digits of [`normalize`]d text.
fn letters(words: &[Vec<char>]) -> usize {
    words.iter().map(Vec::len).sum()
}

/// The letters and digits of `text`.
pub fn letter_count(text: &str) -> usize {
    letters(&words(text))
}

/// Whether `quote` is long enough to stand for `source`: at least
/// `min(`[`MIN_QUOTE_WORDS`]`, words of the source)` words and
/// `min(`[`MIN_QUOTE_CHARS`]`, letters of the source)` letters and digits.
/// A one-word answer («Да.») may be quoted whole.
pub fn quote_long_enough(quote: &str, source: &str) -> bool {
    let quote = words(quote);
    let source = words(source);
    !quote.is_empty()
        && quote.len() >= MIN_QUOTE_WORDS.min(source.len())
        && letters(&quote) >= MIN_QUOTE_CHARS.min(letters(&source))
}

/// Whether `quote` (n words) is found in `source`: some window of n words of
/// the source has at least [`QUOTE_WORDS`] of the quote's words in place
/// (each [`WORD_SIMILARITY`] alike). A source shorter than the quote is one
/// window; the missing words count as not found. An empty quote is not
/// found.
///
/// Negations (не, нет, ни, без) and words with digits match only exactly,
/// both ways: a window fails when such a word of the quote or of the
/// window is not the same word at the same place, and when the window
/// starts right after «не», «ни» or «без» (the quote dropped it). «мы будем
/// подключать» is not found in «мы не будем подключать», «5 операторов» is
/// not found in «50 операторов».
pub fn quote_matches(quote: &str, source: &str) -> bool {
    quote_span(quote, source).is_some()
}

/// The text of `source` that [`quote_matches`] found for `quote`, from its
/// first to its last word, as the source has it: what the client said,
/// not the agent's wording of it.
pub fn quote_span<'a>(quote: &str, source: &'a str) -> Option<&'a str> {
    let quote = words(quote);
    let found = spans(source);
    if quote.is_empty() || found.is_empty() {
        return None;
    }
    let size = quote.len().min(found.len());
    let needed = QUOTE_WORDS * quote.len() as f64;
    (0..=found.len() - size).find_map(|start| {
        if start > 0 && is_one_of(&found[start - 1].chars, &LEADING_NEGATIONS) {
            return None;
        }
        let window = &found[start..start + size];
        let mut matched = 0;
        for (index, quoted) in quote.iter().enumerate() {
            match window.get(index) {
                Some(word) if exact_only(&word.chars) || exact_only(quoted) => {
                    if word.chars != *quoted {
                        return None;
                    }
                    matched += 1;
                }
                Some(word) => {
                    if word_similarity(&word.chars, quoted) >= WORD_SIMILARITY {
                        matched += 1;
                    }
                }
                None if exact_only(quoted) => return None,
                None => {}
            }
        }
        (f64::from(matched) >= needed - f64::EPSILON)
            .then(|| &source[window[0].start..window[size - 1].end])
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEGMENT: &str = "Ну, у нас сейчас пять операторов в смену — иногда шесть, если сезон.";

    #[test]
    fn normalizes_case_yo_and_punctuation() {
        assert_eq!(
            normalize("  Ещё РАЗ: всё —  «по-новому»!! "),
            "еще раз все по новому"
        );
        assert_eq!(normalize("10:30, 1С"), "10 30 1с");
        assert_eq!(normalize("?!"), "");
    }

    #[test]
    fn compares_words_by_levenshtein() {
        let w = |text: &str| text.chars().collect::<Vec<_>>();
        assert!((word_similarity(&w("смену"), &w("смену")) - 1.0).abs() < f64::EPSILON);
        // One letter of ten.
        assert!(word_similarity(&w("операторов"), &w("операторав")) >= WORD_SIMILARITY);
        // Another ending of a short word is one letter of five.
        assert!(word_similarity(&w("смену"), &w("смены")) >= WORD_SIMILARITY);
        assert!(word_similarity(&w("пять"), &w("шесть")) < WORD_SIMILARITY);
        assert!(word_similarity(&w(""), &w("")) >= WORD_SIMILARITY);
    }

    #[test]
    fn an_exact_quote_matches_whatever_the_case_and_punctuation() {
        assert!(quote_matches("пять операторов в смену", SEGMENT));
        assert!(quote_matches("У НАС сейчас, пять операторов", SEGMENT));
        assert!(quote_matches("иногда шесть если сезон", SEGMENT));
        assert!(
            quote_matches("Ну у нас", SEGMENT),
            "the start of the source"
        );
    }

    /// «Цитата с ошибкой распознавания»: one distorted word passes.
    #[test]
    fn one_distorted_word_passes() {
        assert!(quote_matches(
            "у нас сейчас пять операторав в смену",
            SEGMENT
        ));
        // Two of five words replaced: 60 % is not enough.
        assert!(!quote_matches("у нас сейчас десять менеджеров", SEGMENT));
    }

    /// «Выдуманная цитата».
    #[test]
    fn an_invented_quote_does_not_match() {
        assert!(!quote_matches(
            "мы планируем нанять десять операторов",
            SEGMENT
        ));
        assert!(!quote_matches("пять человек", SEGMENT));
        assert!(!quote_matches("", SEGMENT));
        assert!(!quote_matches("...", SEGMENT));
        assert!(!quote_matches("пять", ""));
    }

    /// One or two common words are in almost every phrase: they prove
    /// nothing.
    #[test]
    fn a_quote_is_three_words_and_ten_letters_at_least() {
        assert!(quote_matches("нас", SEGMENT), "it is in the segment…");
        assert!(!quote_long_enough("нас", SEGMENT), "…but proves nothing");
        assert!(!quote_long_enough("у нас", SEGMENT));
        assert!(
            !quote_long_enough("ну у нас", SEGMENT),
            "three words, six letters"
        );
        assert!(quote_long_enough("пять операторов в смену", SEGMENT));
        assert!(quote_long_enough("у нас сейчас", SEGMENT));
        assert!(!quote_long_enough("", SEGMENT));
        assert!(!quote_long_enough("— …", SEGMENT));
        // A source shorter than that may be quoted whole.
        assert!(quote_long_enough("Да.", "Да."));
        assert!(quote_long_enough("нет не нужно", "Нет, не нужно."));
        assert!(!quote_long_enough("нет", "Нет, не нужно."));
    }

    /// A quote that drops «не» or changes a number says the opposite of
    /// the client: not found, whichever words are around.
    #[test]
    fn negations_and_numbers_match_only_exactly() {
        let refused = "Нет, мы не будем подключать 1С в этом году.";
        assert!(!quote_matches(
            "мы будем подключать 1С в этом году",
            refused
        ));
        assert!(!quote_matches("будем подключать 1С в этом году", refused));
        assert!(
            quote_matches("мы не будем подключать 1С в том году", refused),
            "the negation kept, the rest still fuzzy: found"
        );
        // Adding one is as wrong as dropping one.
        assert!(!quote_matches("у нас сейчас не пять операторов", SEGMENT));
        assert!(!quote_matches("пять операторов без смены", SEGMENT));
        let counted = "У нас 50 операторов, а заявок 1000 в день.";
        assert!(!quote_matches("у нас 5 операторов", counted));
        assert!(!quote_matches("а заявок 2000 в день", counted));
        assert!(quote_matches("у нас 50 операторов", counted));
        assert!(quote_matches("а заявок 1000 в день", counted));
        // The fuzzy words around stay fuzzy.
        assert!(quote_matches("у нас 50 операторав", counted));
        assert!(quote_matches("мы не будем подключать 1С", refused));
    }

    /// The span is the source's own text, punctuation and case included.
    #[test]
    fn the_span_is_the_client_s_words() {
        assert_eq!(
            quote_span("пять операторав в смену", SEGMENT),
            Some("пять операторов в смену")
        );
        assert_eq!(
            quote_span("у нас сейчас пять", SEGMENT),
            Some("у нас сейчас пять")
        );
        assert_eq!(quote_span("Ну у нас", SEGMENT), Some("Ну, у нас"));
        assert_eq!(
            quote_span("иногда шесть если сезон", SEGMENT),
            Some("иногда шесть, если сезон")
        );
        assert_eq!(quote_span("Ещё раз", "Всё — ЕЩЁ раз!"), Some("ЕЩЁ раз"));
        assert_eq!(quote_span("десять менеджеров", SEGMENT), None);
    }

    #[test]
    fn a_quote_longer_than_its_source() {
        // Four of five words found.
        assert!(quote_matches(
            "пять операторов в смену днём",
            "пять операторов в смену"
        ));
        assert!(!quote_matches(
            "пять операторов в смену днём и ночью",
            "пять операторов"
        ));
    }
}
