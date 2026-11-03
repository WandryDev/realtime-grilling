//! The call language (speech-recognition design.md decision 7).
//!
//! The setting is `ru`, `uk` or `both`. With one language the model is told
//! that language and never detects. With both, the recognizer detects the
//! language of a phrase and only Russian or Ukrainian may win; the choice is
//! kept per channel for 30 s so most phrases skip the extra encoder pass.

use std::time::{Duration, Instant};

use crate::storage::transcript::TranscriptChannel;

/// How long a detected language holds for a channel.
pub const DETECTION_TTL: Duration = Duration::from_secs(30);

/// A language the model is told to transcribe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    Ru,
    Uk,
}

impl Language {
    /// The whisper.cpp language code.
    pub fn code(self) -> &'static str {
        match self {
            Self::Ru => "ru",
            Self::Uk => "uk",
        }
    }
}

/// The «Язык звонка» setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CallLanguage {
    #[default]
    Ru,
    Uk,
    Both,
}

impl CallLanguage {
    /// The setting's value; anything else is `None`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ru" => Some(Self::Ru),
            "uk" => Some(Self::Uk),
            "both" => Some(Self::Both),
            _ => None,
        }
    }

    /// The fixed language, or `None` when it has to be detected.
    pub fn fixed(self) -> Option<Language> {
        match self {
            Self::Ru => Some(Language::Ru),
            Self::Uk => Some(Language::Uk),
            Self::Both => None,
        }
    }
}

/// What a recognition job is told about the language.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LanguageChoice {
    Fixed(Language),
    /// Detect, then take Russian or Ukrainian, whichever is more probable.
    Detect,
}

/// Russian or Ukrainian from the model's language probabilities: whichever
/// is higher, every other language ignored. A tie, or neither listed,
/// falls to Ukrainian.
pub fn pick(probabilities: &[(String, f32)]) -> Language {
    let probability = |code: &str| {
        probabilities
            .iter()
            .filter(|(candidate, _)| candidate == code)
            .map(|(_, p)| *p)
            .fold(0.0_f32, f32::max)
    };
    if probability("ru") > probability("uk") {
        Language::Ru
    } else {
        Language::Uk
    }
}

/// The per-channel choice for one recording.
#[derive(Debug)]
pub struct LanguageCache {
    setting: CallLanguage,
    ttl: Duration,
    /// Last detection per channel: `me`, `others`.
    detected: [Option<(Language, Instant)>; 2],
}

fn slot(channel: TranscriptChannel) -> usize {
    match channel {
        TranscriptChannel::Me => 0,
        TranscriptChannel::Others => 1,
    }
}

impl LanguageCache {
    pub fn new(setting: CallLanguage) -> Self {
        Self::with_ttl(setting, DETECTION_TTL)
    }

    pub fn with_ttl(setting: CallLanguage, ttl: Duration) -> Self {
        Self {
            setting,
            ttl,
            detected: [None; 2],
        }
    }

    /// What the next phrase of `channel` should run with at `now`.
    pub fn choice(&self, channel: TranscriptChannel, now: Instant) -> LanguageChoice {
        if let Some(language) = self.setting.fixed() {
            return LanguageChoice::Fixed(language);
        }
        match self.detected[slot(channel)] {
            Some((language, at)) if now.saturating_duration_since(at) < self.ttl => {
                LanguageChoice::Fixed(language)
            }
            _ => LanguageChoice::Detect,
        }
    }

    /// Keeps a detection made at `now`. Fixed settings ignore it.
    pub fn remember(&mut self, channel: TranscriptChannel, language: Language, now: Instant) {
        if self.setting == CallLanguage::Both {
            self.detected[slot(channel)] = Some((language, now));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probabilities(pairs: &[(&str, f32)]) -> Vec<(String, f32)> {
        pairs
            .iter()
            .map(|(code, p)| ((*code).to_owned(), *p))
            .collect()
    }

    #[test]
    fn the_setting_parses() {
        assert_eq!(CallLanguage::parse("ru"), Some(CallLanguage::Ru));
        assert_eq!(CallLanguage::parse("uk"), Some(CallLanguage::Uk));
        assert_eq!(CallLanguage::parse("both"), Some(CallLanguage::Both));
        assert_eq!(CallLanguage::parse("en"), None);
        assert_eq!(Language::Uk.code(), "uk");
    }

    #[test]
    fn only_russian_or_ukrainian_can_win() {
        let polish_first = probabilities(&[("pl", 0.6), ("uk", 0.25), ("ru", 0.1), ("en", 0.05)]);
        assert_eq!(pick(&polish_first), Language::Uk);
        let english_first = probabilities(&[("en", 0.7), ("ru", 0.2), ("uk", 0.1)]);
        assert_eq!(pick(&english_first), Language::Ru);
        assert_eq!(
            pick(&probabilities(&[("ru", 0.51), ("uk", 0.49)])),
            Language::Ru
        );
    }

    #[test]
    fn a_tie_or_nothing_known_is_ukrainian() {
        assert_eq!(
            pick(&probabilities(&[("ru", 0.3), ("uk", 0.3)])),
            Language::Uk
        );
        assert_eq!(pick(&probabilities(&[("en", 1.0)])), Language::Uk);
        assert_eq!(pick(&[]), Language::Uk);
    }

    #[test]
    fn one_language_never_detects() {
        let start = Instant::now();
        let mut cache = LanguageCache::new(CallLanguage::Ru);
        assert_eq!(
            cache.choice(TranscriptChannel::Others, start),
            LanguageChoice::Fixed(Language::Ru)
        );
        cache.remember(TranscriptChannel::Others, Language::Uk, start);
        assert_eq!(
            cache.choice(TranscriptChannel::Others, start),
            LanguageChoice::Fixed(Language::Ru)
        );
        let cache = LanguageCache::new(CallLanguage::Uk);
        assert_eq!(
            cache.choice(TranscriptChannel::Me, start),
            LanguageChoice::Fixed(Language::Uk)
        );
    }

    #[test]
    fn both_detects_and_keeps_the_choice_for_30_s_per_channel() {
        let start = Instant::now();
        let mut cache = LanguageCache::new(CallLanguage::Both);
        assert_eq!(
            cache.choice(TranscriptChannel::Others, start),
            LanguageChoice::Detect
        );

        cache.remember(TranscriptChannel::Others, Language::Uk, start);
        let later = |seconds| start + Duration::from_secs(seconds);
        assert_eq!(
            cache.choice(TranscriptChannel::Others, later(29)),
            LanguageChoice::Fixed(Language::Uk)
        );
        // The other channel detects on its own.
        assert_eq!(
            cache.choice(TranscriptChannel::Me, later(1)),
            LanguageChoice::Detect
        );
        assert_eq!(
            cache.choice(TranscriptChannel::Others, later(30)),
            LanguageChoice::Detect
        );

        cache.remember(TranscriptChannel::Others, Language::Ru, later(31));
        assert_eq!(
            cache.choice(TranscriptChannel::Others, later(40)),
            LanguageChoice::Fixed(Language::Ru)
        );
    }
}
