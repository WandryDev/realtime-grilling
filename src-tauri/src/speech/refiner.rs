//! The second pass (speech-recognition design.md decision 12): after a
//! recording stops, its two files are segmented again in one VAD pass each
//! and every phrase is recognized with beam search and the full glossary.
//! The segments are stored at once as the refined pass.
//!
//! One background task works through a queue of recordings, the most
//! recent first: a call that just ended does not wait behind older ones. It
//! waits between phrases while a recording (or the hardware check) runs,
//! and it starts a recording over after a restart: nothing refined is kept
//! until the end. `recordings.transcript_state` says where each recording
//! is. Deleting a recording's audio stops its pass ([`Refiner::stop`]):
//! nothing refined is stored for it, the live transcript stays.
//!
//! One channel is in memory at a time (2 h of audio is ~460 MB of
//! samples); a phrase's samples are copied only when it goes to the
//! recognizer.

use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    ops::Range,
    sync::{Arc, Mutex, MutexGuard, PoisonError, Weak},
    time::{Duration, Instant},
};

use tokio::sync::{Notify, broadcast};

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
    /// At least one progress event this often while the pass runs, also
    /// while a long file decodes or a phrase waits for the recognizer: the
    /// windows tell a slow pass from a stalled one.
    pub heartbeat: Duration,
    /// How often a paused second pass looks again.
    pub pause_poll: Duration,
    /// Without a working model, how long until the queue is tried again.
    pub retry_after: Duration,
}

impl Default for RefinerConfig {
    fn default() -> Self {
        Self {
            progress_every: Duration::from_secs(1),
            heartbeat: Duration::from_secs(5),
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
    /// Recordings whose pass must stop: their audio is being deleted.
    stopped: Mutex<HashSet<String>>,
    wake: Arc<Notify>,
    /// Every `TranscriptRefine` the windows get, for the summary build
    /// waiting on the pass (post-call design.md, decision 2).
    news: broadcast::Sender<TranscriptRefine>,
}

/// How many events a slow listener of [`Refiner::subscribe`] may fall
/// behind before it misses some (it then reads the states again).
const NEWS_CAPACITY: usize = 64;

impl Inner {
    fn queue(&self) -> MutexGuard<'_, VecDeque<String>> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn stopped(&self) -> MutexGuard<'_, HashSet<String>> {
        self.stopped.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_stopped(&self, recording_id: &str) -> bool {
        self.stopped().contains(recording_id)
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
    /// unrefined (see [`Self::queue_unrefined`]).
    pub fn start(host: Arc<dyn SpeechHost>, recognizer: Recognizer, config: RefinerConfig) -> Self {
        let wake = Arc::new(Notify::new());
        let inner = Arc::new(Inner {
            host,
            recognizer,
            config,
            queue: Mutex::new(VecDeque::new()),
            stopped: Mutex::new(HashSet::new()),
            wake: Arc::clone(&wake),
            news: broadcast::channel(NEWS_CAPACITY).0,
        });
        tauri::async_runtime::spawn(run(Arc::downgrade(&inner), wake));
        Self(inner)
    }

    /// Queues a recording that just stopped, before every other one.
    pub fn enqueue(&self, recording_id: &str) {
        {
            let mut queue = self.0.queue();
            queue.retain(|queued| queued != recording_id);
            queue.push_front(recording_id.to_owned());
        }
        self.0.wake.notify_one();
    }

    /// The progress of the pass from now on, as the windows get it.
    pub fn subscribe(&self) -> broadcast::Receiver<TranscriptRefine> {
        self.0.news.subscribe()
    }

    /// The audio of a recording is being deleted (post-call design.md,
    /// decision 10): it leaves the queue, and a pass over it stops before
    /// its next phrase without storing anything (`failed`: the live
    /// transcript stays). The store also checks `audio_deleted_at` under
    /// the database lock, so a pass that ends meanwhile stores nothing.
    pub fn stop(&self, recording_id: &str) {
        self.0.stopped().insert(recording_id.to_owned());
        self.0.queue().retain(|queued| queued != recording_id);
    }

    /// Queues the stopped recordings whose second pass has not finished
    /// (`live` or `refining`), behind what is queued, the most recent first.
    /// At the start, and again once the storage opens late ("Повторить").
    pub async fn queue_unrefined(&self) {
        match database(&self.0.host, unrefined).await {
            Ok(ids) => {
                {
                    let mut queue = self.0.queue();
                    for id in ids.into_iter().rev() {
                        if !queue.contains(&id) {
                            queue.push_back(id);
                        }
                    }
                }
                self.0.wake.notify_one();
            }
            Err(error) => eprintln!("grill: unrefined recordings not read: {error}"),
        }
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
        Refiner(inner).queue_unrefined().await;
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
        let outcome = refine(&inner, &id).await;
        inner.stopped().remove(&id);
        if let Outcome::NoModel = outcome {
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

/// A stopped recording with its audio whose second pass has not finished
/// (`call-recording`: no second pass without the audio), and whose
/// transcript the retention period did not delete.
fn needs_refining(recording: &Recording) -> bool {
    recording.status != RecordingState::Recording
        && recording.audio_deleted_at.is_none()
        && recording.transcript_deleted_at.is_none()
        && matches!(
            recording.transcript_state,
            TranscriptState::Live | TranscriptState::Refining
        )
}

/// A phrase of a channel.
struct Phrase {
    start_ms: u64,
    end_ms: u64,
    /// Its samples in the channel's.
    samples: Range<usize>,
}

/// Cuts a channel into phrases, in time order.
fn segment(vad: &mut SileroVad, samples: &[f32]) -> Result<Vec<Phrase>, String> {
    let probabilities = vad
        .probabilities(samples)
        .map_err(|error| error.to_string())?
        .to_vec();
    let mut segmenter = Segmenter::new(SegmenterParams::default(), 0);
    let mut spans: Vec<_> = probabilities
        .into_iter()
        .filter_map(|probability| segmenter.push(probability))
        .collect();
    spans.extend(segmenter.finish(samples.len() as u64));
    Ok(spans
        .into_iter()
        .filter_map(|span| {
            let to = usize::try_from(span.end)
                .unwrap_or(usize::MAX)
                .min(samples.len());
            let from = usize::try_from(span.start).unwrap_or(to).min(to);
            (from < to).then(|| Phrase {
                start_ms: span.start_ms(),
                end_ms: span.end_ms(),
                samples: from..to,
            })
        })
        .collect())
}

/// Runs blocking work off the async workers.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .unwrap_or_else(|error| Err(error.to_string()))
}

/// The share of the pass done at `at_ms` of channel `index` (of two), in
/// seconds of audio; 100 only once stored.
fn share(index: u64, at_ms: u64, channel_ms: u64) -> u8 {
    let within = at_ms.min(channel_ms) * 100 / channel_ms.max(1);
    u8::try_from((index * 100 + within) / 2)
        .unwrap_or(100)
        .min(99)
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
        let event = TranscriptRefine {
            recording_id: self.recording_id.clone(),
            progress,
            state,
        };
        // Nobody listening is fine.
        let _ = self.inner.news.send(event.clone());
        self.inner.host.emit(TranscriptEvent::Refine(event));
    }

    fn quiet_for(&self, period: Duration) -> bool {
        self.reported_at.is_none_or(|at| at.elapsed() >= period)
    }

    /// Progress during the run: a new value at most every `progress_every`,
    /// the same one again after `heartbeat` without news.
    fn report(&mut self, progress: u8) {
        let config = self.inner.config;
        let changed = progress != self.progress && self.quiet_for(config.progress_every);
        if changed || self.quiet_for(config.heartbeat) {
            self.emit(progress, RefineState::Refining);
        }
    }

    /// A step is over (a channel decoded or segmented): news, unless some
    /// went out within `progress_every`.
    fn step_done(&mut self) {
        if self.quiet_for(self.inner.config.progress_every) {
            self.emit(self.progress, RefineState::Refining);
        }
    }

    /// Awaits `work`, with the progress again every `heartbeat` meanwhile.
    async fn alive<T>(&mut self, work: impl Future<Output = T>) -> T {
        let mut work = std::pin::pin!(work);
        loop {
            let since = self.reported_at.map_or(Duration::ZERO, |at| at.elapsed());
            let wait = self.inner.config.heartbeat.saturating_sub(since);
            tokio::select! {
                output = &mut work => return output,
                () = tokio::time::sleep(wait) => self.report(self.progress),
            }
        }
    }

    /// Waits while a recording or the hardware check runs.
    async fn wait_while_paused(&mut self) {
        while self.inner.host.refine_paused() {
            tokio::time::sleep(self.inner.config.pause_poll).await;
            self.report(self.progress);
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
    if !needs_refining(&recording) || inner.is_stopped(recording_id) {
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
    let host_vad_model = host.vad_model();

    let mut vad =
        match blocking(move || SileroVad::load(&host_vad_model).map_err(|error| error.to_string()))
            .await
        {
            Ok(vad) => vad,
            Err(error) => return run.fail(&error).await,
        };
    let mut languages = LanguageCache::new(language);
    let mut segments = Vec::new();
    let channels = [
        (TranscriptChannel::Me, recording.files.me),
        (TranscriptChannel::Others, recording.files.others),
    ];
    for (index, (channel, file)) in (0_u64..).zip(channels) {
        let path = dir.join(file);
        let decoded = run
            .alive(blocking(move || {
                ogg_opus::read_file(&path).map_err(|error| format!("{}: {error}", path.display()))
            }))
            .await;
        let samples = match decoded {
            Ok(samples) => Arc::new(samples),
            Err(error) => return run.fail(&error).await,
        };
        run.step_done();
        let (back, phrases) = {
            let samples = Arc::clone(&samples);
            match run
                .alive(blocking(move || {
                    let phrases = segment(&mut vad, &samples)?;
                    Ok((vad, phrases))
                }))
                .await
            {
                Ok(done) => done,
                Err(error) => return run.fail(&error).await,
            }
        };
        vad = back;
        run.step_done();

        let channel_ms = samples.len() as u64 * 1_000 / u64::from(crate::recording::SAMPLE_RATE);
        let mut recent: VecDeque<String> = VecDeque::new();
        for phrase in phrases {
            run.wait_while_paused().await;
            if inner.is_stopped(recording_id) {
                return run.fail("stopped: the audio was deleted").await;
            }
            let choice = languages.choice(channel, Instant::now());
            let reply = inner.recognizer.submit(Job {
                samples: samples[phrase.samples.clone()].to_vec(),
                language: choice,
                prompt: glossary.full().to_owned(),
                decode: Decode::Beam5,
                priority: Priority::Refine,
            });
            let answer = run.alive(reply).await;
            let transcript = match answer.unwrap_or(Err(RecognizerError::Stopped)) {
                Ok(transcript) => transcript,
                Err(RecognizerError::NoModel) => return Outcome::NoModel,
                Err(RecognizerError::ModelFailed(message)) => {
                    host.model_failed(host.selected_model().0, &message);
                    return Outcome::NoModel;
                }
                Err(error) => return run.fail(&error.to_string()).await,
            };
            if choice == LanguageChoice::Detect {
                languages.remember(channel, transcript.language, Instant::now());
            }
            let texts: Vec<&str> = recent.iter().map(String::as_str).collect();
            if let Some(text) = filters::filter(&transcript.segments, &glossary, &texts) {
                recent.push_back(text.clone());
                if recent.len() > 2 {
                    recent.pop_front();
                }
                segments.push(SegmentInput {
                    channel,
                    start_ms: i64::try_from(phrase.start_ms).unwrap_or(i64::MAX),
                    end_ms: i64::try_from(phrase.end_ms).unwrap_or(i64::MAX),
                    text,
                });
            }
            run.report(share(index, phrase.end_ms, channel_ms));
        }
        run.report(share(index + 1, 0, channel_ms));
    }

    let id = recording_id.to_owned();
    let stored = database(host, move |connection| {
        let recording = recordings::get(connection, &id)?;
        if recording.audio_deleted_at.is_some() || recording.transcript_deleted_at.is_some() {
            return Ok(None);
        }
        transcript::replace_refined(connection, &id, segments).map(Some)
    })
    .await;
    match stored {
        Ok(None) => run.fail("stopped: the audio was deleted").await,
        Ok(Some((_, events))) => {
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
