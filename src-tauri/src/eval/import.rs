//! `grill-eval import`: a call recorded outside the app (Zoom, Meet,
//! Telegram, a phone) into a corpus (question-quality design.md, decision
//! 2a; `specs/question-replay`, «Импорт внешней записи звонка»).
//!
//! 1. [`decode`]: `ffmpeg` gives 16 kHz mono per track: two files (the
//!    manager's and `--others`), the two sides of a stereo file
//!    (`--channels left=me|right=me`), or one mixed track (`mono`).
//! 2. [`passes`]: the app's live pass and second pass over the tracks.
//! 3. [`label`]: a mono recording's phrases split between «Я» and
//!    «Остальные» by one Claude Code call; the corpus is `approximate`.
//! 4. The project from `--project` (its markdown is the description),
//!    documents from `--docs` through the app's text extraction, people
//!    from `--people`. The brief stays empty (`grill-eval brief`).
//!
//! The audio is copied to `.grill-eval/audio/<name>/` with the corpus, and
//! only once everything went through: a failed import leaves nothing. The
//! audio never leaves the machine: only the transcript goes to Claude Code,
//! and only for a mono recording.

pub mod decode;
pub mod label;
pub mod passes;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::Deserialize;
use serde_json::Value;

use self::{
    decode::{Decoder, Pick},
    passes::{Heard, Speech, Track, Tracks},
};
use super::{
    corpus::{
        self, Channels, Corpus, Layout, Origin, Person, Project, Recording, Segment, SourceText,
    },
    export,
};
use crate::{
    agent::claude_cli::{Agent, Usage},
    projects::sources::extract::{FileKind, extract_file},
    speech::models::{self, ModelId, ModelState},
    storage::{
        self,
        settings::{self, SettingsMap},
        transcript::TranscriptChannel,
    },
};

/// What `grill-eval import` was asked.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// The recording, or the manager's track with `others`.
    pub audio: PathBuf,
    /// The client's track.
    pub others: Option<PathBuf>,
    /// `--channels`: for one file.
    pub channels: Option<Layout>,
    /// The project's description, markdown.
    pub project: PathBuf,
    pub docs: Vec<PathBuf>,
    /// A JSON array of `{ name, role, profile? }`.
    pub people: Option<PathBuf>,
    /// The manager's name, for the labeling of a mono recording.
    pub manager: Option<String>,
    /// The corpus's name; the audio file's name without the extension by
    /// default.
    pub name: Option<String>,
    /// The fast loop's settings of the app (`questionFrequency`,
    /// `questionCount`, `callLanguage`); the defaults when empty.
    pub settings: SettingsMap,
    /// Progress lines on stderr.
    pub progress: bool,
}

/// What the import made.
#[derive(Debug, Clone)]
pub struct Imported {
    pub path: PathBuf,
    pub corpus: Corpus,
    /// The labeling call of a mono recording.
    pub labeling: Option<Usage>,
}

/// `--channels` as given.
pub fn parse_layout(value: &str) -> Result<Layout, String> {
    match value {
        "left=me" => Ok(Layout::LeftMe),
        "right=me" => Ok(Layout::RightMe),
        "mono" => Ok(Layout::Mono),
        other => Err(format!(
            "--channels: left=me, right=me или mono, а не «{other}»"
        )),
    }
}

/// How the channels of the recording are taken: from the flags, and for
/// one file without `--channels`, from its channels.
pub fn layout(options: &Options, decoder: &dyn Decoder) -> Result<Layout, String> {
    if options.others.is_some() {
        return match options.channels {
            None => Ok(Layout::TwoFiles),
            Some(_) => {
                Err("--channels — для одного файла, а с --others дорожки уже свои".to_owned())
            }
        };
    }
    let channels = decoder.channels(&options.audio)?;
    match (options.channels, channels) {
        (Some(Layout::Mono), _) | (None, 1) => Ok(Layout::Mono),
        (None, _) => Err(format!(
            "В {} {channels} канала: укажите --channels left=me, right=me или mono",
            options.audio.display()
        )),
        (Some(_), 1) => Err(format!(
            "{} — моно: --channels left=me|right=me не подходит, укажите --channels mono",
            options.audio.display()
        )),
        (Some(layout), _) => Ok(layout),
    }
}

/// The tracks of the recording.
pub fn decode(options: &Options, layout: Layout, decoder: &dyn Decoder) -> Result<Tracks, String> {
    let one = |path: &Path, pick| decoder.decode(path, pick);
    Ok(match layout {
        Layout::TwoFiles => {
            let others = options
                .others
                .as_deref()
                .ok_or("Для двух дорожек нужен --others")?;
            Tracks::Split {
                me: one(&options.audio, Pick::Mix)?,
                others: one(others, Pick::Mix)?,
            }
        }
        Layout::LeftMe => Tracks::Split {
            me: one(&options.audio, Pick::Channel(0))?,
            others: one(&options.audio, Pick::Channel(1))?,
        },
        Layout::RightMe => Tracks::Split {
            me: one(&options.audio, Pick::Channel(1))?,
            others: one(&options.audio, Pick::Channel(0))?,
        },
        Layout::Mono => Tracks::Mixed(one(&options.audio, Pick::Mix)?),
    })
}

/// The app's settings an import runs with, from its database at `database`
/// (read-only): the fast loop's for the corpus and the `speechModel`. The
/// defaults when there is no database yet.
pub fn app_settings(database: &Path) -> Result<(SettingsMap, ModelId), String> {
    if !database.is_file() {
        return Ok((SettingsMap::new(), ModelId::Turbo));
    }
    let connection = storage::open_read_only(database)?;
    let stored = settings::get(&connection).map_err(|error| error.to_string())?;
    let loop_settings = export::LOOP_SETTINGS
        .iter()
        .filter_map(|key| Some(((*key).to_owned(), stored.get(*key)?.clone())))
        .collect();
    Ok((loop_settings, settings::speech_model(&stored)))
}

/// The Whisper model the app recognizes with: the `speechModel` setting's,
/// installed in `models_dir`, or the other one when only it is.
pub fn installed_model(models_dir: &Path, selected: ModelId) -> Result<(ModelId, PathBuf), String> {
    let others = ModelId::ALL.into_iter().filter(|id| *id != selected);
    std::iter::once(selected)
        .chain(others)
        .find(|id| models::detect(models_dir, *id, id.spec().size) == ModelState::Ready)
        .map(|id| (id, models::model_file(models_dir, id)))
        .ok_or_else(|| {
            format!(
                "Модели распознавания не скачаны (нет в {}): откройте приложение и скачайте \
                 модель в настройках распознавания",
                models_dir.display()
            )
        })
}

/// The name of the project: the description's first `# heading`, else
/// `fallback`.
fn project_name(description: &str, fallback: &str) -> String {
    description
        .lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The texts of `docs`, read as the app reads a project's documents.
async fn documents(docs: &[PathBuf]) -> Result<Vec<SourceText>, String> {
    let mut texts = Vec::with_capacity(docs.len());
    for path in docs {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default();
        let kind = FileKind::from_extension(extension)
            .ok_or_else(|| format!("{}: поддерживаются .md, .txt, .pdf и .docx", path.display()))?;
        let bytes = fs::read(path)
            .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
        let extraction = extract_file(kind, bytes, path).await;
        if extraction.text.is_empty() {
            return Err(format!(
                "Из {} не прочитан текст: {}",
                path.display(),
                extraction.error.unwrap_or_default()
            ));
        }
        texts.push(SourceText {
            name: file_name(path),
            text: extraction.text,
        });
    }
    Ok(texts)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PersonInput {
    name: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    profile: Option<Value>,
}

/// `--people`: a JSON array of `{ name, role, profile? }`.
fn people(path: &Path) -> Result<Vec<Person>, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("Не удалось прочитать {}: {error}", path.display()))?;
    let inputs: Vec<PersonInput> = serde_json::from_str(&text).map_err(|error| {
        format!(
            "{}: нужен JSON-массив {{ name, role, profile? }}: {error}",
            path.display()
        )
    })?;
    inputs
        .into_iter()
        .map(|input| {
            let profile = input
                .profile
                .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
            if !profile.is_object() {
                return Err(format!(
                    "{}: профиль {} должен быть объектом",
                    path.display(),
                    input.name
                ));
            }
            Ok(Person {
                id: storage::new_id(),
                name: input.name,
                role: input.role,
                profile,
            })
        })
        .collect()
}

fn segments(heard: Vec<Heard>) -> Result<Vec<Segment>, String> {
    heard
        .into_iter()
        .map(|phrase| {
            let channel = match phrase.track {
                Track::Me => TranscriptChannel::Me,
                Track::Others => TranscriptChannel::Others,
                Track::Mixed => return Err("Фраза моно-записи без разметки".to_owned()),
            };
            Ok(Segment {
                id: phrase.id,
                channel,
                start_ms: phrase.start_ms,
                end_ms: phrase.end_ms,
                text: phrase.text,
            })
        })
        .collect()
}

/// Copies the audio to `.grill-eval/audio/<name>/`; the copied files'
/// names.
fn copy_audio(options: &Options, eval_dir: &Path, name: &str) -> Result<Vec<String>, String> {
    let dir = eval_dir.join("audio").join(name);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Не удалось создать {}: {error}", dir.display()))?;
    let mut copied = Vec::new();
    for source in std::iter::once(&options.audio).chain(&options.others) {
        let name = file_name(source);
        if copied.contains(&name) {
            return Err(format!("Две дорожки с одним именем файла: {name}"));
        }
        fs::copy(source, dir.join(&name))
            .map_err(|error| format!("Не удалось скопировать {}: {error}", source.display()))?;
        copied.push(name);
    }
    Ok(copied)
}

/// Imports the recording into the corpus in `eval_dir`. `tracks` are the
/// recording's audio as [`decode`] gave it; `agent` labels a mono one.
/// `work_dir` is scratch space (the passes' files, the labeling prompt).
pub async fn run(
    options: &Options,
    layout: Layout,
    tracks: &Tracks,
    speech: &Speech,
    agent: Option<Arc<dyn Agent>>,
    eval_dir: &Path,
    work_dir: &Path,
) -> Result<Imported, String> {
    let name = options
        .name
        .clone()
        .unwrap_or_else(|| file_stem(&options.audio));
    corpus::check_name(&name)?;
    let labeler = match (layout, agent) {
        (Layout::Mono, None) => {
            return Err("Моно-запись размечает Claude Code, а он недоступен".to_owned());
        }
        (Layout::Mono, agent) => agent,
        _ => None,
    };
    let description = fs::read_to_string(&options.project).map_err(|error| {
        format!(
            "Не удалось прочитать описание {}: {error}",
            options.project.display()
        )
    })?;
    let fallback = options
        .name
        .clone()
        .unwrap_or_else(|| file_stem(&options.project));
    let project = Project {
        name: project_name(&description, &fallback),
        description: description.trim().to_owned(),
        notes: String::new(),
        brief: None,
        sources: documents(&options.docs).await?,
    };
    let people = match &options.people {
        Some(path) => people(path)?,
        None => Vec::new(),
    };
    let imported_at = storage::now_ms();
    let mut corpus = Corpus {
        version: corpus::FORMAT,
        name: name.clone(),
        origin: Origin::Import {
            files: Vec::new(),
            layout,
            model: speech.model.as_str().to_owned(),
            imported_at,
        },
        channels: if layout == Layout::Mono {
            Channels::Approximate
        } else {
            Channels::Real
        },
        project: Some(project),
        // Everyone given is on the call.
        participant_ids: people.iter().map(|person| person.id.clone()).collect(),
        people,
        glossary: String::new(),
        settings: options.settings.clone(),
        recording: Recording {
            started_at: imported_at,
            duration_ms: tracks.duration_ms(),
        },
        live: Vec::new(),
        refined: None,
        original: None,
    };

    let transcribed = passes::transcribe(
        &corpus,
        tracks,
        speech,
        &work_dir.join("data"),
        options.progress,
    )
    .await?;
    if transcribed.live.is_empty() {
        return Err("Распознавание не нашло в записи ни одной фразы".to_owned());
    }
    let (live, refined, labeling) = match labeler {
        Some(agent) => {
            // The judge reads the refined pass: the labels come from it.
            let source = if transcribed.refined.is_empty() {
                &transcribed.live
            } else {
                &transcribed.refined
            };
            let (channels, usage) = label::label(
                &agent,
                source,
                corpus
                    .project
                    .as_ref()
                    .map_or("", |p| p.description.as_str()),
                options.manager.as_deref(),
                &work_dir.join("prompts"),
            )
            .await?;
            let labeled: Vec<(Heard, TranscriptChannel)> =
                source.iter().cloned().zip(channels).collect();
            let relabel =
                |phrases: &[Heard]| label::apply(phrases, &label::by_time(phrases, &labeled));
            (
                relabel(&transcribed.live),
                relabel(&transcribed.refined),
                Some(usage),
            )
        }
        None => (transcribed.live, transcribed.refined, None),
    };
    corpus.glossary = transcribed.glossary;
    corpus.live = segments(live)?;
    let refined = segments(refined)?;
    corpus.refined = (!refined.is_empty()).then_some(refined);

    let files = copy_audio(options, eval_dir, &name)?;
    if let Origin::Import { files: copied, .. } = &mut corpus.origin {
        *copied = files;
    }
    let path = corpus::path_of(eval_dir, &name);
    corpus.save(&path)?;
    Ok(Imported {
        path,
        corpus,
        labeling,
    })
}

#[cfg(test)]
mod tests;
