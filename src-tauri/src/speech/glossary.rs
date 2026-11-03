//! The project glossary that prompts the model (speech-recognition
//! design.md decision 9).
//!
//! Terms go in priority order: the project name, the call's participants,
//! the project's other people, then the brief's glossary terms and stack.
//! They are joined with ", " and cut on whole terms: 600 characters for the
//! second pass, the first 300 for the live pass (the spike's ~170-character
//! prompt worked well, a ~900-character one made things worse).

use serde_json::Value;

/// Characters in the full (second-pass) prompt; ~150 tokens at ~4 per token.
pub const FULL_CHARS: usize = 600;
/// Characters in the live-pass prompt.
pub const LIVE_CHARS: usize = 300;
const SEPARATOR: &str = ", ";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Glossary {
    /// The terms inside the full prompt, in order.
    terms: Vec<String>,
    full: String,
    live: String,
}

impl Glossary {
    /// No project: recognition runs without a prompt.
    pub fn empty() -> Self {
        Self::default()
    }

    /// `brief` is the project's brief JSON: `glossary[].term` and `stack[]`
    /// are read when present, anything else is ignored.
    pub fn build(
        project_name: Option<&str>,
        participants: &[String],
        other_people: &[String],
        brief: Option<&Value>,
    ) -> Self {
        let brief_terms = brief
            .and_then(|brief| brief.get("glossary"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("term").and_then(Value::as_str));
        let stack = brief
            .and_then(|brief| brief.get("stack"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        let candidates = project_name
            .into_iter()
            .chain(participants.iter().map(String::as_str))
            .chain(other_people.iter().map(String::as_str))
            .chain(brief_terms)
            .chain(stack);

        let mut terms: Vec<String> = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        for candidate in candidates {
            let term = candidate.split_whitespace().collect::<Vec<_>>().join(" ");
            let key = term.to_lowercase();
            if term.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key);
            terms.push(term);
        }

        let full_count = fitting(&terms, FULL_CHARS);
        terms.truncate(full_count);
        let live_count = fitting(&terms, LIVE_CHARS);
        Self {
            full: terms.join(SEPARATOR),
            live: terms[..live_count].join(SEPARATOR),
            terms,
        }
    }

    /// The live-pass prompt: at most [`LIVE_CHARS`] characters.
    pub fn live(&self) -> &str {
        &self.live
    }

    /// The second-pass prompt: at most [`FULL_CHARS`] characters.
    pub fn full(&self) -> &str {
        &self.full
    }

    /// The terms of the full prompt, for the glossary-echo filter.
    pub fn terms(&self) -> &[String] {
        &self.terms
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

/// How many leading terms fit in `limit` characters once joined.
fn fitting(terms: &[String], limit: usize) -> usize {
    let mut length = 0;
    for (index, term) in terms.iter().enumerate() {
        let separator = if index == 0 { 0 } else { SEPARATOR.len() };
        length += separator + term.chars().count();
        if length > limit {
            return index;
        }
    }
    terms.len()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn names(names: &[&str]) -> Vec<String> {
        names.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn project_then_participants_then_people_then_brief() {
        let brief = json!({
            "glossary": [
                { "term": "Старший смены", "definition": "…" },
                { "term": "Первичка", "definition": "…" }
            ],
            "stack": ["amoCRM API v4", "Mango Office"],
            "summary": "ignored"
        });
        let glossary = Glossary::build(
            Some("Техноком"),
            &names(&["Марина Швец"]),
            &names(&["Олег Ковальчук"]),
            Some(&brief),
        );
        assert_eq!(
            glossary.full(),
            "Техноком, Марина Швец, Олег Ковальчук, Старший смены, Первичка, amoCRM API v4, Mango Office"
        );
        assert_eq!(glossary.live(), glossary.full());
        assert_eq!(glossary.terms().len(), 7);
    }

    #[test]
    fn duplicates_and_blanks_are_dropped() {
        let glossary = Glossary::build(
            Some("  Техноком "),
            &names(&["Марина  Швец", ""]),
            &names(&["марина швец", "Олег"]),
            Some(&json!({ "stack": ["ТЕХНОКОМ", "  "] })),
        );
        assert_eq!(glossary.full(), "Техноком, Марина Швец, Олег");
    }

    #[test]
    fn cut_on_whole_terms_at_600_and_300_characters() {
        // 50 terms of 18 characters: 18 + 20 per further term.
        let people: Vec<String> = (0..50).map(|n| format!("Участник номер {n:03}")).collect();
        let glossary = Glossary::build(None, &people, &[], None);

        let full = glossary.full().chars().count();
        let live = glossary.live().chars().count();
        assert!(full <= FULL_CHARS && full > FULL_CHARS - 20, "{full}");
        assert!(live <= LIVE_CHARS && live > LIVE_CHARS - 20, "{live}");
        assert_eq!(glossary.terms().len(), 30);
        assert!(glossary.full().starts_with(glossary.live()));
        // Whole terms only.
        assert!(glossary.full().ends_with("Участник номер 029"));
        assert!(glossary.live().ends_with("Участник номер 014"));
    }

    #[test]
    fn the_first_terms_win_the_cut() {
        let long_brief: Vec<Value> = (0..100)
            .map(|n| json!({ "term": format!("термин {n}") }))
            .collect();
        let glossary = Glossary::build(
            Some("Техноком"),
            &names(&["Марина Швец"]),
            &[],
            Some(&json!({ "glossary": long_brief })),
        );
        assert!(
            glossary
                .live()
                .starts_with("Техноком, Марина Швец, термин 0")
        );
        assert!(!glossary.terms().contains(&"термин 99".to_owned()));
    }

    #[test]
    fn no_project_is_an_empty_glossary() {
        let glossary = Glossary::build(None, &[], &[], None);
        assert!(glossary.is_empty());
        assert_eq!(glossary.full(), "");
        assert_eq!(glossary.live(), "");
        assert_eq!(glossary, Glossary::empty());
    }

    #[test]
    fn a_brief_without_the_fields_adds_nothing() {
        for brief in [
            json!({}),
            json!({ "glossary": "not a list", "stack": { "a": 1 } }),
            json!({ "glossary": [{ "definition": "no term" }, 5, null], "stack": [1, null] }),
            json!(null),
            json!([1, 2]),
        ] {
            let glossary = Glossary::build(Some("Техноком"), &[], &[], Some(&brief));
            assert_eq!(glossary.full(), "Техноком", "{brief}");
        }
    }
}
