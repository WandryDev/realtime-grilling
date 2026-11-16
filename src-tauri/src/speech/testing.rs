//! Fakes for the speech tests: a host that keeps what it was told, an
//! in-memory database, and a recognizer over a scripted engine.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use rusqlite::Connection;

use super::{
    events::TranscriptEvent,
    host::{DbWork, SpeechHost},
    models::ModelId,
    recognizer::{Engine, IDLE_UNLOAD, Loader, Params, Recognizer, RecognizerError, Segment},
    status::TranscriptionStatus,
};
use crate::{
    error::CommandResult,
    events::DataChanged,
    storage::{
        open_in_memory,
        recordings::{self, RecordingFiles, RecordingLinks},
    },
};

pub struct FakeHost {
    pub events: Mutex<Vec<TranscriptEvent>>,
    pub data: Mutex<Vec<DataChanged>>,
    pub db: Mutex<Connection>,
    pub model: Mutex<(ModelId, bool)>,
    pub failed_models: Mutex<Vec<ModelId>>,
    pub statuses: Mutex<Vec<(String, TranscriptionStatus)>>,
    pub finished: Mutex<Vec<String>>,
    pub paused: AtomicBool,
    /// The storage is not open: every `database` fails.
    pub db_down: AtomicBool,
    pub dir: Option<PathBuf>,
}

impl FakeHost {
    pub fn new(dir: Option<&Path>) -> Arc<Self> {
        Arc::new(Self {
            events: Mutex::default(),
            data: Mutex::default(),
            db: Mutex::new(open_in_memory().expect("in-memory database")),
            model: Mutex::new((ModelId::Turbo, true)),
            failed_models: Mutex::default(),
            statuses: Mutex::default(),
            finished: Mutex::default(),
            paused: AtomicBool::new(false),
            db_down: AtomicBool::new(false),
            dir: dir.map(Path::to_path_buf),
        })
    }

    pub fn as_host(self: &Arc<Self>) -> Arc<dyn SpeechHost> {
        Arc::clone(self) as Arc<dyn SpeechHost>
    }

    pub fn events(&self) -> Vec<TranscriptEvent> {
        self.events.lock().unwrap().clone()
    }

    pub fn statuses(&self) -> Vec<TranscriptionStatus> {
        self.statuses
            .lock()
            .unwrap()
            .iter()
            .map(|(_, status)| *status)
            .collect()
    }

    pub fn db<T>(&self, work: impl FnOnce(&Connection) -> T) -> T {
        work(&self.db.lock().unwrap())
    }

    /// A finished recording without a project, files under `recordings/`.
    pub fn recording(&self) -> String {
        self.db(|connection| {
            let id = recordings::create(connection, &RecordingLinks::default(), 1_000, |id| {
                RecordingFiles {
                    me: format!("recordings/{id}/me.opus"),
                    others: format!("recordings/{id}/others.opus"),
                }
            })
            .unwrap();
            recordings::finish(connection, &id, 60_000).unwrap();
            id
        })
    }
}

impl SpeechHost for FakeHost {
    fn emit(&self, event: TranscriptEvent) {
        self.events.lock().unwrap().push(event);
    }

    fn data_changed(&self, event: DataChanged) {
        self.data.lock().unwrap().push(event);
    }

    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        if self.db_down.load(Ordering::SeqCst) {
            return Err(crate::error::CommandError::storage(
                "Хранилище ещё не открыто",
            ));
        }
        work(&self.db.lock().unwrap())
    }

    fn selected_model(&self) -> (ModelId, bool) {
        *self.model.lock().unwrap()
    }

    fn model_failed(&self, model: ModelId, _message: &str) {
        self.failed_models.lock().unwrap().push(model);
        self.model.lock().unwrap().1 = false;
    }

    fn transcription_changed(&self, recording_id: &str, status: TranscriptionStatus) {
        self.statuses
            .lock()
            .unwrap()
            .push((recording_id.to_owned(), status));
    }

    fn live_finished(&self, recording_id: &str) {
        self.finished.lock().unwrap().push(recording_id.to_owned());
    }

    fn refine_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn data_dir(&self) -> Option<PathBuf> {
        self.dir.clone()
    }

    fn vad_model(&self) -> PathBuf {
        crate::vad::dev_model_path()
    }
}

type Answer = dyn Fn(&[f32], &Params) -> Result<Vec<Segment>, RecognizerError> + Send + Sync;

/// What the fake engine does.
pub struct Script {
    /// Transcriptions wait while it is set.
    pub hold: AtomicBool,
    /// Each transcription takes this long.
    pub delay: Mutex<Duration>,
    pub calls: AtomicUsize,
    /// The prompts the engine got.
    pub prompts: Mutex<Vec<String>>,
    answer: Box<Answer>,
}

impl Script {
    pub fn new(
        answer: impl Fn(&[f32], &Params) -> Result<Vec<Segment>, RecognizerError>
        + Send
        + Sync
        + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            hold: AtomicBool::new(false),
            delay: Mutex::new(Duration::ZERO),
            calls: AtomicUsize::new(0),
            prompts: Mutex::default(),
            answer: Box::new(answer),
        })
    }

    /// Answers every phrase with `text`, confidently.
    pub fn saying(text: &str) -> Arc<Self> {
        let text = text.to_owned();
        Self::new(move |_, _| Ok(vec![segment(&text)]))
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// A recognizer whose model loads into this script.
    pub fn recognizer(self: &Arc<Self>) -> Recognizer {
        let script = Arc::clone(self);
        let loader: Loader =
            Box::new(move |_| Ok(Box::new(FakeEngine(Arc::clone(&script))) as Box<dyn Engine>));
        Recognizer::new(loader, Some("fake.bin".into()), IDLE_UNLOAD)
    }
}

/// A segment the filters keep.
pub fn segment(text: &str) -> Segment {
    Segment {
        text: text.to_owned(),
        no_speech_prob: 0.01,
        avg_logprob: -0.2,
    }
}

struct FakeEngine(Arc<Script>);

impl Engine for FakeEngine {
    fn transcribe(
        &mut self,
        samples: &[f32],
        params: &Params,
    ) -> Result<Vec<Segment>, RecognizerError> {
        while self.0.hold.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        let delay = *self.0.delay.lock().unwrap();
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        self.0.calls.fetch_add(1, Ordering::SeqCst);
        self.0.prompts.lock().unwrap().push(params.prompt.clone());
        (self.0.answer)(samples, params)
    }

    fn detect_language(&mut self, _samples: &[f32]) -> Result<Vec<(String, f32)>, RecognizerError> {
        Ok(vec![("ru".into(), 0.6), ("uk".into(), 0.4)])
    }
}

/// A recognizer whose model never loads.
pub fn broken_recognizer() -> Recognizer {
    let loader: Loader =
        Box::new(|path| Err(RecognizerError::ModelFailed(path.display().to_string())));
    Recognizer::new(loader, Some("broken.bin".into()), IDLE_UNLOAD)
}

/// Polls until `condition` holds (the work runs on other threads).
pub fn eventually(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}
