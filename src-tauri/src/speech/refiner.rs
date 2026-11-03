//! The second pass (speech-recognition design.md decision 12): after a
//! recording stops, its two files are segmented again in one VAD pass each
//! and every phrase is recognized with beam search and the full glossary.
//! The segments are stored at once as the refined pass.
//!
//! One background task works through a queue of recordings. It waits
//! between phrases while a recording (or the hardware check) runs, and it
//! starts a recording over after a restart: nothing refined is kept until
//! the end. `recordings.transcript_state` says where each recording is.

use std::{
    collections::VecDeque,
    path::Path,
    sync::{Arc, Mutex, MutexGuard, PoisonError, Weak},
    time::{Duration, Instant},
};

use tokio::sync::Notify;

use super::{
    context::{self, RecordingContext},
    events::{RefineState, TranscriptEvent, TranscriptRefine},
    filters,
    host::{SpeechHost, database},
    language::{LanguageCache, LanguageChoice},
    recognizer::{Decode, Job, Priority, Recognizer, RecognizerError},
};
use crate::{
    error::{CommandError, CommandResult},
    recording::ogg_opus,
    storage::{
        recordings::{self, Recording, RecordingState, TranscriptState},
        transcript::{self, SegmentInput, TranscriptChannel},
    },
    vad::{
        detector::SileroVad,
        segmenter::{Segmenter, SegmenterParams},
    },
};

#[derive(Debug, Clone, Copy)]
pub struct RefinerConfig {
    /// At most one progress event this often.
    pub progress_every: Duration,
    /// How often a paused second pass looks again.
    pub pause_poll: Duration,
    /// Without a working model, how long until the queue is tried again.
    pub retry_after: Duration,
}

impl Default for RefinerConfig {
    fn default() -> Self {
        Self {
            progress_every: Duration::from_secs(1),
            pause_poll: Duration::from_millis(500),
            retry_after: Duration::from_secs(30),
        }
    }
}

struct Inner {
    host: Arc<dyn SpeechHost>,
    recognizer: Recognizer,
    config: RefinerConfig,
    queue: Mutex<VecDeque<String>>,
    wake: Arc<Notify>,
}

impl Inner {
    fn queue(&self) -> MutexGuard<'_, VecDeque<String>> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Drop for Inner {
    /// Lets the task see the last handle went.
    fn drop(&mut self) {
        self.wake.notify_one();
    }
}

/// The second pass of the app, in the Tauri state. Cheap to clone; the task
/// stops when the last handle goes.
#[derive(Clone)]
pub struct Refiner(Arc<Inner>);

impl Refiner {
    /// Starts the task. It first queues the recordings a previous run left
    /// unrefined (stopped, `live` or `refining`, with files).
    pub fn start(host: Arc<dyn SpeechHost>, recognizer: Recognizer, config: RefinerConfig) -> Self {
        let wake = Arc::new(Notify::new());
        let inner = Arc::new(Inner {
            host,
            recognizer,
            config,
            queue: Mutex::new(VecDeque::new()),
            wake: Arc::clone(&wake),
        });
        tauri::async_runtime::spawn(run(Arc::downgrade(&inner), wake));
        Self(inner)
    }

    /// Queues a stopped recording (once).
    pub fn enqueue(&self, recording_id: &str) {
        {
            let mut queue = self.0.queue();
            if queue.iter().any(|queued| queued == recording_id) {
                return;
            }
            queue.push_back(recording_id.to_owned());
        }
        self.0.wake.notify_one();
    }
}

/// What one run over a recording ended with.
enum Outcome {
    Done,
    /// No model to run with: the recording waits in the queue.
    NoModel,
    /// Failed, or nothing to do (deleted, already refined, still recording).
    Over,
}

async fn run(inner: Weak<Inner>, wake: Arc<Notify>) {
    if let Some(inner) = inner.upgrade() {
        match database(&inner.host, unrefined).await {
            Ok(ids) => {
                for id in ids {
                    Refiner(Arc::clone(&inner)).enqueue(&id);
                }
            }
            Err(error) => eprintln!("grill: unrefined recordings not read: {error}"),
        }
    }
    loop {
        let Some(inner) = inner.upgrade() else {
            return;
        };
        let next = inner.queue().pop_front();
        let Some(id) = next else {
            drop(inner);
            wake.notified().await;
            continue;
        };
        if let Outcome::NoModel = refine(&inner, &id).await {
            inner.queue().push_back(id);
            let retry_after = inner.config.retry_after;
            drop(inner);
            // A new recording queued meanwhile does not hurry the retry:
            // without a model it would wait too.
            tokio::time::sleep(retry_after).await;
        }
    }
}

/// Stopped recordings whose second pass has not finished, oldest first.
fn unrefined(connection: &rusqlite::Connection) -> CommandResult<Vec<String>> {
    let mut ids = Vec::new();
    for id in recordings::list_ids(connection)? {
        let recording = recordings::get(connection, &id)?;
        if needs_refining(&recording) {
            ids.push(id);
        }
    }
    Ok(ids)
}

fn needs_refining(recording: &Recording) -> bool {
    recording.status != RecordingState::Recording
        && matches!(
            recording.transcript_state,
            TranscriptState::Live | TranscriptState::Refining
        )
}

/// A phrase of the files.
struct Piece {
    channel: TranscriptChannel,
    start_ms: u64,
    end_ms: u64,
    samples: Vec<f32>,
}

/// Decodes both files and cuts them into phrases, in time order.
fn split(me: &Path, others: &Path, vad_model: &Path) -> Result<Vec<Piece>, String> {
    let mut vad = SileroVad::load(vad_model).map_err(|error| error.to_string())?;
    let mut pieces = Vec::new();
    for (channel, path) in [
        (TranscriptChannel::Me, me),
        (TranscriptChannel::Others, others),
    ] {
        let samples =
            ogg_opus::read_file(path).map_err(|error| format!("{}: {error}", path.display()))?;
        let probabilities = vad
            .probabilities(&samples)
            .map_err(|error| error.to_string())?
            .to_vec();
        let mut segmenter = Segmenter::new(SegmenterParams::default(), 0);
        let mut spans: Vec<_> = probabilities
            .into_iter()
            .filter_map(|probability| segmenter.push(probability))
            .collect();
        spans.extend(segmenter.finish(samples.len() as u64));
        for span in spans {
            let to = usize::try_from(span.end)
                .unwrap_or(usize::MAX)
                .min(samples.len());
            let from = usize::try_from(span.start).unwrap_or(to).min(to);
            if from == to {
                continue;
            }
            pieces.push(Piece {
                channel,
                start_ms: span.start_ms(),
                end_ms: span.end_ms(),
                samples: samples[from..to].to_vec(),
            });
        }
    }
    pieces.sort_by_key(|piece| (piece.start_ms, piece.channel == TranscriptChannel::Others));
    Ok(pieces)
}

fn slot(channel: TranscriptChannel) -> usize {
    match channel {
        TranscriptChannel::Me => 0,
        TranscriptChannel::Others => 1,
    }
}

/// One run over a recording.
struct Run<'a> {
    inner: &'a Inner,
    recording_id: String,
    progress: u8,
    reported_at: Option<Instant>,
}

impl Run<'_> {
    fn emit(&mut self, progress: u8, state: RefineState) {
        self.progress = progress;
        self.reported_at = Some(Instant::now());
        self.inner
            .host
            .emit(TranscriptEvent::Refine(TranscriptRefine {
                recording_id: self.recording_id.clone(),
                progress,
                state,
            }));
    }

    /// Progress during the run, at most every `progress_every`.
    fn report(&mut self, progress: u8) {
        let due = self
            .reported_at
            .is_none_or(|at| at.elapsed() >= self.inner.config.progress_every);
        if due && progress != self.progress {
            self.emit(progress, RefineState::Refining);
        }
    }

    async fn set_state(&self, state: TranscriptState) -> CommandResult<()> {
        let id = self.recording_id.clone();
        database(&self.inner.host, move |connection| {
            recordings::set_transcript_state(connection, &id, state)
        })
        .await
    }

    /// The live transcript stays; the recording is `failed`.
    async fn fail(&mut self, why: &str) -> Outcome {
        eprintln!(
            "grill: the second pass of {} failed: {why}",
            self.recording_id
        );
        match self.set_state(TranscriptState::Failed).await {
            Ok(()) => self.emit(self.progress, RefineState::Failed),
            // Deleted meanwhile: nobody waits for it.
            Err(CommandError::NotFound { .. }) => {}
            Err(error) => eprintln!("grill: {} not marked failed: {error}", self.recording_id),
        }
        Outcome::Over
    }
}

async fn refine(inner: &Inner, recording_id: &str) -> Outcome {
    let host = &inner.host;
    let id = recording_id.to_owned();
    let loaded = database(host, move |connection| {
        Ok((
            recordings::get(connection, &id)?,
            context::load(connection, &id)?,
        ))
    })
    .await;
    let (recording, RecordingContext { glossary, language }) = match loaded {
        Ok(loaded) => loaded,
        Err(CommandError::NotFound { .. }) => return Outcome::Over,
        Err(error) => {
            eprintln!("grill: recording {recording_id} not read for the second pass: {error}");
            return Outcome::Over;
        }
    };
    if !needs_refining(&recording) {
        return Outcome::Over;
    }
    if !host.selected_model().1 {
        return Outcome::NoModel;
    }

    let mut run = Run {
        inner,
        recording_id: recording_id.to_owned(),
        progress: 0,
        reported_at: None,
    };
    let Some(dir) = host.data_dir() else {
        return run.fail("no data folder").await;
    };
    // Decoding and segmenting a long recording is work too: not while
    // another one records.
    while host.refine_paused() {
        tokio::time::sleep(inner.config.pause_poll).await;
    }
    if let Err(error) = run.set_state(TranscriptState::Refining).await {
        return run.fail(&error.to_string()).await;
    }
    run.emit(0, RefineState::Refining);

    let (me, others, vad_model) = (
        dir.join(&recording.files.me),
        dir.join(&recording.files.others),
        host.vad_model(),
    );
    let pieces =
        match tauri::async_runtime::spawn_blocking(move || split(&me, &others, &vad_model)).await {
            Ok(Ok(pieces)) => pieces,
            Ok(Err(error)) => return run.fail(&error).await,
            Err(error) => return run.fail(&error.to_string()).await,
        };

    let total_ms: u64 = pieces
        .iter()
        .map(|piece| piece.end_ms - piece.start_ms)
        .sum();
    let mut done_ms = 0;
    let mut languages = LanguageCache::new(language);
    let mut recent: [VecDeque<String>; 2] = [VecDeque::new(), VecDeque::new()];
    let mut segments = Vec::new();
    for piece in pieces {
        while host.refine_paused() {
            tokio::time::sleep(inner.config.pause_poll).await;
        }
        let choice = languages.choice(piece.channel, Instant::now());
        let reply = inner.recognizer.submit(Job {
            samples: piece.samples,
            language: choice,
            prompt: glossary.full().to_owned(),
            decode: Decode::Beam5,
            priority: Priority::Refine,
        });
        let transcript = match reply.await.unwrap_or(Err(RecognizerError::Stopped)) {
            Ok(transcript) => transcript,
            Err(RecognizerError::NoModel) => return Outcome::NoModel,
            Err(RecognizerError::ModelFailed(message)) => {
                host.model_failed(host.selected_model().0, &message);
                return Outcome::NoModel;
            }
            Err(error) => return run.fail(&error.to_string()).await,
        };
        if choice == LanguageChoice::Detect {
            languages.remember(piece.channel, transcript.language, Instant::now());
        }
        let neighbours = &mut recent[slot(piece.channel)];
        let texts: Vec<&str> = neighbours.iter().map(String::as_str).collect();
        if let Some(text) = filters::filter(&transcript.segments, &glossary, &texts) {
            neighbours.push_back(text.clone());
            if neighbours.len() > 2 {
                neighbours.pop_front();
            }
            segments.push(SegmentInput {
                channel: piece.channel,
                start_ms: i64::try_from(piece.start_ms).unwrap_or(i64::MAX),
                end_ms: i64::try_from(piece.end_ms).unwrap_or(i64::MAX),
                text,
            });
        }
        done_ms += piece.end_ms - piece.start_ms;
        let progress = u8::try_from(done_ms * 100 / total_ms.max(1)).unwrap_or(100);
        // 100 only once stored.
        run.report(progress.min(99));
    }

    let id = recording_id.to_owned();
    let stored = database(host, move |connection| {
        transcript::replace_refined(connection, &id, segments)
    })
    .await;
    match stored {
        Ok((_, events)) => {
            for event in events {
                host.data_changed(event);
            }
            run.emit(100, RefineState::Done);
            Outcome::Done
        }
        Err(CommandError::NotFound { .. }) => Outcome::Over,
        Err(error) => run.fail(&error.to_string()).await,
    }
}

#[cfg(test)]
mod tests;
