//! The app's two recognition passes over imported tracks (question-quality
//! design.md, decision 2a), through the app's own code:
//!
//! - live: each track goes through a [`VadWorker`] (the recorder's
//!   segmenter, sliding passes included) into the app's [`TranscriptSink`]
//!   (greedy decoding, the live glossary, the filters), which stores the
//!   phrases as the live transcript;
//! - refined: the tracks are written as the recording's Ogg Opus files and
//!   the app's [`Refiner`] runs over them (beam search, the full glossary).
//!
//! Both run against an in-memory database seeded from the corpus being
//! built (the project and the people give the glossary as in the app) and
//! a scratch folder for the files. The tracks are fed as fast as the
//! recognizer takes them, not in real time: a phrase's time is its place
//! in the file either way. The live pass's lag and skip are off, as there
//! is no call to keep up with.

use std::{
    fs::File,
    io::BufWriter,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::Duration,
};

use rusqlite::Connection;
use tokio::sync::Notify;

use super::super::{corpus::Corpus, replay};
use crate::{
    error::CommandResult,
    events::DataChanged,
    recording::ogg_opus::OggOpusWriter,
    speech::{
        context,
        events::TranscriptEvent,
        host::{DbWork, SpeechHost, with_database},
        live::{LiveConfig, TranscriptSink},
        models::ModelId,
        recognizer::{Priority, Recognizer},
        refiner::{Refiner, RefinerConfig},
        status::TranscriptionStatus,
    },
    storage::{
        self,
        recordings::{self, TranscriptState},
        transcript::{self, TranscriptChannel, TranscriptPass, TranscriptSegment},
    },
    vad::{
        SAMPLE_RATE, SAMPLES_PER_MS,
        worker::{PhraseSink, SegmentationStatus, VadWorker},
    },
};

/// The live pass never lags behind a call here: no lag reports, no skips.
const LIVE: LiveConfig = LiveConfig {
    lag_after: Duration::from_secs(24 * 3_600),
    skip_after: Duration::from_secs(24 * 3_600),
    lag_every: Duration::from_secs(3_600),
};
/// The tracks go to the VAD a second at a time...
const CHUNK_SAMPLES: usize = SAMPLE_RATE as usize;
/// ...while it is less than this behind (it drops audio past 30 s)...
const MAX_VAD_BACKLOG_MS: u64 = 3_000;
/// ...and the recognizer has less than this much live audio queued, so
/// the phrases waiting for it don't pile up in memory.
const MAX_LIVE_QUEUE_SAMPLES: usize = 60 * SAMPLE_RATE as usize;
/// How often the refined pass is looked at.
const POLL: Duration = Duration::from_millis(100);

/// What recognizes: the app's recognizer over an installed model, a fake
/// in tests.
pub struct Speech {
    pub recognizer: Recognizer,
    /// The model the recognizer loads (the corpus records it).
    pub model: ModelId,
    /// The Silero model of the segmentation.
    pub vad_model: PathBuf,
}

/// The audio of an imported recording, 16 kHz mono per track.
#[derive(Debug, Clone, PartialEq)]
pub enum Tracks {
    /// The manager's track and the client's.
    Split { me: Vec<f32>, others: Vec<f32> },
    /// One track with both.
    Mixed(Vec<f32>),
}

/// Whose a phrase is; `Mixed` until a mono recording is labeled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Track {
    Me,
    Others,
    Mixed,
}

impl Tracks {
    /// The pipeline's channels: a mixed track runs as «Остальные», with
    /// a second of silence as «Я» (the second pass reads two files).
    fn channels(&self) -> Vec<(TranscriptChannel, &[f32])> {
        match self {
            Self::Split { me, others } => vec![
                (TranscriptChannel::Me, me.as_slice()),
                (TranscriptChannel::Others, others.as_slice()),
            ],
            Self::Mixed(mixed) => vec![(TranscriptChannel::Others, mixed.as_slice())],
        }
    }

    fn track_of(&self, channel: TranscriptChannel) -> Track {
        match (self, channel) {
            (Self::Mixed(_), _) => Track::Mixed,
            (Self::Split { .. }, TranscriptChannel::Me) => Track::Me,
            (Self::Split { .. }, TranscriptChannel::Others) => Track::Others,
        }
    }

    /// The longest track, ms.
    pub fn duration_ms(&self) -> i64 {
        let samples = self
            .channels()
            .iter()
            .map(|(_, samples)| samples.len())
            .max()
            .unwrap_or(0);
        i64::try_from(samples as u64 / SAMPLES_PER_MS).unwrap_or(i64::MAX)
    }
}

/// A recognized phrase.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Heard {
    pub id: String,
    pub track: Track,
    /// From the start of the recording.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Both passes and the glossary they ran with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcribed {
    /// In time order.
    pub live: Vec<Heard>,
    pub refined: Vec<Heard>,
    /// The full glossary of the recording, as the app builds it.
    pub glossary: String,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The passes' host: the in-memory database and the scratch folder; what
/// the app tells windows goes nowhere.
struct ImportHost {
    db: Mutex<Connection>,
    model: ModelId,
    /// whisper.cpp did not load the model: why.
    failed: Mutex<Option<String>>,
    live_finished: Notify,
    dir: PathBuf,
    vad_model: PathBuf,
}

impl ImportHost {
    fn failed(&self) -> Result<(), String> {
        match lock(&self.failed).as_ref() {
            Some(message) => Err(format!(
                "Модель распознавания {} не загрузилась: {message}",
                self.model.spec().name
            )),
            None => Ok(()),
        }
    }

    fn read<T>(&self, work: impl FnOnce(&Connection) -> CommandResult<T>) -> Result<T, String> {
        with_database(self, work).map_err(|error| error.to_string())
    }
}

impl SpeechHost for ImportHost {
    fn emit(&self, _event: TranscriptEvent) {}

    fn data_changed(&self, _event: DataChanged) {}

    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        work(&lock(&self.db))
    }

    fn selected_model(&self) -> (ModelId, bool) {
        (self.model, lock(&self.failed).is_none())
    }

    fn model_failed(&self, _model: ModelId, message: &str) {
        lock(&self.failed).get_or_insert_with(|| message.to_owned());
    }

    fn transcription_changed(&self, _recording_id: &str, _status: TranscriptionStatus) {}

    fn live_finished(&self, _recording_id: &str) {
        self.live_finished.notify_one();
    }

    fn refine_paused(&self) -> bool {
        false
    }

    fn data_dir(&self) -> Option<PathBuf> {
        Some(self.dir.clone())
    }

    fn vad_model(&self) -> PathBuf {
        self.vad_model.clone()
    }
}

/// Prints how far a pass is, every tenth.
struct Progress {
    what: &'static str,
    on: bool,
    tenth: u64,
}

impl Progress {
    fn new(what: &'static str, on: bool) -> Self {
        Self { what, on, tenth: 0 }
    }

    fn at(&mut self, done: u64, total: u64) {
        let tenth = done * 10 / total.max(1);
        if self.on && tenth > self.tenth {
            self.tenth = tenth;
            eprintln!("grill-eval: {}: {} %", self.what, tenth * 10);
        }
    }
}

/// Runs both passes over `tracks`. `skeleton` is the corpus being built:
/// its project, people and settings seed the database the passes run on.
/// `work_dir` gets the recording's files.
pub async fn transcribe(
    skeleton: &Corpus,
    tracks: &Tracks,
    speech: &Speech,
    work_dir: &Path,
    progress: bool,
) -> Result<Transcribed, String> {
    if !speech.vad_model.is_file() {
        return Err(format!(
            "Нет модели VAD {}: grill-eval запускается из исходников приложения",
            speech.vad_model.display()
        ));
    }
    let connection = storage::open_in_memory().map_err(|error| error.to_string())?;
    let recording_id = replay::seed(&connection, skeleton).map_err(|error| error.to_string())?;
    let host = Arc::new(ImportHost {
        db: Mutex::new(connection),
        model: speech.model,
        failed: Mutex::new(None),
        live_finished: Notify::new(),
        dir: work_dir.to_owned(),
        vad_model: speech.vad_model.clone(),
    });
    let as_host = || Arc::clone(&host) as Arc<dyn SpeechHost>;

    live_pass(&host, as_host(), &recording_id, tracks, speech, progress).await?;
    let ended_at = skeleton.recording.started_at + tracks.duration_ms();
    host.read(|connection| recordings::finish(connection, &recording_id, ended_at))?;
    refined_pass(&host, as_host(), &recording_id, tracks, speech, progress).await?;

    let heard = |pass: TranscriptPass| {
        host.read(|connection| transcript::of_pass(connection, &recording_id, pass))
            .map(|segments| {
                segments
                    .into_iter()
                    .map(|segment: TranscriptSegment| Heard {
                        id: segment.id,
                        track: tracks.track_of(segment.channel),
                        start_ms: segment.start_ms,
                        end_ms: segment.end_ms,
                        text: segment.text,
                    })
                    .collect::<Vec<_>>()
            })
    };
    let glossary = host.read(|connection| context::load(connection, &recording_id))?;
    Ok(Transcribed {
        live: in_time_order(heard(TranscriptPass::Live)?),
        refined: in_time_order(heard(TranscriptPass::Refined)?),
        glossary: glossary.glossary.full().to_owned(),
    })
}

fn in_time_order(mut heard: Vec<Heard>) -> Vec<Heard> {
    heard.sort_by(|a, b| (a.start_ms, a.end_ms, &a.id).cmp(&(b.start_ms, b.end_ms, &b.id)));
    heard
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| Err(error.to_string()))
}

/// The tracks through the recorder's VAD into the app's live pass.
async fn live_pass(
    host: &Arc<ImportHost>,
    speech_host: Arc<dyn SpeechHost>,
    recording_id: &str,
    tracks: &Tracks,
    speech: &Speech,
    progress: bool,
) -> Result<(), String> {
    let sink = TranscriptSink::new(speech_host, speech.recognizer.clone(), LIVE);
    sink.recording_started(recording_id);
    let channels: Vec<(TranscriptChannel, Vec<f32>)> = tracks
        .channels()
        .into_iter()
        .map(|(channel, samples)| (channel, samples.to_vec()))
        .collect();
    let fed = {
        let sink: Arc<dyn PhraseSink> = Arc::new(sink.clone());
        let recognizer = speech.recognizer.clone();
        let vad_model = speech.vad_model.clone();
        let recording_id = recording_id.to_owned();
        blocking(move || {
            feed(
                &sink,
                &recording_id,
                &channels,
                &vad_model,
                &recognizer,
                progress,
            )
        })
        .await
    };
    // The session ends either way; it reports once its last phrase is
    // answered.
    sink.recording_finished(recording_id);
    host.live_finished.notified().await;
    fed?;
    host.failed()
}

/// Pushes the channels through a VAD worker each, a second at a time and
/// in step, as the recorder does; waits whenever the VAD or the recognizer
/// falls behind.
fn feed(
    sink: &Arc<dyn PhraseSink>,
    recording_id: &str,
    channels: &[(TranscriptChannel, Vec<f32>)],
    vad_model: &Path,
    recognizer: &Recognizer,
    progress: bool,
) -> Result<(), String> {
    let workers: Vec<(VadWorker, &[f32])> = channels
        .iter()
        .map(|(channel, samples)| {
            let worker = VadWorker::spawn(vad_model, recording_id, *channel, Arc::clone(sink));
            (worker, samples.as_slice())
        })
        .collect();
    if workers
        .iter()
        .any(|(worker, _)| worker.status() != SegmentationStatus::Ok)
    {
        return Err(format!("Модель VAD {} не загрузилась", vad_model.display()));
    }
    let longest = channels
        .iter()
        .map(|(_, samples)| samples.len())
        .max()
        .unwrap_or(0);
    let mut report = Progress::new("живой проход", progress);
    let mut offset = 0;
    while offset < longest {
        let end = (offset + CHUNK_SAMPLES).min(longest);
        for (worker, samples) in &workers {
            if offset < samples.len() {
                worker.push(&samples[offset..end.min(samples.len())]);
            }
        }
        offset = end;
        while workers
            .iter()
            .any(|(worker, _)| worker.backlog_ms() > MAX_VAD_BACKLOG_MS)
            || recognizer.queued_samples(Priority::Live) > MAX_LIVE_QUEUE_SAMPLES
        {
            std::thread::sleep(Duration::from_millis(2));
        }
        report.at(offset as u64, longest as u64);
    }
    let mut failed = false;
    for (worker, _) in workers {
        failed |= worker.status() != SegmentationStatus::Ok;
        worker.finish();
    }
    if failed {
        return Err("Нарезка на фразы остановилась с ошибкой (подробности выше)".to_owned());
    }
    Ok(())
}

fn write_opus(path: &Path, samples: &[f32]) -> Result<(), String> {
    let failed = |error: std::io::Error| format!("Не удалось записать {}: {error}", path.display());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(failed)?;
    }
    let file = File::create(path).map_err(failed)?;
    let mut writer = OggOpusWriter::new(BufWriter::new(file)).map_err(failed)?;
    writer.write(samples).map_err(failed)?;
    writer.finish().map_err(failed)?;
    Ok(())
}

/// The tracks as the recording's files, through the app's second pass.
async fn refined_pass(
    host: &Arc<ImportHost>,
    speech_host: Arc<dyn SpeechHost>,
    recording_id: &str,
    tracks: &Tracks,
    speech: &Speech,
    progress: bool,
) -> Result<(), String> {
    let files = host
        .read(|connection| recordings::get(connection, recording_id))?
        .files;
    let silence = vec![0.0; CHUNK_SAMPLES];
    let (me, others) = match tracks {
        Tracks::Split { me, others } => (me.clone(), others.clone()),
        Tracks::Mixed(mixed) => (silence, mixed.clone()),
    };
    let dir = host.dir.clone();
    blocking(move || {
        write_opus(&dir.join(files.me), &me)?;
        write_opus(&dir.join(files.others), &others)
    })
    .await?;

    let refiner = Refiner::start(
        speech_host,
        speech.recognizer.clone(),
        RefinerConfig::default(),
    );
    let mut news = refiner.subscribe();
    refiner.enqueue(recording_id);
    let mut report = Progress::new("уточнённый проход", progress);
    loop {
        tokio::time::sleep(POLL).await;
        while let Ok(event) = news.try_recv() {
            report.at(u64::from(event.progress), 100);
        }
        host.failed()?;
        let state = host
            .read(|connection| recordings::get(connection, recording_id))?
            .transcript_state;
        match state {
            TranscriptState::Refined => return Ok(()),
            TranscriptState::Failed | TranscriptState::Skipped => {
                return Err("Второй проход не удался (подробности выше)".to_owned());
            }
            TranscriptState::Live | TranscriptState::Refining => {}
        }
    }
}
