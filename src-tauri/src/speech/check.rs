//! The bundled hardware-check phrases (speech-recognition design.md
//! decision 14): six synthetic call phrases, three Russian and three
//! Ukrainian of ~4, ~6 and ~12 s, as 16 kHz mono Ogg Opus next to a
//! `phrases.json` with their reference texts. Built by
//! `scripts/make-speech-check.sh`.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;

use super::language::Language;
use crate::recording::{SAMPLE_RATE, ogg_opus};

/// The directory inside the bundle's resources (`tauri.conf.json`).
pub const RESOURCE_DIR: &str = "speech-check";
const INDEX: &str = "phrases.json";

#[derive(Debug, thiserror::Error)]
pub enum CheckError {
    #[error("check phrases: {0}: {1}")]
    Read(PathBuf, std::io::Error),
    #[error("check phrases: {0}: {1}")]
    Index(PathBuf, serde_json::Error),
    #[error("check phrases: unknown language {0}")]
    Language(String),
}

/// One phrase, decoded.
#[derive(Debug, Clone)]
pub struct CheckPhrase {
    pub id: String,
    pub language: Language,
    /// The reference transcript.
    pub reference: String,
    /// 16 kHz mono.
    pub samples: Vec<f32>,
}

impl CheckPhrase {
    pub fn duration(&self) -> Duration {
        Duration::from_secs_f64(self.samples.len() as f64 / f64::from(SAMPLE_RATE))
    }
}

/// The phrases in file order and the spike's per-language glossary.
#[derive(Debug, Clone)]
pub struct CheckSet {
    pub phrases: Vec<CheckPhrase>,
    glossary_ru: String,
    glossary_uk: String,
}

impl CheckSet {
    /// A set of made-up phrases, for the tests.
    #[cfg(test)]
    pub fn new(phrases: Vec<CheckPhrase>, glossary_ru: &str, glossary_uk: &str) -> Self {
        Self {
            phrases,
            glossary_ru: glossary_ru.to_owned(),
            glossary_uk: glossary_uk.to_owned(),
        }
    }

    /// The glossary prompt the spike used for `language`.
    pub fn glossary(&self, language: Language) -> &str {
        match language {
            Language::Ru => &self.glossary_ru,
            Language::Uk => &self.glossary_uk,
        }
    }
}

#[derive(Deserialize)]
struct Index {
    glossary: IndexGlossary,
    phrases: Vec<IndexPhrase>,
}

#[derive(Deserialize)]
struct IndexGlossary {
    ru: String,
    uk: String,
}

#[derive(Deserialize)]
struct IndexPhrase {
    id: String,
    lang: String,
    file: String,
    #[serde(rename = "ref")]
    reference: String,
}

/// Reads and decodes every phrase of `dir`.
pub fn load(dir: &Path) -> Result<CheckSet, CheckError> {
    let index_path = dir.join(INDEX);
    let text = std::fs::read_to_string(&index_path)
        .map_err(|error| CheckError::Read(index_path.clone(), error))?;
    let index: Index =
        serde_json::from_str(&text).map_err(|error| CheckError::Index(index_path, error))?;
    let phrases = index
        .phrases
        .into_iter()
        .map(|phrase| {
            let language = match phrase.lang.as_str() {
                "ru" => Language::Ru,
                "uk" => Language::Uk,
                other => return Err(CheckError::Language(other.to_owned())),
            };
            let path = dir.join(&phrase.file);
            let samples =
                ogg_opus::read_file(&path).map_err(|error| CheckError::Read(path, error))?;
            Ok(CheckPhrase {
                id: phrase.id,
                language,
                reference: phrase.reference,
                samples,
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(CheckSet {
        phrases,
        glossary_ru: index.glossary.ru,
        glossary_uk: index.glossary.uk,
    })
}

/// The phrases in the source tree, for `tauri dev` and the tests.
pub fn dev_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(RESOURCE_DIR)
}

/// Where the bundled phrases are. A debug build falls back to the source
/// tree when the resource is not where Tauri looks (as the VAD model does).
pub fn bundled_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    use tauri::Manager;
    use tauri::path::BaseDirectory;

    let resolved = app
        .path()
        .resolve(RESOURCE_DIR, BaseDirectory::Resource)
        .ok();
    match resolved {
        Some(path) if path.join(INDEX).is_file() => path,
        _ if cfg!(debug_assertions) => dev_dir(),
        Some(path) => path,
        None => PathBuf::from(RESOURCE_DIR),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn six_phrases_decode_to_16_khz_with_plausible_durations() {
        let set = load(&dev_dir()).expect("bundled check phrases");
        assert_eq!(set.phrases.len(), 6);
        let ids: Vec<&str> = set.phrases.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["ru05", "ru11", "ru18", "uk02", "uk07", "uk12"]);

        for (language, durations) in [
            (Language::Ru, [4.0, 5.5, 11.0]),
            (Language::Uk, [3.5, 5.0, 10.5]),
        ] {
            let phrases: Vec<&CheckPhrase> = set
                .phrases
                .iter()
                .filter(|phrase| phrase.language == language)
                .collect();
            assert_eq!(phrases.len(), 3);
            for (phrase, at_least) in phrases.into_iter().zip(durations) {
                let seconds = phrase.duration().as_secs_f64();
                assert!(
                    (at_least..at_least + 2.5).contains(&seconds),
                    "{}: {seconds:.2} s",
                    phrase.id
                );
                assert!(!phrase.reference.is_empty());
                // Speech, not silence: telephone-band TTS around −25 dBFS.
                let rms = (phrase.samples.iter().map(|s| s * s).sum::<f32>()
                    / phrase.samples.len() as f32)
                    .sqrt();
                assert!((0.01..0.5).contains(&rms), "{}: rms {rms}", phrase.id);
            }
        }
        assert!(set.glossary(Language::Ru).contains("Техноком"));
        assert!(set.glossary(Language::Uk).contains("АгроСвіт"));
    }

    #[test]
    fn the_bundle_stays_under_half_a_megabyte() {
        let total: u64 = std::fs::read_dir(dev_dir())
            .expect("resource dir")
            .map(|entry| entry.expect("entry").metadata().expect("metadata").len())
            .sum();
        assert!(total <= 512 * 1024, "{total} bytes");
    }

    #[test]
    fn bundled_dir_falls_back_to_the_source_tree_in_debug() {
        let app = tauri::test::mock_app();
        let path = bundled_dir(app.handle());
        assert!(path.ends_with(RESOURCE_DIR), "{}", path.display());
        if cfg!(debug_assertions) {
            assert!(path.join(INDEX).is_file(), "{}", path.display());
        }
    }

    #[test]
    fn a_missing_dir_is_an_error() {
        assert!(matches!(
            load(Path::new("/nonexistent/speech-check")),
            Err(CheckError::Read(..))
        ));
    }

    /// Encodes the WAVs of `scripts/make-speech-check.sh` with the app's own
    /// writer. Run by the script; does nothing without its variables.
    #[test]
    #[ignore = "asset generator: scripts/make-speech-check.sh"]
    fn encode_check_phrases() {
        use crate::recording::ogg_opus::OggOpusWriter;
        use crate::vad::detector::test_audio::read_wav;

        let (Some(wavs), Some(out)) = (
            std::env::var_os("SPEECH_CHECK_WAV_DIR").map(PathBuf::from),
            std::env::var_os("SPEECH_CHECK_OUT_DIR").map(PathBuf::from),
        ) else {
            eprintln!("set SPEECH_CHECK_WAV_DIR and SPEECH_CHECK_OUT_DIR");
            return;
        };
        let mut entries: Vec<PathBuf> = std::fs::read_dir(&wavs)
            .expect("WAV dir")
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
            .collect();
        entries.sort();
        for wav in entries {
            let samples = read_wav(&wav);
            let target = out.join(wav.with_extension("opus").file_name().expect("name"));
            let file = std::fs::File::create(&target).expect("create");
            let mut writer = OggOpusWriter::new(std::io::BufWriter::new(file)).expect("writer");
            for frame in samples.chunks(160) {
                writer.write(frame).expect("write");
            }
            writer.finish().expect("finish");
            eprintln!(
                "{}: {:.2} s",
                target.display(),
                samples.len() as f64 / f64::from(SAMPLE_RATE)
            );
        }
    }
}
