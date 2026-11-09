//! One loaded Whisper model for the whole app (speech-recognition design.md
//! decisions 5–7).
//!
//! A single worker thread owns the [`Engine`] and serves a priority queue:
//! live phrases, then the hardware check and mic check, then the second
//! pass. Second-pass jobs are one phrase each, so a live phrase waits for at
//! most one of them. The model loads on the first job, unloads after
//! [`IDLE_UNLOAD`] without jobs, and reloads when the model path changes.

use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard},
    thread::JoinHandle,
    time::{Duration, Instant},
};

use tokio::sync::oneshot;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use super::language::{Language, LanguageChoice, pick};

/// How long a loaded model stays in memory without jobs.
pub const IDLE_UNLOAD: Duration = Duration::from_secs(120);

/// One segment of a phrase as the model returned it.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub text: String,
    /// The model's probability that the segment holds no speech.
    pub no_speech_prob: f32,
    /// Mean log-probability of the segment's text tokens.
    pub avg_logprob: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decode {
    /// The live pass and the checks.
    Greedy,
    /// The second pass: beam search of width 5.
    Beam5,
}

/// What one transcription runs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Params {
    pub language: Language,
    /// The glossary prompt; empty for none.
    pub prompt: String,
    pub decode: Decode,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RecognizerError {
    /// No model is selected or its file is missing.
    #[error("no speech model")]
    NoModel,
    /// The model file did not load.
    #[error("speech model {0} failed to load")]
    ModelFailed(String),
    /// The model loaded but inference failed.
    #[error("speech recognition failed: {0}")]
    Inference(String),
    /// The recognizer stopped before the job ran.
    #[error("speech recognizer stopped")]
    Stopped,
}

/// A loaded model. The real one is [`WhisperEngine`]; the tests use fakes.
pub trait Engine: Send {
    /// Transcribes 16 kHz mono samples as one request, without context from
    /// earlier requests.
    fn transcribe(
        &mut self,
        samples: &[f32],
        params: &Params,
    ) -> Result<Vec<Segment>, RecognizerError>;

    /// Language probabilities of 16 kHz mono samples, by whisper.cpp code.
    fn detect_language(&mut self, samples: &[f32]) -> Result<Vec<(String, f32)>, RecognizerError>;
}

/// Loads a model file into an [`Engine`].
pub type Loader =
    Box<dyn Fn(&Path) -> Result<Box<dyn Engine>, RecognizerError> + Send + Sync + 'static>;

// ---------------------------------------------------------------------------
// whisper.cpp

/// whisper.cpp keeps at most `n_text_ctx / 2` prompt tokens and drops the
/// *start* of a longer prompt (448 / 2 = 224 for every Whisper model), so
/// the glossary's most important terms would go first. One token less for
/// the "previous text" marker.
const MAX_PROMPT_TOKENS: usize = 223;

/// Whisper through whisper-rs: one context and one state; Metal on macOS.
pub struct WhisperEngine {
    context: WhisperContext,
    state: WhisperState,
    threads: i32,
    eot: i32,
    #[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
    gpu: bool,
}

impl WhisperEngine {
    pub fn load(path: &Path) -> Result<Self, RecognizerError> {
        // Route whisper.cpp / ggml logging away from stderr, as the VAD does.
        whisper_rs::install_logging_hooks();

        let failed = || RecognizerError::ModelFailed(path.display().to_string());
        if !path.is_file() {
            return Err(RecognizerError::NoModel);
        }
        if path.to_str().is_none_or(|text| text.contains('\0')) {
            return Err(failed());
        }
        let gpu = cfg!(target_os = "macos");
        let mut params = WhisperContextParameters::default();
        // Flash attention is whisper.cpp's own default (the spike's CLI ran
        // with it); whisper-rs turns it off.
        params.use_gpu(gpu).flash_attn(true);
        let context = WhisperContext::new_with_params(path, params).map_err(|_| failed())?;
        let state = context.create_state().map_err(|_| failed())?;
        let eot = context.token_eot();
        let threads =
            std::thread::available_parallelism().map_or(4, |count| count.get().clamp(1, 8)) as i32;
        Ok(Self {
            context,
            state,
            threads,
            eot,
            gpu,
        })
    }

    /// Whether the context was asked to run on the GPU.
    #[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
    pub fn gpu(&self) -> bool {
        self.gpu
    }

    /// The prompt cut on whole ", "-separated terms to what whisper.cpp
    /// keeps from its start.
    fn fit_prompt<'a>(&self, prompt: &'a str) -> &'a str {
        let mut fitted = prompt.trim();
        while !fitted.is_empty() && self.token_count(fitted) > MAX_PROMPT_TOKENS {
            fitted = fitted.rfind(", ").map_or("", |cut| &fitted[..cut]);
        }
        fitted
    }

    fn token_count(&self, text: &str) -> usize {
        // Each token is at least one byte. whisper-rs reads whisper.cpp's
        // "too many" answer (a negative count) as a length, so the buffer
        // must always be big enough.
        self.context
            .tokenize(text, text.len() + 8)
            .map_or(usize::MAX, |tokens| tokens.len())
    }
}

impl Engine for WhisperEngine {
    fn transcribe(
        &mut self,
        samples: &[f32],
        params: &Params,
    ) -> Result<Vec<Segment>, RecognizerError> {
        let strategy = match params.decode {
            Decode::Greedy => SamplingStrategy::Greedy { best_of: 5 },
            Decode::Beam5 => SamplingStrategy::BeamSearch {
                beam_size: 5,
                patience: -1.0,
            },
        };
        let mut full = FullParams::new(strategy);
        full.set_n_threads(self.threads);
        full.set_language(Some(params.language.code()));
        full.set_detect_language(false);
        full.set_translate(false);
        full.set_no_context(true);
        full.set_no_timestamps(false);
        full.set_single_segment(false);
        full.set_suppress_blank(true);
        // Temperature 0, stepping up by 0.2 when a decode fails whisper.cpp's
        // own entropy / log-probability checks.
        full.set_temperature(0.0);
        full.set_temperature_inc(0.2);
        full.set_print_special(false);
        full.set_print_progress(false);
        full.set_print_realtime(false);
        full.set_print_timestamps(false);
        let prompt = self.fit_prompt(&params.prompt);
        if !prompt.is_empty() {
            full.set_initial_prompt(prompt);
        }

        self.state
            .full(full, samples)
            .map_err(|error| RecognizerError::Inference(error.to_string()))?;

        let mut segments = Vec::new();
        for segment in self.state.as_iter() {
            let text = segment
                .to_str_lossy()
                .map_err(|error| RecognizerError::Inference(error.to_string()))?
                .into_owned();
            let mut sum = 0.0_f64;
            let mut count = 0_u32;
            for index in 0..segment.n_tokens() {
                let Some(token) = segment.get_token(index) else {
                    continue;
                };
                let data = token.token_data();
                // Special tokens (timestamps, end of text, …) sit at and
                // above the end-of-text id.
                if data.id >= self.eot {
                    continue;
                }
                sum += f64::from(data.plog);
                count += 1;
            }
            let avg_logprob = if count == 0 {
                0.0
            } else {
                (sum / f64::from(count)) as f32
            };
            segments.push(Segment {
                text,
                no_speech_prob: segment.no_speech_probability(),
                avg_logprob,
            });
        }
        Ok(segments)
    }

    fn detect_language(&mut self, samples: &[f32]) -> Result<Vec<(String, f32)>, RecognizerError> {
        let threads = usize::try_from(self.threads).unwrap_or(1);
        let inference =
            |error: whisper_rs::WhisperError| RecognizerError::Inference(error.to_string());
        self.state.pcm_to_mel(samples, threads).map_err(inference)?;
        let (_, probabilities) = self.state.lang_detect(0, threads).map_err(inference)?;
        Ok(probabilities
            .into_iter()
            .enumerate()
            .filter_map(|(id, p)| {
                let code = whisper_rs::get_lang_str(i32::try_from(id).ok()?)?;
                Some((code.to_owned(), p))
            })
            .collect())
    }
}

/// The loader the app uses.
pub fn whisper_loader() -> Loader {
    Box::new(|path| Ok(Box::new(WhisperEngine::load(path)?) as Box<dyn Engine>))
}

// ---------------------------------------------------------------------------
// The queue

/// Queue order: live phrases first, the second pass last.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    Live,
    /// The hardware check and the mic check.
    Check,
    Refine,
}

const PRIORITIES: [Priority; 3] = [Priority::Live, Priority::Check, Priority::Refine];

/// One phrase to recognize.
#[derive(Debug, Clone)]
pub struct Job {
    /// 16 kHz mono.
    pub samples: Vec<f32>,
    pub language: LanguageChoice,
    /// The glossary prompt; empty for none.
    pub prompt: String,
    pub decode: Decode,
    pub priority: Priority,
}

/// A recognized phrase: its segments and the language they were decoded in
/// (the detected one for [`LanguageChoice::Detect`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Transcript {
    pub language: Language,
    pub segments: Vec<Segment>,
}

pub type Reply = oneshot::Receiver<Result<Transcript, RecognizerError>>;

struct Queued {
    job: Job,
    reply: oneshot::Sender<Result<Transcript, RecognizerError>>,
}

#[derive(Default)]
struct State {
    queues: [VecDeque<Queued>; 3],
    model: Option<PathBuf>,
    /// Bumped by every [`Recognizer::set_model`]; a failed load is not
    /// retried until it changes.
    model_generation: u64,
    loaded: bool,
    shutdown: bool,
}

impl State {
    fn queue(&mut self, priority: Priority) -> &mut VecDeque<Queued> {
        &mut self.queues[priority as usize]
    }

    fn queues_empty(&self) -> bool {
        self.queues.iter().all(VecDeque::is_empty)
    }

    fn next(&mut self) -> Option<Queued> {
        PRIORITIES
            .into_iter()
            .find_map(|priority| self.queue(priority).pop_front())
    }
}

struct Shared {
    state: Mutex<State>,
    wake: Condvar,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Stops the worker when the last [`Recognizer`] handle goes.
struct Worker {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.shared.lock().shutdown = true;
        self.shared.wake.notify_all();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The handle to the recognition thread. Clones share it.
#[derive(Clone)]
pub struct Recognizer {
    shared: Arc<Shared>,
    _worker: Arc<Worker>,
}

impl Recognizer {
    /// Whisper through whisper.cpp, unloaded after [`IDLE_UNLOAD`].
    pub fn whisper(model: Option<PathBuf>) -> Self {
        Self::new(whisper_loader(), model, IDLE_UNLOAD)
    }

    pub fn new(loader: Loader, model: Option<PathBuf>, idle_unload: Duration) -> Self {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                model,
                ..State::default()
            }),
            wake: Condvar::new(),
        });
        let worker_shared = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name("speech-recognizer".into())
            .spawn(move || run(&worker_shared, &loader, idle_unload))
            .expect("spawn the speech recognizer thread");
        Self {
            _worker: Arc::new(Worker {
                shared: Arc::clone(&shared),
                thread: Some(thread),
            }),
            shared,
        }
    }

    /// Queues a phrase. Dropping the reply before the job starts cancels it.
    pub fn submit(&self, job: Job) -> Reply {
        let (reply, receiver) = oneshot::channel();
        let mut state = self.shared.lock();
        if state.shutdown {
            let _ = reply.send(Err(RecognizerError::Stopped));
            return receiver;
        }
        state.queue(job.priority).push_back(Queued { job, reply });
        drop(state);
        self.shared.wake.notify_all();
        receiver
    }

    /// Selects the model file (`None`: no model). A different path unloads
    /// the loaded model; the next job loads the new one.
    pub fn set_model(&self, model: Option<PathBuf>) {
        let mut state = self.shared.lock();
        state.model = model;
        state.model_generation += 1;
        drop(state);
        self.shared.wake.notify_all();
    }

    pub fn is_loaded(&self) -> bool {
        self.shared.lock().loaded
    }

    /// Queued audio of one priority, in samples, cancelled jobs excluded.
    pub fn queued_samples(&self, priority: Priority) -> usize {
        self.shared
            .lock()
            .queue(priority)
            .iter()
            .filter(|queued| !queued.reply.is_closed())
            .map(|queued| queued.job.samples.len())
            .sum()
    }
}

struct Loaded {
    engine: Box<dyn Engine>,
    path: PathBuf,
}

fn run(shared: &Shared, loader: &Loader, idle_unload: Duration) {
    let mut loaded: Option<Loaded> = None;
    // The generation and path of the last failed load.
    let mut failed: Option<(u64, PathBuf)> = None;
    let mut last_job = Instant::now();

    loop {
        let mut state = shared.lock();
        let next = loop {
            if state.shutdown {
                return;
            }
            // A model switch unloads at once, not on the next job.
            let switched = loaded
                .as_ref()
                .is_some_and(|current| state.model.as_deref() != Some(current.path.as_path()));
            let idle = last_job.elapsed();
            let idle_long = loaded.is_some() && idle >= idle_unload && state.queues_empty();
            if switched || idle_long {
                // Free the model outside the lock: `submit` must not wait.
                state.loaded = false;
                drop(state);
                loaded = None;
                state = shared.lock();
                continue;
            }
            if let Some(next) = state.next() {
                break next;
            }
            if loaded.is_some() {
                state = shared
                    .wake
                    .wait_timeout(state, idle_unload - idle)
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .0;
            } else {
                state = shared
                    .wake
                    .wait(state)
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
            }
        };
        if next.reply.is_closed() {
            continue;
        }
        let model = state.model.clone();
        let generation = state.model_generation;
        drop(state);

        let result = match model {
            None => Err(RecognizerError::NoModel),
            Some(path) => {
                // Never two models in memory: the old one goes before the load.
                if loaded.as_ref().is_some_and(|current| current.path != path) {
                    loaded = None;
                }
                let engine = match loaded.take() {
                    Some(current) => Ok(current),
                    None => match &failed {
                        Some((at, failed_path)) if *at == generation && *failed_path == path => {
                            Err(RecognizerError::ModelFailed(path.display().to_string()))
                        }
                        _ => guarded(|| loader(&path)).map(|engine| Loaded {
                            engine,
                            path: path.clone(),
                        }),
                    },
                };
                match engine {
                    Ok(mut current) => {
                        failed = None;
                        shared.lock().loaded = true;
                        let result = guarded(|| recognize(current.engine.as_mut(), &next.job));
                        loaded = Some(current);
                        result
                    }
                    Err(error) => {
                        if matches!(error, RecognizerError::ModelFailed(_)) {
                            failed = Some((generation, path));
                        }
                        shared.lock().loaded = false;
                        Err(error)
                    }
                }
            }
        };
        last_job = Instant::now();
        let _ = next.reply.send(result);
    }
}

/// A panic in the engine fails the job instead of the worker, so queued
/// callers still get answers.
fn guarded<T>(work: impl FnOnce() -> Result<T, RecognizerError>) -> Result<T, RecognizerError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(work))
        .unwrap_or_else(|_| Err(RecognizerError::Inference("the engine panicked".into())))
}

fn recognize(engine: &mut dyn Engine, job: &Job) -> Result<Transcript, RecognizerError> {
    let language = match job.language {
        LanguageChoice::Fixed(language) => language,
        LanguageChoice::Detect => pick(&engine.detect_language(&job.samples)?),
    };
    let params = Params {
        language,
        prompt: job.prompt.clone(),
        decode: job.decode,
    };
    let segments = engine.transcribe(&job.samples, &params)?;
    Ok(Transcript { language, segments })
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    /// What the fake engine saw.
    #[derive(Debug, Clone, PartialEq)]
    enum Call {
        Load(PathBuf),
        Detect,
        /// The first sample identifies the job.
        Transcribe(f32, Language, Decode),
    }

    #[derive(Default)]
    struct Log {
        calls: Mutex<Vec<Call>>,
    }

    impl Log {
        fn calls(&self) -> Vec<Call> {
            self.calls.lock().unwrap().clone()
        }

        fn loads(&self) -> usize {
            self.calls()
                .iter()
                .filter(|call| matches!(call, Call::Load(_)))
                .count()
        }

        fn transcribed(&self) -> Vec<f32> {
            self.calls()
                .iter()
                .filter_map(|call| match call {
                    Call::Transcribe(id, ..) => Some(*id),
                    _ => None,
                })
                .collect()
        }
    }

    struct Fake {
        log: Arc<Log>,
        /// Each transcription waits for one message when set.
        gate: Option<Arc<Mutex<mpsc::Receiver<()>>>>,
        detected: Vec<(String, f32)>,
    }

    impl Engine for Fake {
        fn transcribe(
            &mut self,
            samples: &[f32],
            params: &Params,
        ) -> Result<Vec<Segment>, RecognizerError> {
            if let Some(gate) = &self.gate {
                gate.lock().unwrap().recv().unwrap();
            }
            let id = samples.first().copied().unwrap_or(-1.0);
            self.log.calls.lock().unwrap().push(Call::Transcribe(
                id,
                params.language,
                params.decode,
            ));
            Ok(vec![Segment {
                text: format!("phrase {id} {}", params.prompt),
                no_speech_prob: 0.01,
                avg_logprob: -0.2,
            }])
        }

        fn detect_language(
            &mut self,
            _samples: &[f32],
        ) -> Result<Vec<(String, f32)>, RecognizerError> {
            self.log.calls.lock().unwrap().push(Call::Detect);
            Ok(self.detected.clone())
        }
    }

    struct Setup {
        log: Arc<Log>,
        recognizer: Recognizer,
        release: Option<mpsc::Sender<()>>,
    }

    fn setup(gated: bool, idle: Duration) -> Setup {
        let log = Arc::new(Log::default());
        let (release, gate) = mpsc::channel();
        let gate = gated.then(|| Arc::new(Mutex::new(gate)));
        let loader_log = Arc::clone(&log);
        let loader: Loader = Box::new(move |path| {
            loader_log
                .calls
                .lock()
                .unwrap()
                .push(Call::Load(path.to_path_buf()));
            if path.ends_with("broken.bin") {
                return Err(RecognizerError::ModelFailed(path.display().to_string()));
            }
            Ok(Box::new(Fake {
                log: Arc::clone(&loader_log),
                gate: gate.clone(),
                detected: vec![("en".into(), 0.5), ("ru".into(), 0.2), ("uk".into(), 0.3)],
            }) as Box<dyn Engine>)
        });
        Setup {
            recognizer: Recognizer::new(loader, Some("turbo.bin".into()), idle),
            log,
            release: gated.then_some(release),
        }
    }

    fn job(id: f32, priority: Priority) -> Job {
        Job {
            samples: vec![id; 1_600],
            language: LanguageChoice::Fixed(Language::Ru),
            prompt: String::new(),
            decode: match priority {
                Priority::Refine => Decode::Beam5,
                _ => Decode::Greedy,
            },
            priority,
        }
    }

    fn wait(reply: Reply) -> Result<Transcript, RecognizerError> {
        reply.blocking_recv().expect("the worker replies")
    }

    /// Polls until `condition` holds (the worker runs on its own thread).
    fn eventually(condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn a_job_loads_the_model_and_returns_segments() {
        let setup = setup(false, IDLE_UNLOAD);
        assert!(!setup.recognizer.is_loaded());
        let mut first = job(1.0, Priority::Live);
        first.prompt = "Техноком".into();
        let transcript = wait(setup.recognizer.submit(first)).unwrap();
        assert_eq!(transcript.language, Language::Ru);
        assert_eq!(transcript.segments[0].text, "phrase 1 Техноком");
        assert!(setup.recognizer.is_loaded());
        wait(setup.recognizer.submit(job(2.0, Priority::Live))).unwrap();
        assert_eq!(setup.log.loads(), 1);
    }

    #[test]
    fn live_then_check_then_refine() {
        let setup = setup(true, IDLE_UNLOAD);
        let release = setup.release.as_ref().unwrap();
        // The first job holds the worker while the rest queue up.
        let first = setup.recognizer.submit(job(0.0, Priority::Refine));
        eventually(|| setup.log.loads() == 1);
        let replies = [
            setup.recognizer.submit(job(1.0, Priority::Refine)),
            setup.recognizer.submit(job(2.0, Priority::Check)),
            setup.recognizer.submit(job(3.0, Priority::Live)),
            setup.recognizer.submit(job(4.0, Priority::Refine)),
            setup.recognizer.submit(job(5.0, Priority::Live)),
            setup.recognizer.submit(job(6.0, Priority::Check)),
        ];
        for _ in 0..7 {
            release.send(()).unwrap();
        }
        wait(first).unwrap();
        for reply in replies {
            wait(reply).unwrap();
        }
        assert_eq!(setup.log.transcribed(), [0.0, 3.0, 5.0, 2.0, 6.0, 1.0, 4.0]);
    }

    #[test]
    fn a_live_phrase_waits_for_at_most_one_refine_phrase() {
        let setup = setup(true, IDLE_UNLOAD);
        let release = setup.release.as_ref().unwrap();
        let refines: Vec<Reply> = (0..5)
            .map(|n| setup.recognizer.submit(job(n as f32, Priority::Refine)))
            .collect();
        // The worker is inside refine phrase 0 when the live one comes.
        eventually(|| setup.log.loads() == 1);
        let live = setup.recognizer.submit(job(100.0, Priority::Live));
        release.send(()).unwrap();
        release.send(()).unwrap();
        wait(live).unwrap();
        assert_eq!(setup.log.transcribed(), [0.0, 100.0]);
        for _ in 0..4 {
            release.send(()).unwrap();
        }
        for reply in refines {
            assert_eq!(wait(reply).unwrap().segments.len(), 1);
        }
        assert_eq!(setup.log.transcribed(), [0.0, 100.0, 1.0, 2.0, 3.0, 4.0]);
    }

    #[test]
    fn the_model_unloads_when_idle_and_loads_again_on_the_next_job() {
        let setup = setup(false, Duration::from_millis(60));
        wait(setup.recognizer.submit(job(1.0, Priority::Live))).unwrap();
        assert!(setup.recognizer.is_loaded());
        eventually(|| !setup.recognizer.is_loaded());
        wait(setup.recognizer.submit(job(2.0, Priority::Live))).unwrap();
        assert_eq!(setup.log.loads(), 2);
    }

    #[test]
    fn jobs_keep_the_model_loaded() {
        let setup = setup(false, Duration::from_millis(300));
        for n in 0..6 {
            wait(setup.recognizer.submit(job(n as f32, Priority::Live))).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(setup.log.loads(), 1);
    }

    #[test]
    fn a_model_switch_unloads_and_the_next_job_loads_the_new_one() {
        let setup = setup(false, IDLE_UNLOAD);
        wait(setup.recognizer.submit(job(1.0, Priority::Live))).unwrap();
        setup.recognizer.set_model(Some("small.bin".into()));
        eventually(|| !setup.recognizer.is_loaded());
        wait(setup.recognizer.submit(job(2.0, Priority::Live))).unwrap();
        assert_eq!(
            setup
                .log
                .calls()
                .into_iter()
                .filter(|call| matches!(call, Call::Load(_)))
                .collect::<Vec<_>>(),
            [
                Call::Load("turbo.bin".into()),
                Call::Load("small.bin".into())
            ]
        );
        // Selecting the same path again keeps it loaded.
        setup.recognizer.set_model(Some("small.bin".into()));
        wait(setup.recognizer.submit(job(3.0, Priority::Live))).unwrap();
        assert_eq!(setup.log.loads(), 2);
    }

    #[test]
    fn no_model_fails_the_job() {
        let setup = setup(false, IDLE_UNLOAD);
        setup.recognizer.set_model(None);
        assert_eq!(
            wait(setup.recognizer.submit(job(1.0, Priority::Live))),
            Err(RecognizerError::NoModel)
        );
        assert_eq!(setup.log.loads(), 0);
    }

    #[test]
    fn a_failed_load_is_not_retried_until_the_model_is_set_again() {
        let setup = setup(false, IDLE_UNLOAD);
        setup.recognizer.set_model(Some("broken.bin".into()));
        for n in 0..3 {
            assert!(matches!(
                wait(setup.recognizer.submit(job(n as f32, Priority::Live))),
                Err(RecognizerError::ModelFailed(_))
            ));
        }
        assert_eq!(setup.log.loads(), 1);
        setup.recognizer.set_model(Some("broken.bin".into()));
        assert!(wait(setup.recognizer.submit(job(9.0, Priority::Live))).is_err());
        assert_eq!(setup.log.loads(), 2);
        setup.recognizer.set_model(Some("turbo.bin".into()));
        assert!(wait(setup.recognizer.submit(job(10.0, Priority::Live))).is_ok());
    }

    #[test]
    fn detect_picks_russian_or_ukrainian_only() {
        let setup = setup(false, IDLE_UNLOAD);
        let mut detect = job(1.0, Priority::Live);
        detect.language = LanguageChoice::Detect;
        let transcript = wait(setup.recognizer.submit(detect)).unwrap();
        // English is the most probable, but only ru/uk may win.
        assert_eq!(transcript.language, Language::Uk);
        assert_eq!(
            setup.log.calls()[1..],
            [
                Call::Detect,
                Call::Transcribe(1.0, Language::Uk, Decode::Greedy)
            ]
        );
    }

    #[test]
    fn a_dropped_reply_cancels_a_queued_job() {
        let setup = setup(true, IDLE_UNLOAD);
        let release = setup.release.as_ref().unwrap();
        let first = setup.recognizer.submit(job(0.0, Priority::Live));
        eventually(|| setup.log.loads() == 1);
        let skipped = setup.recognizer.submit(job(1.0, Priority::Live));
        let kept = setup.recognizer.submit(job(2.0, Priority::Live));
        assert_eq!(setup.recognizer.queued_samples(Priority::Live), 3_200);
        drop(skipped);
        assert_eq!(setup.recognizer.queued_samples(Priority::Live), 1_600);
        assert_eq!(setup.recognizer.queued_samples(Priority::Refine), 0);
        release.send(()).unwrap();
        release.send(()).unwrap();
        wait(first).unwrap();
        wait(kept).unwrap();
        assert_eq!(setup.log.transcribed(), [0.0, 2.0]);
    }

    #[test]
    fn a_panicking_load_fails_the_job_and_the_worker_goes_on() {
        let loader: Loader = Box::new(|_| panic!("loader bug"));
        let recognizer = Recognizer::new(loader, Some("turbo.bin".into()), IDLE_UNLOAD);
        for n in 0..2 {
            assert!(matches!(
                wait(recognizer.submit(job(n as f32, Priority::Live))),
                Err(RecognizerError::Inference(_))
            ));
        }
    }

    #[test]
    fn dropping_the_last_handle_stops_the_worker() {
        let setup = setup(false, IDLE_UNLOAD);
        let clone = setup.recognizer.clone();
        drop(setup.recognizer);
        wait(clone.submit(job(1.0, Priority::Live))).unwrap();
        drop(clone);
    }

    // -----------------------------------------------------------------------
    // The real model

    use crate::speech::check::{self, CheckPhrase};

    /// `GRILL_WHISPER_MODEL`, else the app's turbo download.
    fn real_model() -> Option<PathBuf> {
        let path = std::env::var_os("GRILL_WHISPER_MODEL")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| {
                    PathBuf::from(home).join(
                        "Library/Application Support/com.dev-wandry.realtime-grilling/models/ggml-large-v3-turbo-q5_0.bin",
                    )
                })
            })?;
        path.is_file().then_some(path)
    }

    fn phrase(id: &str) -> CheckPhrase {
        check::load(&check::dev_dir())
            .expect("check phrases")
            .phrases
            .into_iter()
            .find(|phrase| phrase.id == id)
            .expect("phrase")
    }

    /// Word error rate after the simple normalization of the hardware check.
    fn wer(reference: &str, hypothesis: &str) -> f64 {
        let words = |text: &str| -> Vec<String> {
            crate::speech::filters::normalize(text)
                .split_whitespace()
                .map(str::to_owned)
                .collect()
        };
        let (reference, hypothesis) = (words(reference), words(hypothesis));
        let mut row: Vec<usize> = (0..=hypothesis.len()).collect();
        for (i, r) in reference.iter().enumerate() {
            let mut previous = row[0];
            row[0] = i + 1;
            for (j, h) in hypothesis.iter().enumerate() {
                let substitution = previous + usize::from(r != h);
                previous = row[j + 1];
                row[j + 1] = substitution.min(row[j] + 1).min(row[j + 1] + 1);
            }
        }
        row[hypothesis.len()] as f64 / reference.len().max(1) as f64
    }

    #[test]
    fn wer_counts_word_edits() {
        assert!(wer("Нет, это не критично.", "нет это не критично").abs() < 1e-9);
        assert!((wer("раз два три четыре", "раз три четыре пять") - 0.5).abs() < 1e-9);
    }

    #[test]
    #[ignore = "needs a Whisper model: GRILL_WHISPER_MODEL or the app's turbo download"]
    fn the_real_model_transcribes_the_check_phrases() {
        let Some(path) = real_model() else {
            eprintln!("no model: set GRILL_WHISPER_MODEL");
            return;
        };
        let started = Instant::now();
        let engine = WhisperEngine::load(&path).expect("model loads");
        eprintln!(
            "loaded {} in {:?}; gpu requested: {}; {}",
            path.display(),
            started.elapsed(),
            engine.gpu(),
            whisper_rs::print_system_info()
        );
        drop(engine);

        let recognizer = Recognizer::whisper(Some(path));
        let set = check::load(&check::dev_dir()).expect("check phrases");
        for phrase in &set.phrases {
            for (name, prompt) in [
                ("no prompt", ""),
                ("glossary", set.glossary(phrase.language)),
            ] {
                let started = Instant::now();
                let transcript = wait(recognizer.submit(Job {
                    samples: phrase.samples.clone(),
                    language: LanguageChoice::Fixed(phrase.language),
                    prompt: prompt.to_owned(),
                    decode: Decode::Greedy,
                    priority: Priority::Check,
                }))
                .expect("transcribes");
                let text = crate::speech::filters::filter(
                    &transcript.segments,
                    &crate::speech::glossary::Glossary::empty(),
                    &[],
                )
                .unwrap_or_default();
                let error = wer(&phrase.reference, &text);
                eprintln!(
                    "{} {name}: {:?} for {:.1} s, WER {:.0} %: {text}",
                    phrase.id,
                    started.elapsed(),
                    phrase.duration().as_secs_f64(),
                    error * 100.0,
                );
                assert!(error < 0.35, "{}: {text}", phrase.id);
            }
        }
    }

    /// A full 340-character Cyrillic glossary against whisper.cpp's prompt
    /// budget: it fits as it is, and the engine would cut a longer one on
    /// whole terms from the end.
    #[test]
    #[ignore = "needs a Whisper model: GRILL_WHISPER_MODEL or the app's turbo download"]
    fn the_real_model_fits_a_full_glossary_into_the_prompt() {
        let Some(path) = real_model() else {
            eprintln!("no model: set GRILL_WHISPER_MODEL");
            return;
        };
        let engine = WhisperEngine::load(&path).expect("model loads");
        let people: Vec<String> = [
            "Ірина Дорошенко",
            "Тарас Гнатюк",
            "Олег Ковальчук",
            "Марина Швец",
            "Андрей Литвиненко",
            "Наталья Кравченко",
            "Віталій Остапчук",
            "Екатерина Беляева",
            "Святослав Мельничук",
            "Людмила Савченко",
        ]
        .map(str::to_owned)
        .to_vec();
        let brief = serde_json::json!({
            "glossary": [
                { "term": "Старший смены" }, { "term": "Первичка" }, { "term": "Сделка" },
                { "term": "Перезвон" }, { "term": "Маршрутизация по отделам" },
                { "term": "Пропущенный звонок" }, { "term": "Карточка клиента" },
                { "term": "Вивантаження звітів" }, { "term": "Черга дзвінків" }
            ],
            "stack": ["Bitrix24", "ClickUp", "amoCRM API v4", "Mango Office", "Binotel",
                      "Ringostat", "KeyCRM", "Asterisk", "Google Таблицы", "NestJS", "PostgreSQL",
                      "Мобильное приложение", "Голосовое меню", "Запись разговоров",
                      "Аналитика звонков", "Інтеграція з телефонією", "Відділ продажів",
                      "Webhook", "SIP-транк", "SLA", "Slack"]
        });
        let glossary = crate::speech::glossary::Glossary::build(
            Some("Техноком"),
            &people[..3],
            &people[3..],
            Some(&brief),
        );
        for (name, prompt) in [("live", glossary.live()), ("full", glossary.full())] {
            let fitted = engine.fit_prompt(prompt);
            eprintln!(
                "{name}: {} chars, {} tokens -> {} chars, {} tokens",
                prompt.chars().count(),
                engine.token_count(prompt),
                fitted.chars().count(),
                engine.token_count(fitted),
            );
            assert!(engine.token_count(fitted) <= MAX_PROMPT_TOKENS);
            if name == "full" {
                assert!(prompt.chars().count() > 300, "grow the test glossary");
            }
            assert!(prompt.starts_with(fitted));
        }
    }

    #[test]
    #[ignore = "needs a Whisper model: GRILL_WHISPER_MODEL or the app's turbo download"]
    fn the_real_model_detects_ukrainian() {
        let Some(path) = real_model() else {
            eprintln!("no model: set GRILL_WHISPER_MODEL");
            return;
        };
        let mut engine = WhisperEngine::load(&path).expect("model loads");
        for id in ["uk02", "uk07", "uk12", "ru05"] {
            let phrase = phrase(id);
            let probabilities = engine.detect_language(&phrase.samples).expect("detects");
            let mut top = probabilities.clone();
            top.sort_by(|a, b| b.1.total_cmp(&a.1));
            eprintln!("{id}: {:?}", &top[..3]);
            assert_eq!(pick(&probabilities), phrase.language, "{id}");
        }
    }
}
