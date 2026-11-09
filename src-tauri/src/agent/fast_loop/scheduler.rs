//! One scheduler per recording (design.md, decision 2): a task that hears
//! the live phrases and decides when the agent is called.
//!
//! A call starts when a phrase of «Остальные» came, no call runs, the
//! interval of `questionFrequency` (read at every decision) has passed since
//! the last call started, and there were phrases since then. Phrases during
//! a call count for the next one. After a failed call the next starts by
//! itself 30 s later (not before); `agent_retry` starts one at once.
//! `NotLoggedIn` stops the calls until a status check finds the agent ready;
//! `RateLimited` until the limit resets.
//!
//! A call: wait for the gate (one call at a time across all recordings) →
//! assemble → run the agent → parse → validate → in one transaction check
//! again against the stored state, apply the patch and record the call →
//! `CallStateChanged` → `AgentStatus`. The end of the live pass cancels the
//! running call (`cancelled`); so does the app's exit, which also kills the
//! CLI's process tree at once ([`FastLoop::shutdown`]).
//!
//! [`FastLoop`] holds the schedulers of the recordings being recorded. Time
//! is tokio's and the agent is a trait object, so the tests run on a paused
//! clock with a fake agent.

use std::{
    borrow::Cow,
    collections::HashMap,
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use rusqlite::Connection;
use tokio::{
    runtime::Handle,
    sync::{Semaphore, mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};

use super::{
    assembly::{self, Prefix},
    events::{AgentLoopState, AgentStatus},
    patch::{self, Patch},
    similarity::{QuestionSimilarity, TrigramSimilarity},
    validate,
};
use crate::{
    agent::{
        claude_cli::{self, Agent, AgentError, AgentRequest, CallOptions},
        process::TreeSlot,
    },
    error::{CommandError, CommandResult},
    storage::{
        call_state::{self, AgentCallInput, AgentCallOutcome},
        now_ms, settings,
        transcript::TranscriptChannel,
    },
};

/// Work on the database, as the host runs it.
pub type DbWork<'a> = &'a mut dyn FnMut(&Connection) -> CommandResult<()>;

/// Where the fast loop reads, writes and reports: the app, or a recorder in
/// the tests.
pub trait LoopHost: Send + Sync + 'static {
    /// Runs `work` on the database (blocking).
    fn database(&self, work: DbWork<'_>) -> CommandResult<()>;
    /// `CallStateChanged` to every window.
    fn call_state_changed(&self, recording_id: &str);
    /// `AgentStatus` to every window.
    fn agent_status(&self, status: &AgentStatus);
    /// The wall clock (Unix ms) of the times the loop writes: when a call
    /// started and was recorded, when its questions and topics were
    /// created. The app's is [`now_ms`]; a replay's runs on its virtual
    /// clock, so its times are those of the call it replays
    /// (question-quality design.md, decision 3).
    fn now_ms(&self) -> i64;
}

pub type ProvideFuture =
    Pin<Box<dyn Future<Output = Result<Arc<dyn Agent>, AgentLoopState>> + Send>>;

/// The agent for a recording that starts, if it is ready: Claude Code once
/// its status is `ready` in the app. Otherwise the state the windows get
/// (`needsLogin`, `error`).
pub trait AgentProvider: Send + Sync + 'static {
    fn provide(&self) -> ProvideFuture;
}

#[derive(Debug, Clone)]
pub struct LoopConfig {
    /// Where the prefix files go: the CLI's work dir.
    pub prompt_dir: PathBuf,
    /// After a failed call.
    pub retry_after: Duration,
    /// A call still running then is cancelled: the agent's own timeout and
    /// a little more, for an agent that doesn't keep it.
    pub call_timeout: Duration,
    /// How long a cancelled call may take to stop.
    pub cancel_wait: Duration,
    /// The rules that open the prefix: [`assembly::RULES`] in the app; a
    /// replay may try another text (`grill-eval replay --rules`).
    pub rules: Cow<'static, str>,
    /// The state's empty lenses and pause line (question-quality design.md,
    /// decision 7): on in the app; a replay may leave them out to measure
    /// them (`grill-eval replay --baseline-state`).
    pub state_hints: bool,
}

impl LoopConfig {
    pub fn new(prompt_dir: impl Into<PathBuf>) -> Self {
        Self {
            prompt_dir: prompt_dir.into(),
            retry_after: Duration::from_secs(30),
            call_timeout: claude_cli::TIMEOUT + Duration::from_secs(2),
            cancel_wait: Duration::from_secs(5),
            rules: Cow::Borrowed(assembly::RULES),
            state_hints: true,
        }
    }
}

/// When `questionFrequency` can't be read.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(20);

#[derive(Debug)]
enum Message {
    Phrase(TranscriptChannel),
    /// `agent_retry`.
    Retry,
    /// A status check found the agent ready.
    Resume,
    /// The live pass is over.
    Stop,
}

struct Session {
    sender: mpsc::UnboundedSender<Message>,
    /// Until a scheduler takes it: the phrases wait here while the agent
    /// is checked, or while it is not ready.
    waiting: Option<mpsc::UnboundedReceiver<Message>>,
}

/// A call of a recording that started and hasn't ended.
struct InFlight {
    /// Cancels it: the end of the live pass, the app's exit.
    stop: oneshot::Sender<()>,
    /// Its CLI's process tree while it runs.
    process: TreeSlot,
}

struct Inner {
    host: Arc<dyn LoopHost>,
    provider: Arc<dyn AgentProvider>,
    runtime: Handle,
    config: LoopConfig,
    similarity: Arc<dyn QuestionSimilarity>,
    sessions: Mutex<HashMap<String, Session>>,
    /// The agent's state of each recording whose session is there; none
    /// once it ended (`idle`).
    statuses: Mutex<HashMap<String, AgentStatus>>,
    /// The last share of the subscription limit the CLI reported.
    utilization: Mutex<Option<f64>>,
    /// One call at a time, across all recordings (spec: «Одновременно
    /// MUST идти не больше одного вызова»). Closed by the app's exit.
    gate: Arc<Semaphore>,
    /// By recording: at most one each.
    in_flight: Mutex<HashMap<String, InFlight>>,
    /// After [`FastLoop::shutdown`]: nothing starts.
    closed: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The fast loop of the app: the schedulers of the recordings whose live
/// pass runs. Managed as Tauri state; cheap to clone.
#[derive(Clone)]
pub struct FastLoop(Arc<Inner>);

impl FastLoop {
    /// Schedulers run on `runtime`.
    pub fn new(
        host: Arc<dyn LoopHost>,
        provider: Arc<dyn AgentProvider>,
        runtime: Handle,
        config: LoopConfig,
    ) -> Self {
        Self(Arc::new(Inner {
            host,
            provider,
            runtime,
            config,
            similarity: Arc::new(TrigramSimilarity::default()),
            sessions: Mutex::new(HashMap::new()),
            statuses: Mutex::new(HashMap::new()),
            utilization: Mutex::new(None),
            gate: Arc::new(Semaphore::new(1)),
            in_flight: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }))
    }

    /// The live pass of `recording_id` started: its scheduler starts once
    /// the agent is ready. Phrases from now on are kept for it.
    pub fn live_started(&self, recording_id: &str) {
        if self.0.closed.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut sessions = lock(&self.0.sessions);
            if sessions.contains_key(recording_id) {
                return;
            }
            let (sender, receiver) = mpsc::unbounded_channel();
            sessions.insert(
                recording_id.to_owned(),
                Session {
                    sender,
                    waiting: Some(receiver),
                },
            );
        }
        self.try_start(recording_id);
    }

    /// A live phrase of `recording_id` was stored.
    pub fn phrase(&self, recording_id: &str, channel: TranscriptChannel) {
        self.send(recording_id, Message::Phrase(channel));
    }

    /// The live pass of `recording_id` is over: the running call, if any,
    /// is cancelled, and no other starts.
    pub fn live_finished(&self, recording_id: &str) {
        let session = lock(&self.0.sessions).remove(recording_id);
        if let Some(session) = session {
            let _ = session.sender.send(Message::Stop);
            if session.waiting.is_some() {
                self.forget(recording_id);
            }
        }
    }

    /// The app exits: every running call is cancelled and its CLI's process
    /// tree killed now, synchronously (no task runs after `process::exit`),
    /// the schedulers stop, nothing starts again, and the prefix files are
    /// removed.
    pub fn shutdown(&self) {
        self.0.closed.store(true, Ordering::SeqCst);
        self.0.gate.close();
        let calls: Vec<InFlight> = lock(&self.0.in_flight).drain().map(|(_, c)| c).collect();
        for call in calls {
            call.process.kill();
            let _ = call.stop.send(());
        }
        for (_, session) in lock(&self.0.sessions).drain() {
            let _ = session.sender.send(Message::Stop);
        }
        match assembly::sweep_prompts(&self.0.config.prompt_dir, |_| false) {
            Ok(_) => {}
            Err(error) => eprintln!("grill: could not remove the agent's prompt files: {error}"),
        }
    }

    /// Removes the prefix files no live recording owns: what a crash or a
    /// forced quit left behind (they hold the brief and the people's
    /// profiles). Returns how many went.
    pub fn sweep_prompts(&self) -> usize {
        let sessions = lock(&self.0.sessions);
        match assembly::sweep_prompts(&self.0.config.prompt_dir, |recording_id| {
            sessions.contains_key(recording_id)
        }) {
            Ok(removed) => removed,
            Err(error) => {
                eprintln!("grill: could not sweep the agent's prompt files: {error}");
                0
            }
        }
    }

    /// «Повторить»: a call now, or the agent checked again when it was not
    /// ready. `NotFound` when the recording's live pass doesn't run.
    pub fn retry(&self, recording_id: &str) -> CommandResult<()> {
        let waiting = {
            let sessions = lock(&self.0.sessions);
            let session = sessions
                .get(recording_id)
                .ok_or_else(|| CommandError::not_found(format!("Запись {recording_id} не идёт")))?;
            if session.waiting.is_none() {
                let _ = session.sender.send(Message::Retry);
            }
            session.waiting.is_some()
        };
        if waiting {
            self.try_start(recording_id);
        }
        Ok(())
    }

    /// A status check found the agent ready: the recordings waiting for it
    /// start, the schedulers stopped by `NotLoggedIn` go on.
    pub fn agent_ready(&self) {
        let waiting: Vec<String> = {
            let sessions = lock(&self.0.sessions);
            for session in sessions.values() {
                if session.waiting.is_none() {
                    let _ = session.sender.send(Message::Resume);
                }
            }
            sessions
                .iter()
                .filter(|(_, session)| session.waiting.is_some())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for recording_id in waiting {
            self.try_start(&recording_id);
        }
    }

    /// The agent's state for `recording_id`: `idle` when nothing happened.
    pub fn status(&self, recording_id: &str) -> AgentStatus {
        lock(&self.0.statuses)
            .get(recording_id)
            .cloned()
            .unwrap_or_else(|| AgentStatus {
                recording_id: recording_id.to_owned(),
                state: AgentLoopState::Idle,
                utilization: *lock(&self.0.utilization),
            })
    }

    fn send(&self, recording_id: &str, message: Message) {
        if let Some(session) = lock(&self.0.sessions).get(recording_id) {
            let _ = session.sender.send(message);
        }
    }

    /// How many recordings have a state kept.
    #[cfg(test)]
    fn kept_statuses(&self) -> usize {
        lock(&self.0.statuses).len()
    }

    fn has_session(&self, recording_id: &str) -> bool {
        lock(&self.0.sessions).contains_key(recording_id)
    }

    fn note_utilization(&self, utilization: Option<f64>) {
        if let Some(utilization) = utilization {
            *lock(&self.0.utilization) = Some(utilization);
        }
    }

    /// Keeps the state for `call_state_get` and sends `AgentStatus`.
    fn report(&self, recording_id: &str, state: AgentLoopState) {
        let status = self.status_of(recording_id, state);
        lock(&self.0.statuses).insert(recording_id.to_owned(), status.clone());
        self.0.host.agent_status(&status);
    }

    /// The recording's session ended: its state is no longer kept
    /// (`call_state_get` says `idle`), and the windows get `idle`.
    fn forget(&self, recording_id: &str) {
        lock(&self.0.statuses).remove(recording_id);
        let status = self.status_of(recording_id, AgentLoopState::Idle);
        self.0.host.agent_status(&status);
    }

    fn status_of(&self, recording_id: &str, state: AgentLoopState) -> AgentStatus {
        AgentStatus {
            recording_id: recording_id.to_owned(),
            state,
            utilization: *lock(&self.0.utilization),
        }
    }

    /// A call of `recording_id` starts: it can be cancelled from here.
    fn call_started(&self, recording_id: &str, call: InFlight) {
        lock(&self.0.in_flight).insert(recording_id.to_owned(), call);
    }

    /// The call of `recording_id` ended.
    fn call_ended(&self, recording_id: &str) {
        lock(&self.0.in_flight).remove(recording_id);
    }

    /// Cancels the running call of `recording_id`, if any.
    fn cancel_call(&self, recording_id: &str) {
        if let Some(call) = lock(&self.0.in_flight).remove(recording_id) {
            let _ = call.stop.send(());
        }
    }

    /// Checks the agent and builds the prefix, then runs the scheduler. If
    /// the agent is not ready the phrases go back to wait.
    fn try_start(&self, recording_id: &str) {
        let receiver = lock(&self.0.sessions)
            .get_mut(recording_id)
            .and_then(|session| session.waiting.take());
        let Some(receiver) = receiver else {
            return;
        };
        let this = self.clone();
        let recording_id = recording_id.to_owned();
        self.0
            .runtime
            .spawn(async move { this.start(recording_id, receiver).await });
    }

    async fn start(self, recording_id: String, receiver: mpsc::UnboundedReceiver<Message>) {
        match self.prepare(&recording_id).await {
            Ok((agent, prefix, prompt_file)) => {
                if !self.has_session(&recording_id) {
                    let _ = std::fs::remove_file(&prompt_file);
                    self.forget(&recording_id);
                    return;
                }
                self.report(&recording_id, AgentLoopState::Idle);
                let scheduler = Scheduler {
                    call: CallContext {
                        fast_loop: self.clone(),
                        recording_id,
                        agent,
                        prefix: Arc::new(prefix),
                        prompt_file,
                    },
                    last_start: None,
                    new_since_last: false,
                    retry_at: None,
                    halt: None,
                };
                scheduler.run(receiver).await;
            }
            Err(state) => {
                // Only while the session is there: a state reported after
                // the recording ended would stick to it.
                let mut sessions = lock(&self.0.sessions);
                if let Some(session) = sessions.get_mut(&recording_id) {
                    session.waiting = Some(receiver);
                    self.report(&recording_id, state);
                } else {
                    drop(sessions);
                    self.forget(&recording_id);
                }
            }
        }
    }

    /// The agent, the prefix of the recording and its file.
    async fn prepare(
        &self,
        recording_id: &str,
    ) -> Result<(Arc<dyn Agent>, Prefix, PathBuf), AgentLoopState> {
        let agent = self.0.provider.provide().await?;
        let failed = |message: String| AgentLoopState::Error {
            message,
            retry_at: None,
        };
        let id = recording_id.to_owned();
        let rules = self.0.config.rules.clone();
        let prefix = database(&self.0.host, move |connection| {
            assembly::build_prefix_with_rules(connection, &id, &rules)
        })
        .await
        .map_err(|error| failed(format!("Не удалось собрать контекст звонка: {error}")))?;
        let prompt_file = assembly::write_prompt(&self.0.config.prompt_dir, recording_id, &prefix)
            .map_err(|error| failed(format!("Не удалось записать промпт агента: {error}")))?;
        Ok((agent, prefix, prompt_file))
    }
}

/// Runs `work` on the host's database off the async workers.
pub async fn database<T: Send + 'static>(
    host: &Arc<dyn LoopHost>,
    work: impl FnOnce(&Connection) -> CommandResult<T> + Send + 'static,
) -> CommandResult<T> {
    let host = Arc::clone(host);
    tokio::task::spawn_blocking(move || {
        let mut work = Some(work);
        let mut output = None;
        host.database(&mut |connection| {
            if let Some(work) = work.take() {
                output = Some(work(connection)?);
            }
            Ok(())
        })?;
        output.ok_or_else(|| CommandError::storage("База данных не ответила"))
    })
    .await
    .map_err(|error| CommandError::storage(error.to_string()))?
}

/// Why calls are stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Halt {
    NeedsLogin,
    /// Until the limit resets, when known.
    RateLimited {
        until: Option<Instant>,
    },
}

/// How a call ended, for the scheduler.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CallEnd {
    /// The patch (maybe empty) was applied.
    Done,
    Failed(String),
    NotLoggedIn,
    RateLimited {
        resets_at: Option<i64>,
    },
    /// The live pass ended, or the app exits.
    Cancelled,
}

/// What a call needs, shared by the scheduler and its calls.
#[derive(Clone)]
struct CallContext {
    fast_loop: FastLoop,
    recording_id: String,
    agent: Arc<dyn Agent>,
    prefix: Arc<Prefix>,
    prompt_file: PathBuf,
}

struct Scheduler {
    call: CallContext,
    last_start: Option<Instant>,
    /// Phrases came since the last call started (or it failed).
    new_since_last: bool,
    retry_at: Option<Instant>,
    halt: Option<Halt>,
}

/// Waits until `at`; forever without it.
async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn joined(call: &mut Option<JoinHandle<CallEnd>>) -> CallEnd {
    match call {
        Some(handle) => handle
            .await
            .unwrap_or_else(|error| CallEnd::Failed(format!("Вызов агента упал: {error}"))),
        None => std::future::pending().await,
    }
}

impl Scheduler {
    fn report(&self, state: AgentLoopState) {
        self.call.fast_loop.report(&self.call.recording_id, state);
    }

    async fn run(mut self, mut messages: mpsc::UnboundedReceiver<Message>) {
        let mut call: Option<JoinHandle<CallEnd>> = None;
        let mut stopping = false;
        while !(stopping && call.is_none()) {
            let idle = call.is_none() && !stopping;
            let retry_at = self.retry_at.filter(|_| idle && self.halt.is_none());
            let resets_at = match self.halt {
                Some(Halt::RateLimited { until }) if !stopping => until,
                _ => None,
            };
            tokio::select! {
                message = messages.recv(), if !stopping => match message {
                    Some(Message::Phrase(channel)) => {
                        if self.phrase_starts(channel, call.is_some()).await {
                            call = Some(self.start_call());
                        }
                    }
                    Some(Message::Retry) => {
                        if call.is_none() {
                            call = Some(self.start_call());
                        }
                    }
                    Some(Message::Resume) => {
                        if self.halt == Some(Halt::NeedsLogin) {
                            self.halt = None;
                            self.report(AgentLoopState::Idle);
                        }
                    }
                    Some(Message::Stop) | None => {
                        stopping = true;
                        self.call.fast_loop.cancel_call(&self.call.recording_id);
                    }
                },
                end = joined(&mut call) => {
                    call = None;
                    self.call.fast_loop.call_ended(&self.call.recording_id);
                    if !stopping {
                        self.finish(end);
                    }
                }
                () = sleep_until(retry_at) => call = Some(self.start_call()),
                () = sleep_until(resets_at) => {
                    self.halt = None;
                    self.report(AgentLoopState::Idle);
                }
            }
        }
        if let Err(error) = std::fs::remove_file(&self.call.prompt_file)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!(
                "grill: could not remove {}: {error}",
                self.call.prompt_file.display()
            );
        }
        self.call.fast_loop.forget(&self.call.recording_id);
    }

    /// The start rule: a phrase of «Остальные», no call running, not
    /// stopped or waiting for a retry, the interval passed.
    async fn phrase_starts(&mut self, channel: TranscriptChannel, busy: bool) -> bool {
        self.new_since_last = true;
        if channel != TranscriptChannel::Others
            || busy
            || self.halt.is_some()
            || self.retry_at.is_some()
        {
            return false;
        }
        let Some(last_start) = self.last_start else {
            return true;
        };
        let interval = database(&self.call.fast_loop.0.host, |connection| {
            Ok(settings::question_interval(&settings::get(connection)?))
        })
        .await
        .unwrap_or(DEFAULT_INTERVAL);
        last_start.elapsed() >= interval
    }

    fn start_call(&mut self) -> JoinHandle<CallEnd> {
        self.last_start = Some(Instant::now());
        self.new_since_last = false;
        self.retry_at = None;
        self.halt = None;
        self.report(AgentLoopState::Thinking);
        let (stop, stopped) = oneshot::channel();
        let process = TreeSlot::default();
        self.call.fast_loop.call_started(
            &self.call.recording_id,
            InFlight {
                stop,
                process: process.clone(),
            },
        );
        tokio::spawn(run_call(self.call.clone(), stopped, process))
    }

    fn finish(&mut self, end: CallEnd) {
        let retry_after = self.call.fast_loop.0.config.retry_after;
        match end {
            CallEnd::Done => self.report(AgentLoopState::Idle),
            CallEnd::Failed(message) => {
                self.new_since_last = true;
                self.retry_at = Some(Instant::now() + retry_after);
                let retry_ms = i64::try_from(retry_after.as_millis()).unwrap_or(i64::MAX);
                let now = self.call.fast_loop.0.host.now_ms();
                self.report(AgentLoopState::Error {
                    message,
                    retry_at: Some(now.saturating_add(retry_ms)),
                });
            }
            CallEnd::NotLoggedIn => {
                self.new_since_last = true;
                self.halt = Some(Halt::NeedsLogin);
                self.report(AgentLoopState::NeedsLogin);
            }
            CallEnd::RateLimited { resets_at } => {
                self.new_since_last = true;
                // The CLI's reset time is on the real wall clock, not the
                // host's.
                let until = resets_at.map(|resets_at| {
                    let wait = u64::try_from(resets_at.saturating_sub(now_ms())).unwrap_or(0);
                    Instant::now() + Duration::from_millis(wait)
                });
                self.halt = Some(Halt::RateLimited { until });
                self.report(AgentLoopState::RateLimited { resets_at });
            }
            // Only the end of the session cancels; it reports itself.
            CallEnd::Cancelled => self.new_since_last = true,
        }
    }
}

/// One call, start to end: it waits for the gate first, so calls of
/// different recordings never overlap. `stop` (or its sender dropped)
/// cancels it. Every call that reached the agent is recorded in
/// `agent_calls`.
async fn run_call(
    call: CallContext,
    mut stop: oneshot::Receiver<()>,
    process: TreeSlot,
) -> CallEnd {
    let fast_loop = &call.fast_loop;
    let host = &fast_loop.0.host;
    let config = &fast_loop.0.config;
    let gate = Arc::clone(&fast_loop.0.gate);
    let _permit = tokio::select! {
        permit = gate.acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => return CallEnd::Cancelled,
        },
        _ = &mut stop => return CallEnd::Cancelled,
    };
    let started_at = host.now_ms();
    let started = Instant::now();

    let (id, prefix) = (call.recording_id.clone(), Arc::clone(&call.prefix));
    let hints = config.state_hints;
    let assembled = match database(host, move |connection| {
        assembly::assemble(connection, &id, &prefix, started_at, hints)
    })
    .await
    {
        Ok(assembled) => assembled,
        Err(error) => {
            eprintln!(
                "grill: the agent call of {} was not assembled: {error}",
                call.recording_id
            );
            return CallEnd::Failed(format!("Не удалось собрать вызов агента: {error}"));
        }
    };

    let request = AgentRequest {
        system_prompt_file: call.prompt_file.clone(),
        user_message: assembled.user_message,
        schema: patch::schema_argument().to_owned(),
        process,
        options: CallOptions::default(),
    };
    let (cancel, cancelled) = oneshot::channel();
    let running = call.agent.run(request, cancelled);
    tokio::pin!(running);
    let interrupted = tokio::select! {
        reply = &mut running => Ok(reply),
        () = tokio::time::sleep(config.call_timeout) => Err(AgentError::Timeout),
        _ = &mut stop => Err(AgentError::Cancelled),
    };
    let reply = match interrupted {
        Ok(reply) => reply,
        Err(error) => {
            let _ = cancel.send(());
            let _ = tokio::time::timeout(config.cancel_wait, &mut running).await;
            Err(error)
        }
    };

    let mut record = AgentCallInput {
        recording_id: call.recording_id.clone(),
        started_at,
        duration_ms: i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
        ..AgentCallInput::default()
    };
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => {
            let (outcome, end) = match &error {
                AgentError::NotLoggedIn => (AgentCallOutcome::NotLoggedIn, CallEnd::NotLoggedIn),
                AgentError::RateLimited { resets_at } => (
                    AgentCallOutcome::RateLimited,
                    CallEnd::RateLimited {
                        resets_at: *resets_at,
                    },
                ),
                AgentError::Timeout => (
                    AgentCallOutcome::Timeout,
                    CallEnd::Failed(error.to_string()),
                ),
                AgentError::InvalidOutput(_) => (
                    AgentCallOutcome::Invalid,
                    CallEnd::Failed(error.to_string()),
                ),
                AgentError::Process(_) => {
                    (AgentCallOutcome::Error, CallEnd::Failed(error.to_string()))
                }
                AgentError::Cancelled => (AgentCallOutcome::Cancelled, CallEnd::Cancelled),
            };
            eprintln!(
                "grill: the agent call of {} failed: {error}",
                call.recording_id
            );
            record.outcome = Some(outcome);
            record.error = Some(error.to_string());
            save(host, record).await;
            return end;
        }
    };

    let usage = &reply.usage;
    fast_loop.note_utilization(usage.utilization);
    let tokens = |count: u64| Some(i64::try_from(count).unwrap_or(i64::MAX));
    record.duration_ms = i64::try_from(usage.duration_ms).unwrap_or(i64::MAX);
    record.input_tokens = tokens(usage.input_tokens);
    record.output_tokens = tokens(usage.output_tokens);
    record.cache_read = tokens(usage.cache_read);
    record.cache_write = tokens(usage.cache_write);
    record.cost_usd = usage.cost_usd;
    record.utilization = usage.utilization;

    let mut value = reply.patch;
    assembly::strip_id_prefixes(&mut value);
    let parsed = match Patch::from_value(value) {
        Ok(parsed) => parsed,
        Err(invalid) => {
            let message = AgentError::InvalidOutput(invalid.0).to_string();
            eprintln!("grill: the agent call of {}: {message}", call.recording_id);
            record.outcome = Some(AgentCallOutcome::Invalid);
            record.error = Some(message.clone());
            save(host, record).await;
            return CallEnd::Failed(message);
        }
    };
    let similarity = Arc::clone(&fast_loop.0.similarity);
    let checked = validate::validate(&parsed, &assembled.context, similarity.as_ref());

    // Checked again in the transaction that applies it: a quick action of
    // the manager during the call (the database is locked meanwhile) drops
    // only the steps it made stale.
    let id = call.recording_id.clone();
    let given = assembled.context;
    let now = host.now_ms();
    let applied = database(host, move |connection| {
        let mut has_ops = false;
        in_savepoint(connection, || {
            let fresh = given.with_state(&call_state::get(connection, &id)?);
            let validation = validate::recheck(&parsed, checked, &fresh, similarity.as_ref());
            for rejection in &validation.rejected {
                eprintln!("grill: the agent's operation was rejected ({id}): {rejection}");
            }
            has_ops = !validation.patch.ops.is_empty();
            record.rejected = validation.rejected_json();
            record.outcome = Some(if has_ops {
                AgentCallOutcome::Ok
            } else {
                AgentCallOutcome::Empty
            });
            call_state::apply_patch_at(connection, &id, &validation.patch, now)?;
            call_state::insert_agent_call_at(connection, &record, now)?;
            Ok(())
        })
        .or_else(|error| {
            // Nothing applied (the storage failed); the call is still
            // recorded.
            record.outcome = Some(AgentCallOutcome::Error);
            record.error = Some(error.to_string());
            call_state::insert_agent_call_at(connection, &record, now)?;
            Err(error)
        })?;
        Ok(has_ops)
    })
    .await;
    match applied {
        Ok(has_ops) => {
            if has_ops {
                host.call_state_changed(&call.recording_id);
            }
            CallEnd::Done
        }
        Err(error) => {
            eprintln!(
                "grill: the agent's patch for {} was not applied: {error}",
                call.recording_id
            );
            CallEnd::Failed(format!("Не удалось применить ответ агента: {error}"))
        }
    }
}

/// Records a call that brought no patch.
async fn save(host: &Arc<dyn LoopHost>, record: AgentCallInput) {
    let recording_id = record.recording_id.clone();
    let now = host.now_ms();
    let saved = database(host, move |connection| {
        call_state::insert_agent_call_at(connection, &record, now)
    })
    .await;
    if let Err(error) = saved {
        eprintln!("grill: the agent call of {recording_id} was not recorded: {error}");
    }
}

/// Runs `work` in a savepoint: the patch and its call record go together.
fn in_savepoint(
    connection: &Connection,
    work: impl FnOnce() -> CommandResult<()>,
) -> CommandResult<()> {
    connection.execute_batch("SAVEPOINT agent_call")?;
    match work() {
        Ok(()) => {
            connection.execute_batch("RELEASE agent_call")?;
            Ok(())
        }
        Err(error) => {
            if let Err(rollback) =
                connection.execute_batch("ROLLBACK TO agent_call; RELEASE agent_call")
            {
                eprintln!("grill: could not roll back the agent call: {rollback}");
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests;
