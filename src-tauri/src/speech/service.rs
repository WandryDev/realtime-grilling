//! Speech recognition in the app: the one [`Recognizer`] (Tauri state
//! [`Speech`]), which model it runs, the hardware check in progress, and
//! the host the live pass and the second pass report through.

use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::watch;

use super::{
    events::TranscriptEvent,
    host::{DbWork, SpeechHost},
    models::{ErrorReason, ModelId, ModelManager},
    recognizer::Recognizer,
    refiner::Refiner,
    status::TranscriptionStatus,
};
use crate::{
    agent::fast_loop::scheduler::FastLoop,
    error::{CommandError, CommandResult},
    events::{DataChanged, EventSink},
    recording::RecordingManager,
    storage::{Storage, transcript::TranscriptPass},
};

/// How long removing a model waits for the recognizer to let go of it.
const UNLOAD_WAIT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Models {
    /// The selected model's file when it is installed.
    selected: Option<PathBuf>,
    /// The model of the hardware check while it runs; wins over `selected`
    /// until a recording interrupts the check.
    checking: Option<PathBuf>,
    /// What the recognizer was last told.
    applied: Option<Option<PathBuf>>,
}

struct Check {
    run: u64,
    model: ModelId,
    window: String,
    cancel: watch::Sender<bool>,
    interrupted: Arc<AtomicBool>,
}

struct Inner {
    recognizer: Recognizer,
    models: Mutex<Models>,
    check: Mutex<Option<Check>>,
    next_run: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The recognizer and what runs on it, in the Tauri state. Cheap to clone.
#[derive(Clone)]
pub struct Speech(Arc<Inner>);

impl Speech {
    pub fn new(recognizer: Recognizer) -> Self {
        Self(Arc::new(Inner {
            recognizer,
            models: Mutex::new(Models::default()),
            check: Mutex::new(None),
            next_run: AtomicU64::new(1),
        }))
    }

    pub fn recognizer(&self) -> Recognizer {
        self.0.recognizer.clone()
    }

    fn apply(&self, models: &mut Models) {
        let wanted = models.checking.clone().or_else(|| models.selected.clone());
        if models.applied.as_ref() != Some(&wanted) {
            self.0.recognizer.set_model(wanted.clone());
            models.applied = Some(wanted);
        }
    }

    /// The selected model became installed (`Some`), or is not any more.
    /// Called by the model manager on every change of the selected model.
    pub fn set_selected_model(&self, path: Option<PathBuf>) {
        let mut models = lock(&self.0.models);
        models.selected = path;
        self.apply(&mut models);
    }

    /// Unloads the selected model before its file is deleted (Windows can't
    /// delete a file in use). Blocks up to a few seconds while a phrase
    /// finishes; call it off the async workers.
    pub fn unload(&self) {
        self.set_selected_model(None);
        let deadline = Instant::now() + UNLOAD_WAIT;
        while self.0.recognizer.is_loaded() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Starts a hardware check of `model` (file `path`) for `window`: the
    /// recognizer runs that model until the returned guard goes. One at a
    /// time (`Invalid`).
    pub fn begin_check(
        &self,
        model: ModelId,
        path: Option<PathBuf>,
        window: &str,
    ) -> CommandResult<CheckGuard> {
        let mut check = lock(&self.0.check);
        if check.is_some() {
            return Err(CommandError::invalid("Проверка уже идёт"));
        }
        let run = self.0.next_run.fetch_add(1, Ordering::SeqCst);
        let (cancel, cancelled) = watch::channel(false);
        let interrupted = Arc::new(AtomicBool::new(false));
        *check = Some(Check {
            run,
            model,
            window: window.to_owned(),
            cancel,
            interrupted: Arc::clone(&interrupted),
        });
        drop(check);
        if let Some(path) = path {
            let mut models = lock(&self.0.models);
            models.checking = Some(path);
            self.apply(&mut models);
        }
        Ok(CheckGuard {
            speech: self.clone(),
            run,
            cancelled,
            interrupted,
        })
    }

    /// A recording starts: the hardware check, if one runs, is cancelled and
    /// the recognizer goes back to the selected model at once, so the live
    /// pass never runs on the check's model.
    pub fn interrupt_check(&self) {
        {
            let check = lock(&self.0.check);
            let Some(check) = check.as_ref() else {
                return;
            };
            check.interrupted.store(true, Ordering::SeqCst);
            let _ = check.cancel.send(true);
        }
        let mut models = lock(&self.0.models);
        models.checking = None;
        self.apply(&mut models);
    }

    /// Cancels the hardware check of `window` (any window: `None`) or of
    /// `model`. Nothing when none runs.
    pub fn cancel_check(&self, window: Option<&str>, model: Option<ModelId>) {
        let check = lock(&self.0.check);
        if let Some(check) = check.as_ref() {
            let of_window = window.is_none_or(|label| label == check.window);
            let of_model = model.is_none_or(|id| id == check.model);
            if of_window && of_model {
                let _ = check.cancel.send(true);
            }
        }
    }

    pub fn checking(&self) -> bool {
        lock(&self.0.check).is_some()
    }
}

/// A running hardware check; dropping it gives the recognizer back to the
/// selected model.
pub struct CheckGuard {
    speech: Speech,
    run: u64,
    pub cancelled: watch::Receiver<bool>,
    interrupted: Arc<AtomicBool>,
}

impl CheckGuard {
    /// A recording started during the check (see [`Speech::interrupt_check`]).
    pub fn interrupted(&self) -> bool {
        self.interrupted.load(Ordering::SeqCst)
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }
}

impl Drop for CheckGuard {
    fn drop(&mut self) {
        let inner = &self.speech.0;
        {
            let mut check = lock(&inner.check);
            if check.as_ref().is_some_and(|check| check.run == self.run) {
                *check = None;
            }
        }
        let mut models = lock(&inner.models);
        models.checking = None;
        self.speech.apply(&mut models);
    }
}

/// The live pass and the second pass in the app.
pub struct AppSpeechHost<R: Runtime> {
    pub app: AppHandle<R>,
}

impl<R: Runtime> SpeechHost for AppSpeechHost<R> {
    fn emit(&self, event: TranscriptEvent) {
        event.emit(&self.app);
        // The fast loop hears the live phrases (agent-fast-loop decision 2).
        if let TranscriptEvent::Phrase(phrase) = &event
            && phrase.pass == TranscriptPass::Live
            && let Some(fast_loop) = self.app.try_state::<FastLoop>()
        {
            fast_loop.phrase(&phrase.recording_id, phrase.channel);
        }
    }

    fn data_changed(&self, event: DataChanged) {
        self.app.data_changed(event);
    }

    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        let storage = self
            .app
            .try_state::<Storage>()
            .ok_or_else(|| CommandError::storage("Хранилище ещё не открыто"))?;
        storage.read_now(|connection| work(connection))
    }

    fn selected_model(&self) -> (ModelId, bool) {
        match self.app.try_state::<ModelManager>() {
            Some(models) => {
                let id = models.selected();
                (id, models.model_path(id).is_some())
            }
            None => (ModelId::Turbo, false),
        }
    }

    fn model_failed(&self, model: ModelId, message: &str) {
        if let Some(models) = self.app.try_state::<ModelManager>() {
            models.set_error(
                model,
                ErrorReason::Load,
                format!("Модель не загрузилась: {message}"),
            );
        }
    }

    fn transcription_changed(&self, recording_id: &str, status: TranscriptionStatus) {
        if let Some(recorder) = self.app.try_state::<RecordingManager>() {
            recorder.set_transcription(recording_id, status);
        }
    }

    fn live_started(&self, recording_id: &str) {
        if let Some(fast_loop) = self.app.try_state::<FastLoop>() {
            fast_loop.live_started(recording_id);
        }
    }

    fn live_finished(&self, recording_id: &str) {
        if let Some(fast_loop) = self.app.try_state::<FastLoop>() {
            fast_loop.live_finished(recording_id);
        }
        if let Some(refiner) = self.app.try_state::<Refiner>() {
            refiner.enqueue(recording_id);
        }
    }

    fn refine_paused(&self) -> bool {
        let recording = self
            .app
            .try_state::<RecordingManager>()
            .is_some_and(|recorder| recorder.is_recording());
        let checking = self
            .app
            .try_state::<Speech>()
            .is_some_and(|speech| speech.checking());
        recording || checking
    }

    fn data_dir(&self) -> Option<PathBuf> {
        self.app.path().app_data_dir().ok()
    }

    fn vad_model(&self) -> PathBuf {
        crate::vad::bundled_model_path(&self.app)
    }
}

/// The host of the app as the trait object the passes take.
pub fn app_host<R: Runtime>(app: &AppHandle<R>) -> Arc<dyn SpeechHost> {
    Arc::new(AppSpeechHost { app: app.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::speech::testing::{Script, eventually};

    #[test]
    fn a_check_runs_its_model_and_gives_the_selected_one_back() {
        let script = Script::saying("текст");
        let speech = Speech::new(script.recognizer());
        speech.set_selected_model(Some("turbo.bin".into()));
        let guard = speech
            .begin_check(ModelId::Small, Some("small.bin".into()), "main")
            .unwrap();
        assert_eq!(
            lock(&speech.0.models).applied,
            Some(Some("small.bin".into()))
        );
        assert!(speech.checking());
        assert!(matches!(
            speech.begin_check(ModelId::Turbo, None, "onboarding"),
            Err(CommandError::Invalid { .. })
        ));

        speech.cancel_check(Some("onboarding"), None);
        assert!(!*guard.cancelled.borrow());
        speech.cancel_check(None, Some(ModelId::Small));
        assert!(*guard.cancelled.borrow());

        drop(guard);
        assert!(!speech.checking());
        assert_eq!(
            lock(&speech.0.models).applied,
            Some(Some("turbo.bin".into()))
        );
    }

    #[test]
    fn a_recording_interrupts_the_check_and_gets_the_selected_model() {
        let script = Script::saying("текст");
        let speech = Speech::new(script.recognizer());
        speech.set_selected_model(Some("turbo.bin".into()));
        // Nothing runs: nothing happens.
        speech.interrupt_check();
        let guard = speech
            .begin_check(ModelId::Small, Some("small.bin".into()), "onboarding")
            .unwrap();
        assert!(!guard.interrupted());

        speech.interrupt_check();
        assert!(guard.interrupted());
        assert!(guard.is_cancelled());
        // Before the check notices: the live pass already runs on turbo.
        assert_eq!(
            lock(&speech.0.models).applied,
            Some(Some("turbo.bin".into()))
        );
        drop(guard);
        assert!(!speech.checking());
        assert_eq!(
            lock(&speech.0.models).applied,
            Some(Some("turbo.bin".into()))
        );
    }

    #[test]
    fn unload_waits_until_the_model_is_out() {
        let script = Script::saying("текст");
        let speech = Speech::new(script.recognizer());
        speech.set_selected_model(Some("turbo.bin".into()));
        let reply = speech.recognizer().submit(crate::speech::recognizer::Job {
            samples: vec![0.1; 1_600],
            language: crate::speech::language::LanguageChoice::Fixed(
                crate::speech::language::Language::Ru,
            ),
            prompt: String::new(),
            decode: crate::speech::recognizer::Decode::Greedy,
            priority: crate::speech::recognizer::Priority::Check,
        });
        reply.blocking_recv().unwrap().unwrap();
        eventually("loaded", || speech.recognizer().is_loaded());
        speech.unload();
        assert!(!speech.recognizer().is_loaded());
    }
}
