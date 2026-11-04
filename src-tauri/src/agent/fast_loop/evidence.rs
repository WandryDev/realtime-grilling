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

/// The words of [`normalize`]d text.
pub fn words(text: &str) -> Vec<Vec<char>> {
    normalize(text)
        .split(' ')
        .filter(|word| !word.is_empty())
        .map(|word| word.chars().collect())
        .collect()
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
pub fn quote_matches(quote: &str, source: &str) -> bool {
    let quote = words(quote);
    let source = words(source);
    if quote.is_empty() || source.is_empty() {
        return false;
    }
    let size = quote.len().min(source.len());
    let needed = QUOTE_WORDS * quote.len() as f64;
    source.windows(size).any(|window| {
        let matched = window
            .iter()
            .zip(&quote)
            .filter(|(word, quoted)| word_similarity(word, quoted) >= WORD_SIMILARITY)
            .count();
        matched as f64 >= needed - f64::EPSILON
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
