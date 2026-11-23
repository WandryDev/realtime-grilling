//! A prompt written section by section (call-analytics design.md, decision
//! 2): the journal keeps each part, the CLI gets their concatenation, the
//! same bytes as before the parts existed.

use crate::storage::journal::PromptPart;

/// The parts of a prompt being written: text goes to the last section.
#[derive(Debug, Default)]
pub struct Sections {
    parts: Vec<PromptPart>,
}

impl Sections {
    /// Starts with the section `label`.
    pub fn new(label: &str) -> Self {
        let mut sections = Self::default();
        sections.section(label);
        sections
    }

    /// Starts the section `label`: the text written next goes there.
    pub fn section(&mut self, label: &str) {
        self.parts.push(PromptPart::new(label, String::new()));
    }

    pub fn push_str(&mut self, text: &str) {
        if self.parts.is_empty() {
            self.section("text");
        }
        if let Some(part) = self.parts.last_mut() {
            part.text.push_str(text);
        }
    }

    pub fn push(&mut self, char: char) {
        self.push_str(char.encode_utf8(&mut [0; 4]));
    }

    /// The parts written, the empty ones left out.
    pub fn into_parts(self) -> Vec<PromptPart> {
        self.parts
            .into_iter()
            .filter(|part| !part.text.is_empty())
            .collect()
    }
}

/// The text the CLI gets: the parts one after another.
pub fn join(parts: &[PromptPart]) -> String {
    parts.iter().map(|part| part.text.as_str()).collect()
}
