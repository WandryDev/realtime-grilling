//! Whether a new question repeats a known one (design.md, decision 6). The
//! comparison is by text, behind a trait: embeddings can come as a second
//! implementation.

use std::collections::HashSet;

use super::evidence::normalize;

/// How alike two questions are.
pub trait QuestionSimilarity: Send + Sync {
    /// 0 (nothing alike) to 1 (the same).
    fn score(&self, a: &str, b: &str) -> f64;

    /// From this score on, a question repeats another.
    fn threshold(&self) -> f64;

    #[cfg(test)]
    fn is_repeat(&self, a: &str, b: &str) -> bool {
        self.score(a, b) >= self.threshold()
    }
}

/// The Dice coefficient of the character trigrams of the [`normalize`]d
/// texts, each word padded with spaces: word order does not matter, another
/// ending changes one or two trigrams of a word.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TrigramSimilarity {
    pub threshold: f64,
}

impl TrigramSimilarity {
    pub const DEFAULT_THRESHOLD: f64 = 0.6;
}

impl Default for TrigramSimilarity {
    fn default() -> Self {
        Self {
            threshold: Self::DEFAULT_THRESHOLD,
        }
    }
}

fn trigrams(text: &str) -> HashSet<[char; 3]> {
    let mut trigrams = HashSet::new();
    for word in normalize(text).split(' ').filter(|word| !word.is_empty()) {
        let padded: Vec<char> = std::iter::once(' ')
            .chain(word.chars())
            .chain(std::iter::once(' '))
            .collect();
        for window in padded.windows(3) {
            trigrams.insert([window[0], window[1], window[2]]);
        }
    }
    trigrams
}

impl QuestionSimilarity for TrigramSimilarity {
    fn score(&self, a: &str, b: &str) -> f64 {
        let (a, b) = (trigrams(a), trigrams(b));
        if a.is_empty() && b.is_empty() {
            return 1.0;
        }
        let shared = a.intersection(&b).count();
        2.0 * shared as f64 / (a.len() + b.len()) as f64
    }

    fn threshold(&self) -> f64 {
        self.threshold
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Other endings and word order: the same question.
    const REPEATS: [(&str, &str); 6] = [
        (
            "Сколько операторов работает в смену?",
            "Сколько операторов в смене работает",
        ),
        (
            "Кто отвечает на звонки ночью?",
            "Ночью кто отвечает на звонок?",
        ),
        (
            "Как вы сейчас записываете звонки?",
            "Как сейчас записываются звонки?",
        ),
        (
            "Какая CRM используется у вас сейчас?",
            "Какую CRM вы сейчас используете?",
        ),
        (
            "Сколько звонков в день приходит на линию?",
            "Сколько в день звонков приходит на линию",
        ),
        (
            "Нужно ли записывать разговоры с пациентами?",
            "Записывать ли разговоры с пациентами нужно?",
        ),
    ];

    /// Questions of one topic that ask different things.
    const DIFFERENT: [(&str, &str); 6] = [
        (
            "Сколько операторов работает в смену?",
            "Сколько звонков в час принимает оператор?",
        ),
        (
            "Что слышит клиент, когда все операторы заняты?",
            "Сколько операторов работает в смену?",
        ),
        (
            "Нужна ли запись разговоров?",
            "Где хранить записи разговоров?",
        ),
        (
            "Кто отвечает на звонки ночью?",
            "Кто отвечает за настройку очереди?",
        ),
        (
            "Сколько звонков в день приходит на линию?",
            "Сколько звонков теряется в пиковые часы?",
        ),
        (
            "Как оператор узнаёт, что пациент уже звонил?",
            "Как пациент узнаёт, что запись подтверждена?",
        ),
    ];

    #[test]
    fn other_endings_and_word_order_are_a_repeat() {
        let similarity = TrigramSimilarity::default();
        for (a, b) in REPEATS {
            assert!(
                similarity.is_repeat(a, b),
                "{a} | {b}: {}",
                similarity.score(a, b)
            );
            assert!(similarity.is_repeat(b, a), "symmetric: {a} | {b}");
        }
    }

    #[test]
    fn different_questions_of_one_topic_are_not() {
        let similarity = TrigramSimilarity::default();
        for (a, b) in DIFFERENT {
            assert!(
                !similarity.is_repeat(a, b),
                "{a} | {b}: {}",
                similarity.score(a, b)
            );
        }
    }

    #[test]
    fn case_punctuation_and_yo_do_not_matter() {
        let similarity = TrigramSimilarity::default();
        let score = similarity.score("Кто ещё звонит НОЧЬЮ?!", "кто еще звонит ночью");
        assert!((score - 1.0).abs() < f64::EPSILON, "{score}");
        assert!(similarity.score("", "").ge(&1.0));
        assert!(similarity.score("вопрос", "").abs() < f64::EPSILON);
    }
}
