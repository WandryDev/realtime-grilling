//! The live pass (speech-recognition design.md decision 10): every phrase
//! the VAD cuts while recording is recognized and stored, the windows follow
//! it with events.
//!
//! [`TranscriptSink`] is the recorder's [`PhraseSink`]. It never waits: a
//! phrase goes into the channel of its recording's session, a task on the
//! async runtime. The session sends `TranscriptPending`, queues a live job,
//! and answers the replies in order (the recognizer serves live jobs first
//! in, first out): `TranscriptPhrase` with the stored segment, or
//! `TranscriptDropped` when the filters left nothing. It watches the audio
//! waiting in its queue: over 10 s the windows get `TranscriptLag` every
//! 5 s, over 60 s the oldest waiting phrases are taken off the queue
//! (`TranscriptSkipped`), and the second pass fills them in.

use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex, MutexGuard, PoisonError},
    time::{Duration, Instant},
};

use tokio::sync::mpsc;

use super::{
    context::{self, RecordingContext},
    events::{
        TranscriptDropped, TranscriptEvent, TranscriptLag, TranscriptPending, TranscriptPhrase,
        TranscriptSkipped,
    },
    filters,
    host::{SpeechHost, database},
    language::{LanguageCache, LanguageChoice},
    models::ModelId,
    recognizer::{Decode, Job, Priority, Recognizer, RecognizerError, Reply, Transcript},
    status::{TranscriptionState, TranscriptionStatus},
};
use crate::{
    storage::transcript::{self, SegmentInput, TranscriptChannel, TranscriptPass},
    vad::{
        SAMPLE_RATE,
        worker::{Phrase, PhraseSink},
    },
};

/// When the live pass reports and gives up.
#[derive(Debug, Clone, Copy)]
pub struct LiveConfig {
    /// More queued audio than this is a lag the windows hear about.
    pub lag_after: Duration,
    /// More queued audio than this: the oldest waiting phrases are skipped.
    pub skip_after: Duration,
    /// How often a lag is repeated (and checked without new phrases).
    pub lag_every: Duration,
}

impl Default for LiveConfig {
    fn default() -> Self {
        Self {
            lag_after: Duration::from_secs(10),
            skip_after: Duration::from_secs(60),
            lag_every: Duration::from_secs(5),
        }
    }
}

enum Message {
    Phrase(Phrase),
    /// The recording stopped and its last phrase came.
    Finish,
}

struct Inner {
    host: Arc<dyn SpeechHost>,
    recognizer: Recognizer,
    config: LiveConfig,
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
}

impl Inner {
    fn sessions(&self) -> MutexGuard<'_, HashMap<String, mpsc::UnboundedSender<Message>>> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The recorder's phrase sink in the app. Cheap to clone.
#[derive(Clone)]
pub struct TranscriptSink(Arc<Inner>);

impl TranscriptSink {
    pub fn new(host: Arc<dyn SpeechHost>, recognizer: Recognizer, config: LiveConfig) -> Self {
        Self(Arc::new(Inner {
            host,
            recognizer,
            config,
            sessions: Mutex::new(HashMap::new()),
        }))
    }

    /// The status a recording starts with: `noModel` without an installed
    /// model.
    fn initial_status(&self) -> TranscriptionStatus {
        let (model, ready) = self.0.host.selected_model();
        let state = if ready {
            TranscriptionState::Ok
        } else {
            TranscriptionState::NoModel
        };
        TranscriptionStatus::new(state, Some(model))
    }

    /// The channel of the recording's session, started if it isn't yet.
    fn session(
        &self,
        recording_id: &str,
        status: TranscriptionStatus,
    ) -> mpsc::UnboundedSender<Message> {
        let mut sessions = self.0.sessions();
        if let Some(sender) = sessions.get(recording_id) {
            return sender.clone();
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        sessions.insert(recording_id.to_owned(), sender.clone());
        drop(sessions);
        let session = Session {
            recording_id: recording_id.to_owned(),
            host: Arc::clone(&self.0.host),
            recognizer: self.0.recognizer.clone(),
            config: self.0.config,
            context: RecordingContext::default(),
            languages: LanguageCache::new(Default::default()),
            status,
            queue: VecDeque::new(),
            recent: [VecDeque::new(), VecDeque::new()],
            lag_reported_at: None,
        };
        tauri::async_runtime::spawn(session.run(receiver));
        sender
    }
}

impl PhraseSink for TranscriptSink {
    fn phrase(&self, phrase: Phrase) {
        let sender = self.session(&phrase.recording_id, TranscriptionStatus::idle());
        // A send fails only when the session ended: the phrase came after
        // `recording_finished`, nothing waits for it.
        let _ = sender.send(Message::Phrase(phrase));
    }

    fn recording_started(&self, recording_id: &str) -> TranscriptionStatus {
        let status = self.initial_status();
        self.session(recording_id, status);
        status
    }

    fn recording_finished(&self, recording_id: &str) {
        let sender = self.0.sessions().remove(recording_id);
        match sender {
            Some(sender) if sender.send(Message::Finish).is_ok() => {}
            _ => self.0.host.live_finished(recording_id),
        }
    }
}

/// A phrase waiting for its reply.
struct Queued {
    channel: TranscriptChannel,
    start_ms: u64,
    end_ms: u64,
    samples: usize,
    /// The job detects the language: its answer is remembered.
    detects: bool,
    model: ModelId,
    reply: Reply,
}

/// The live pass of one recording.
struct Session {
    recording_id: String,
    host: Arc<dyn SpeechHost>,
    recognizer: Recognizer,
    config: LiveConfig,
    context: RecordingContext,
    languages: LanguageCache,
    status: TranscriptionStatus,
    /// Phrases sent to the recognizer, oldest first; the first may be
    /// running.
    queue: VecDeque<Queued>,
    /// The last two texts of `me` and `others`: the glossary filter's
    /// neighbours.
    recent: [VecDeque<String>; 2],
    /// When a lag was last sent; `None` while there is none.
    lag_reported_at: Option<Instant>,
}

/// The reply of the oldest queued phrase.
async fn first_reply(queue: &mut VecDeque<Queued>) -> Result<Transcript, RecognizerError> {
    match queue.front_mut() {
        Some(queued) => (&mut queued.reply)
            .await
            .unwrap_or(Err(RecognizerError::Stopped)),
        None => std::future::pending().await,
    }
}

fn slot(channel: TranscriptChannel) -> usize {
    match channel {
        TranscriptChannel::Me => 0,
        TranscriptChannel::Others => 1,
    }
}

fn samples_in(duration: Duration) -> usize {
    (duration.as_secs_f64() * f64::from(SAMPLE_RATE)) as usize
}

impl Session {
    async fn run(mut self, mut messages: mpsc::UnboundedReceiver<Message>) {
        let id = self.recording_id.clone();
        match database(&self.host, move |connection| context::load(connection, &id)).await {
            Ok(context) => self.context = context,
            Err(error) => eprintln!(
                "grill: the live transcript of {} runs without a glossary: {error}",
                self.recording_id
            ),
        }
        self.languages = LanguageCache::new(self.context.language);

        let mut ticker = tokio::time::interval(self.config.lag_every);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut finishing = false;
        while !(finishing && self.queue.is_empty()) {
            tokio::select! {
                message = messages.recv(), if !finishing => match message {
                    Some(Message::Phrase(phrase)) => self.submit(phrase),
                    Some(Message::Finish) | None => finishing = true,
                },
                reply = first_reply(&mut self.queue), if !self.queue.is_empty() => {
                    if let Some(queued) = self.queue.pop_front() {
                        self.answer(queued, reply).await;
                    }
                }
                _ = ticker.tick() => {}
            }
            self.check_lag();
        }
        self.host.live_finished(&self.recording_id);
    }

    fn set_status(&mut self, state: TranscriptionState, model: ModelId) {
        let status = TranscriptionStatus::new(state, Some(model));
        if status != self.status {
            self.status = status;
            self.host
                .transcription_changed(&self.recording_id, self.status);
        }
    }

    fn emit(&self, event: TranscriptEvent) {
        self.host.emit(event);
    }

    /// Queues a live job for the phrase. Without a model the phrase is
    /// left out silently: the status says why.
    fn submit(&mut self, phrase: Phrase) {
        let (model, ready) = self.host.selected_model();
        if !ready {
            // A model that failed to load stays `modelFailed` (the manager
            // marked it `error`) until it is installed again.
            if self.status.state != TranscriptionState::ModelFailed {
                self.set_status(TranscriptionState::NoModel, model);
            }
            return;
        }
        self.set_status(TranscriptionState::Ok, model);

        self.emit(TranscriptEvent::Pending(TranscriptPending {
            recording_id: self.recording_id.clone(),
            channel: phrase.channel,
            start_ms: phrase.start_ms,
        }));
        let language = self.languages.choice(phrase.channel, Instant::now());
        let samples = phrase.samples.len();
        let reply = self.recognizer.submit(Job {
            samples: phrase.samples,
            language,
            prompt: self.context.glossary.live().to_owned(),
            decode: Decode::Greedy,
            priority: Priority::Live,
        });
        self.queue.push_back(Queued {
            channel: phrase.channel,
            start_ms: phrase.start_ms,
            end_ms: phrase.end_ms,
            samples,
            detects: language == LanguageChoice::Detect,
            model,
            reply,
        });
    }

    fn drop_phrase(&self, queued: &Queued) {
        self.emit(TranscriptEvent::Dropped(TranscriptDropped {
            recording_id: self.recording_id.clone(),
            channel: queued.channel,
            start_ms: queued.start_ms,
        }));
    }

    async fn answer(&mut self, queued: Queued, reply: Result<Transcript, RecognizerError>) {
        let transcript = match reply {
            Ok(transcript) => transcript,
            Err(error) => {
                match &error {
                    RecognizerError::NoModel => {
                        self.set_status(TranscriptionState::NoModel, queued.model);
                    }
                    RecognizerError::ModelFailed(message) => {
                        self.set_status(TranscriptionState::ModelFailed, queued.model);
                        self.host.model_failed(queued.model, message);
                    }
                    RecognizerError::Inference(_) | RecognizerError::Stopped => {
                        eprintln!(
                            "grill: phrase {} ms of {} not recognized: {error}",
                            queued.start_ms, self.recording_id
                        );
                    }
                }
                self.drop_phrase(&queued);
                return;
            }
        };
        if queued.detects {
            self.languages
                .remember(queued.channel, transcript.language, Instant::now());
        }
        let recent = &self.recent[slot(queued.channel)];
        let neighbours: Vec<&str> = recent.iter().map(String::as_str).collect();
        let Some(text) = filters::filter(&transcript.segments, &self.context.glossary, &neighbours)
        else {
            if cfg!(debug_assertions) {
                eprintln!(
                    "grill: phrase {} ms of {} dropped by the filters",
                    queued.start_ms, self.recording_id
                );
            }
            self.drop_phrase(&queued);
            return;
        };

        let segment = SegmentInput {
            channel: queued.channel,
            start_ms: i64::try_from(queued.start_ms).unwrap_or(i64::MAX),
            end_ms: i64::try_from(queued.end_ms).unwrap_or(i64::MAX),
            text: text.clone(),
        };
        let id = self.recording_id.clone();
        let stored = database(&self.host, move |connection| {
            transcript::append_live(connection, &id, segment)
        })
        .await;
        match stored {
            Ok((segment, events)) => {
                self.emit(TranscriptEvent::Phrase(TranscriptPhrase {
                    recording_id: self.recording_id.clone(),
                    id: segment.id,
                    channel: queued.channel,
                    start_ms: queued.start_ms,
                    end_ms: queued.end_ms,
                    text: text.clone(),
                    pass: TranscriptPass::Live,
                }));
                for event in events {
                    self.host.data_changed(event);
                }
                let recent = &mut self.recent[slot(queued.channel)];
                recent.push_back(text);
                if recent.len() > 2 {
                    recent.pop_front();
                }
            }
            Err(error) => {
                eprintln!(
                    "grill: phrase {} ms of {} not stored: {error}",
                    queued.start_ms, self.recording_id
                );
                self.drop_phrase(&queued);
            }
        }
    }

    fn queued_samples(&self) -> usize {
        self.queue.iter().map(|queued| queued.samples).sum()
    }

    /// Skips the oldest waiting phrases past `skip_after` (never the first,
    /// which may be running) and reports the lag.
    fn check_lag(&mut self) {
        let skip_after = samples_in(self.config.skip_after);
        while self.queue.len() > 1 && self.queued_samples() > skip_after {
            // Dropping the reply takes the job off the recognizer's queue.
            if let Some(skipped) = self.queue.remove(1) {
                self.emit(TranscriptEvent::Skipped(TranscriptSkipped {
                    recording_id: self.recording_id.clone(),
                    channel: skipped.channel,
                    start_ms: skipped.start_ms,
                    end_ms: skipped.end_ms,
                }));
            }
        }

        let queued = self.queued_samples();
        let now = Instant::now();
        if queued > samples_in(self.config.lag_after) {
            let due = self
                .lag_reported_at
                .is_none_or(|at| now.duration_since(at) >= self.config.lag_every);
            if due {
                self.lag_reported_at = Some(now);
                let seconds = (queued as f64 / f64::from(SAMPLE_RATE)).round() as u32;
                self.emit(TranscriptEvent::Lag(TranscriptLag {
                    recording_id: self.recording_id.clone(),
                    seconds,
                }));
            }
        } else if self.lag_reported_at.take().is_some() {
            self.emit(TranscriptEvent::Lag(TranscriptLag {
                recording_id: self.recording_id.clone(),
                seconds: 0,
            }));
        }
    }
}

#[cfg(test)]
pub(crate) mod tests;
