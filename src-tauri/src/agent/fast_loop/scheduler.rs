//! One scheduler per recording (design.md, decision 2): a task that hears
//! the live phrases and decides when the agent is called.
//!
//! A call is due once a phrase of «Остальные» came since the last call
//! started and no call runs (question-volume design.md, decision 1): when
//! the client finished a turn (a phrase of «Я» came after theirs), once the
//! least gap of `questionFrequency` passed since the last start; while the
//! manager is silent, once its interval passed. The first call of a
//! recording starts at the first phrase of «Остальные». The settings are
//! read at every phrase of «Остальные». A call due during another one, or
//! before its time, starts by itself when both are over, without waiting
//! for another phrase. After a failed call the next starts
//! by itself 30 s later (not before); `agent_retry` starts one at once.
//! `NotLoggedIn` stops the calls until a status check finds the agent ready;
//! `RateLimited` until the limit resets; then the next phrase of «Остальные»
//! starts one.
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
use serde_json::Value;
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
    topic_check,
    validate::{self, Validation},
};
use crate::{
    agent::{
        claude_cli::{
            self, Agent, AgentError, AgentReply, AgentRequest, CallOptions, OutputKind, Usage,
        },
        halt::{AgentHalt, Halted},
        limit::{LimitHit, SubscriptionLimit},
        process::TreeSlot,
    },
    error::{CommandError, CommandResult},
    storage::{
        call_state::{
            self, AgentCallInput, AgentCallKind, AgentCallOutcome, AppliedPatch, CallTrigger,
            ValidatedOp, ValidatedPatch,
        },
        journal::{CallOp, PromptPart},
        new_id, now_ms, recordings, settings,
        transcript::{self, TranscriptChannel, TranscriptPass},
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
    /// Whole minutes without a new question before the pause line shows:
    /// [`assembly::QUIET_MINUTES`] in the app; a replay may try another
    /// value (`grill-eval replay --quiet-minutes`, question-quality task 4.4).
    pub quiet_minutes: i64,
    /// The least gap between call starts instead of `questionFrequency`'s:
    /// none in the app; a replay may try one (`grill-eval replay --min-gap`).
    pub min_gap: Option<Duration>,
    /// When the topic is checked (question-volume design.md, decision 2);
    /// `None` never. A replay may try others (`grill-eval replay
    /// --topic-check`).
    pub topic_check: Option<TopicCheckConfig>,
    /// The share of the subscription limit, whose thresholds stop the calls
    /// (agent-limit-guard design.md, decision 5): the app's in the app; a
    /// fresh one, with no measures, never stops them.
    pub limit: SubscriptionLimit,
}

/// When the topic check runs and what it reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopicCheckConfig {
    /// The current topic has gone on at least this long…
    pub after: Duration,
    /// … and the last check was at least this long ago.
    pub every: Duration,
    /// The transcript it reads.
    pub window: Duration,
}

impl Default for TopicCheckConfig {
    fn default() -> Self {
        Self {
            after: Duration::from_secs(8 * 60),
            every: Duration::from_secs(3 * 60),
            window: topic_check::WINDOW,
        }
    }
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
            quiet_minutes: assembly::QUIET_MINUTES,
            min_gap: None,
            topic_check: Some(TopicCheckConfig::default()),
            limit: SubscriptionLimit::default(),
        }
    }
}

/// When `questionFrequency` can't be read: `normal`'s.
const DEFAULT_GAP: Duration = Duration::from_secs(5);
const DEFAULT_INTERVAL: Duration = Duration::from_secs(20);

#[derive(Debug)]
enum Message {
    /// A live phrase and its segment's id.
    Phrase(TranscriptChannel, Option<String>),
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
    /// «Нужен вход» and the subscription limit, shared with the slow loop
    /// (agent-slow-loop design.md, decision 1).
    halt: AgentHalt,
    /// Told the recording whose current topic a call changed (the slow
    /// loop searches for the new topic).
    topic_listener: Mutex<Option<TopicListener>>,
}

/// Told the recording whose current topic changed.
pub type TopicListener = Arc<dyn Fn(&str) + Send + Sync>;

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
            halt: AgentHalt::default(),
            topic_listener: Mutex::new(None),
        }))
    }

    /// The halt the slow loop shares with this loop.
    pub fn halt(&self) -> AgentHalt {
        self.0.halt.clone()
    }

    /// `listener` hears of every change of a recording's current topic
    /// that a call or a topic check applied.
    pub fn on_topic_changed(&self, listener: TopicListener) {
        *lock(&self.0.topic_listener) = Some(listener);
    }

    fn topic_changed(&self, recording_id: &str) {
        let listener = lock(&self.0.topic_listener).clone();
        if let Some(listener) = listener {
            listener(recording_id);
        }
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
    #[cfg(test)]
    pub fn phrase(&self, recording_id: &str, channel: TranscriptChannel) {
        self.send(recording_id, Message::Phrase(channel, None));
    }

    /// A live phrase of `recording_id` was stored as segment `segment_id`:
    /// the last of «Остальные» is the trigger of the next call
    /// (call-analytics design.md, decision 3).
    pub fn phrase_with_id(&self, recording_id: &str, channel: TranscriptChannel, segment_id: &str) {
        self.send(
            recording_id,
            Message::Phrase(channel, Some(segment_id.to_owned())),
        );
    }

    /// The live pass of `recording_id` is over: the running call, if any,
    /// is cancelled, and no other starts.
    pub fn live_finished(&self, recording_id: &str) {
        // «Сверх лимита» was for this recording only.
        self.0.config.limit.forget(recording_id);
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
            // `stop` before the kill: the call sees its CLI die only once it
            // is cancelled, and is recorded so (see `ask`).
            let _ = call.stop.send(());
            call.process.kill();
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
        self.0.halt.clear_login();
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
            Ok((agent, prefix, prompt_file, topic_prompt_file)) => {
                if !self.has_session(&recording_id) {
                    let _ = std::fs::remove_file(&prompt_file);
                    self.forget(&recording_id);
                    return;
                }
                self.report(&recording_id, AgentLoopState::Idle);
                let mut scheduler = Scheduler {
                    call: CallContext {
                        fast_loop: self.clone(),
                        recording_id,
                        agent,
                        prefix: Arc::new(prefix),
                        prompt_file,
                        topic_prompt_file,
                        topic_clock: Arc::default(),
                    },
                    last_start: None,
                    client_since_last: false,
                    turn_ended: false,
                    gap: DEFAULT_GAP,
                    interval: DEFAULT_INTERVAL,
                    retry_at: None,
                    halt: None,
                    last_client_segment: None,
                    after_halt: false,
                };
                // «Начать без агента»: a threshold reached before the call
                // stops it from the start.
                scheduler.adopt_grill_limit();
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
    ) -> Result<(Arc<dyn Agent>, Prefix, PathBuf, Option<PathBuf>), AgentLoopState> {
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
        let topic_prompt_file = match self.0.config.topic_check {
            Some(_) => Some(
                topic_check::write_prompt(&self.0.config.prompt_dir).map_err(|error| {
                    failed(format!("Не удалось записать промпт проверки темы: {error}"))
                })?,
            ),
            None => None,
        };
        Ok((agent, prefix, prompt_file, topic_prompt_file))
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
    /// A threshold of Grill, until it lets go or the recording goes past
    /// it (agent-limit-guard design.md, decision 5).
    GrillLimit,
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
    /// The topic check's prompt; `None` when it is off.
    topic_prompt_file: Option<PathBuf>,
    topic_clock: Arc<Mutex<TopicClock>>,
}

/// How long the current topic goes on, as the calls saw it: the storage
/// keeps when a topic was created, not when the call switched back to it.
#[derive(Debug, Default)]
struct TopicClock {
    topic_id: Option<String>,
    /// When the calls first saw it current (host ms).
    since_ms: i64,
    last_check_ms: Option<i64>,
}

impl TopicClock {
    /// The current topic is `topic_id` at `now`: a new one starts over.
    fn observe(&mut self, topic_id: Option<&str>, now: i64) {
        if self.topic_id.as_deref() != topic_id {
            self.topic_id = topic_id.map(str::to_owned);
            self.since_ms = now;
            self.last_check_ms = None;
        }
    }
}

struct Scheduler {
    call: CallContext,
    last_start: Option<Instant>,
    /// A phrase of «Остальные» came since the last call started: the next
    /// call is due once the gap passes and no call runs.
    client_since_last: bool,
    /// A phrase of «Я» came after the client's since the last start: the
    /// client finished a turn.
    turn_ended: bool,
    /// The least gap between starts after a turn, as last read.
    gap: Duration,
    /// The gap between starts while the manager is silent, as last read.
    interval: Duration,
    retry_at: Option<Instant>,
    halt: Option<Halt>,
    /// The last phrase of «Остальные»: the next call's trigger.
    last_client_segment: Option<String>,
    /// A halt ended since the last start: the next call says so.
    after_halt: bool,
}

/// Why a call started and the phrase that led to it, for the journal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cause {
    trigger: CallTrigger,
    segment_id: Option<String>,
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
        let mut limit_news = self.call.fast_loop.0.config.limit.subscribe();
        while !(stopping && call.is_none()) {
            let idle = call.is_none() && !stopping;
            let retry_at = self.retry_at.filter(|_| idle && self.halt.is_none());
            let resets_at = match self.halt {
                Some(Halt::RateLimited { until }) if !stopping => until,
                _ => None,
            };
            let due_at = self.due_at().filter(|_| idle);
            tokio::select! {
                message = messages.recv(), if !stopping => match message {
                    Some(Message::Phrase(channel, segment_id)) => {
                        self.phrase(channel, segment_id).await;
                    }
                    Some(Message::Retry) => {
                        if call.is_none() {
                            // The user asks for a call: whatever stopped
                            // them is tried again, but a threshold of Grill
                            // lets go only by itself or «сверх лимита».
                            self.call.fast_loop.0.halt.clear();
                            self.halt = self.halt.filter(|halt| *halt == Halt::GrillLimit);
                            if !self.adopt_grill_limit() {
                                call = Some(self.start_call(CallTrigger::ManualRetry));
                            }
                        }
                    }
                    Some(Message::Resume) => {
                        if self.halt == Some(Halt::NeedsLogin) {
                            self.halt = None;
                            self.after_halt = true;
                            // The phrases of the halt wait for the next one.
                            self.client_since_last = false;
                            self.turn_ended = false;
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
                        // Its limit event may have reached a threshold.
                        if self.halt.is_none() {
                            self.adopt_grill_limit();
                        }
                    }
                }
                Ok(()) = limit_news.changed(), if !stopping => {
                    self.limit_changed(call.is_none());
                }
                () = sleep_until(retry_at) => {
                    if !self.adopt_halt() {
                        call = Some(self.start_call(CallTrigger::Retry));
                    }
                }
                () = sleep_until(due_at) => {
                    if !self.adopt_halt() {
                        let trigger = self.due_trigger();
                        call = Some(self.start_call(trigger));
                    }
                }
                () = sleep_until(resets_at) => {
                    self.halt = None;
                    self.after_halt = true;
                    self.client_since_last = false;
                    self.turn_ended = false;
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

    /// The threshold of Grill that stops this recording's calls now.
    fn grill_limit(&self) -> Option<LimitHit> {
        self.call
            .fast_loop
            .0
            .config
            .limit
            .blocks(&self.call.recording_id)
    }

    /// A threshold of Grill stops the calls: the loop stops and says so.
    /// `true` when it did.
    fn adopt_grill_limit(&mut self) -> bool {
        let Some(hit) = self.grill_limit() else {
            return false;
        };
        self.halt = Some(Halt::GrillLimit);
        self.report_changed(AgentLoopState::GrillLimit { hit });
        true
    }

    /// The share of the limit, the thresholds or the recording's «сверх
    /// лимита» changed: a threshold that let go resumes the calls, and the
    /// conversation of the pause goes into the next one; one reached while
    /// no call runs stops them now.
    fn limit_changed(&mut self, idle: bool) {
        match (self.halt, self.grill_limit()) {
            (Some(Halt::GrillLimit), None) => {
                self.halt = None;
                self.after_halt = true;
                self.report(AgentLoopState::Idle);
            }
            (Some(Halt::GrillLimit), Some(hit)) => {
                self.report_changed(AgentLoopState::GrillLimit { hit });
            }
            (None, Some(_)) if idle => {
                self.adopt_grill_limit();
            }
            _ => {}
        }
    }

    /// [`Self::report`] unless the windows have this state already.
    fn report_changed(&self, state: AgentLoopState) {
        if self.call.fast_loop.status(&self.call.recording_id).state != state {
            self.report(state);
        }
    }

    /// A call of the slow loop stopped the calls (agent-slow-loop design.md,
    /// decision 1), or a threshold of Grill did: this loop stops too, and
    /// says so, instead of starting one. `true` when it did.
    fn adopt_halt(&mut self) -> bool {
        if self.halt.is_some() {
            return false;
        }
        let Some(halted) = self.call.fast_loop.0.halt.active() else {
            return self.adopt_grill_limit();
        };
        match halted {
            Halted::NeedsLogin => {
                self.halt = Some(Halt::NeedsLogin);
                self.report(AgentLoopState::NeedsLogin);
            }
            Halted::RateLimited { until, resets_at } => {
                self.halt = Some(Halt::RateLimited { until });
                self.report(AgentLoopState::RateLimited { resets_at });
            }
        }
        true
    }

    /// A phrase came: one of «Остальные» makes a call due (and reads the
    /// settings again); one of «Я» after it ends the client's turn.
    async fn phrase(&mut self, channel: TranscriptChannel, segment_id: Option<String>) {
        if channel == TranscriptChannel::Me {
            self.turn_ended |= self.client_since_last;
            return;
        }
        if segment_id.is_some() {
            self.last_client_segment = segment_id;
        }
        self.client_since_last = true;
        self.turn_ended = false;
        let (gap, interval) = database(&self.call.fast_loop.0.host, |connection| {
            let settings = settings::get(connection)?;
            Ok((
                settings::question_gap(&settings),
                settings::question_interval(&settings),
            ))
        })
        .await
        .unwrap_or((DEFAULT_GAP, DEFAULT_INTERVAL));
        self.gap = self.call.fast_loop.0.config.min_gap.unwrap_or(gap);
        self.interval = interval;
    }

    /// When the next call is due, while no call runs: a phrase of
    /// «Остальные» came since the last start, nothing stops the calls, no
    /// retry is waited for; at once for the first call, else once the gap
    /// (the client finished a turn) or the interval passed since the last
    /// start.
    fn due_at(&self) -> Option<Instant> {
        if !self.client_since_last || self.halt.is_some() || self.retry_at.is_some() {
            return None;
        }
        let wait = if self.turn_ended {
            self.gap
        } else {
            self.interval
        };
        Some(
            self.last_start
                .map_or_else(Instant::now, |last| last + wait),
        )
    }

    /// Why the call [`Self::due_at`] made due starts: the first of the
    /// recording, the first after a halt, the client's turn or the interval.
    fn due_trigger(&self) -> CallTrigger {
        if self.last_start.is_none() {
            CallTrigger::FirstPhrase
        } else if self.after_halt {
            CallTrigger::HaltReset
        } else if self.turn_ended {
            CallTrigger::TurnEnd
        } else {
            CallTrigger::Interval
        }
    }

    fn start_call(&mut self, trigger: CallTrigger) -> JoinHandle<CallEnd> {
        let cause = Cause {
            trigger,
            segment_id: self.last_client_segment.clone(),
        };
        self.after_halt = false;
        self.last_start = Some(Instant::now());
        self.client_since_last = false;
        self.turn_ended = false;
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
        tokio::spawn(run_call(self.call.clone(), cause, stopped, process))
    }

    fn finish(&mut self, end: CallEnd) {
        let retry_after = self.call.fast_loop.0.config.retry_after;
        let shared = &self.call.fast_loop.0.halt;
        match end {
            CallEnd::Done => {
                shared.clear();
                self.report(AgentLoopState::Idle);
            }
            CallEnd::Failed(message) => {
                self.retry_at = Some(Instant::now() + retry_after);
                let retry_ms = i64::try_from(retry_after.as_millis()).unwrap_or(i64::MAX);
                let now = self.call.fast_loop.0.host.now_ms();
                self.report(AgentLoopState::Error {
                    message,
                    retry_at: Some(now.saturating_add(retry_ms)),
                });
            }
            CallEnd::NotLoggedIn => {
                self.halt = Some(Halt::NeedsLogin);
                shared.set(Halted::NeedsLogin);
                self.report(AgentLoopState::NeedsLogin);
            }
            CallEnd::RateLimited { resets_at } => {
                // The CLI's reset time is on the real wall clock, not the
                // host's.
                let until = resets_at.map(|resets_at| {
                    let wait = u64::try_from(resets_at.saturating_sub(now_ms())).unwrap_or(0);
                    Instant::now() + Duration::from_millis(wait)
                });
                self.halt = Some(Halt::RateLimited { until });
                shared.set(Halted::RateLimited { until, resets_at });
                self.report(AgentLoopState::RateLimited { resets_at });
            }
            // Only the end of the session cancels; it reports itself.
            CallEnd::Cancelled => {}
        }
    }
}

/// One call, start to end: it waits for the gate first, so calls of
/// different recordings never overlap. `stop` (or its sender dropped)
/// cancels it. Every call that reached the agent is recorded in
/// `agent_calls`.
async fn run_call(
    call: CallContext,
    cause: Cause,
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
    if let Some(end) = run_topic_check(&call, &cause, &mut stop, &process).await {
        return end;
    }
    // Made before the patch is applied: the journal points at it
    // (call-analytics design.md, decision 1).
    let call_id = new_id();
    let started_at = host.now_ms();
    let started = Instant::now();

    let (id, prefix) = (call.recording_id.clone(), Arc::clone(&call.prefix));
    let hints = config.state_hints.then_some(config.quiet_minutes);
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

    let mut prompt = vec![PromptPart::new("file", call.prefix.text.clone())];
    prompt.extend(assembled.parts.iter().cloned());
    let request = AgentRequest {
        system_prompt_file: call.prompt_file.clone(),
        user_message: assembled.user_message,
        schema: patch::schema_argument().to_owned(),
        process,
        options: CallOptions::default(),
    };
    let reply = ask(&call, request, &mut stop).await;

    let mut record = AgentCallInput {
        id: Some(call_id),
        recording_id: call.recording_id.clone(),
        started_at,
        duration_ms: i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
        prompt,
        trigger: Some(cause.trigger),
        trigger_segment_id: cause.segment_id.clone(),
        window_segments: Some(
            assembled
                .context
                .segments
                .iter()
                .map(|segment| segment.id.clone())
                .collect(),
        ),
        // The findings in the order the prompt numbers them `D1…Dn`.
        findings_in_prompt: Some(
            assembled
                .context
                .documents
                .iter()
                .filter_map(|document| assembled.context.document_ids.get(&document.id).cloned())
                .collect(),
        ),
        ..AgentCallInput::default()
    };
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => {
            let (outcome, end) = failure(&error);
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

    fast_loop.note_utilization(reply.usage.utilization);
    with_usage(&mut record, &reply.usage);
    record.raw_reply = Some(reply.raw);
    record.reply = Some(reply.patch.clone());

    let mut value = reply.patch;
    assembly::strip_id_prefixes(&mut value);
    let op_values = value
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
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
        let mut changed = false;
        let mut topic_changed = false;
        in_savepoint(connection, || {
            let before = call_state::get(connection, &id)?;
            let fresh = given.with_state(&before);
            let validation = validate::recheck(&parsed, checked, &fresh, similarity.as_ref());
            for rejection in &validation.rejected {
                eprintln!("grill: the agent's operation was rejected ({id}): {rejection}");
            }
            let has_ops = !validation.patch.ops.is_empty();
            record.rejected = validation.rejected_json();
            record.outcome = Some(if has_ops {
                AgentCallOutcome::Ok
            } else {
                AgentCallOutcome::Empty
            });
            let applied = call_state::apply_patch_by(
                connection,
                &id,
                &validation.patch,
                now,
                record.id.as_deref(),
            )?;
            record.ops = journal_ops(&op_values, &validation, &applied);
            let moves_topic = validation.patch.ops.iter().any(|op| {
                matches!(
                    op,
                    ValidatedOp::CreateTopic { .. } | ValidatedOp::SwitchTopic { .. }
                )
            });
            if moves_topic {
                let after = call_state::get(connection, &id)?.current_topic_id;
                topic_changed = after != before.current_topic_id;
            }
            // An empty patch writes nothing, but time passed: a question
            // visible too long may give its place (question-volume design.md,
            // decision 3).
            changed = has_ops || call_state::recompute_visible_at(connection, &id, now)?;
            call_state::insert_agent_call_at(connection, &record, now)?;
            Ok(())
        })
        .or_else(|error| {
            // Nothing applied (the storage failed); the call is still
            // recorded, its operations as not applied.
            record.outcome = Some(AgentCallOutcome::Error);
            record.error = Some(error.to_string());
            record.ops = not_applied(&op_values, &serde_json::json!({ "reason": "storage" }));
            call_state::insert_agent_call_at(connection, &record, now)?;
            Err(error)
        })?;
        Ok((changed, topic_changed))
    })
    .await;
    match applied {
        Ok((changed, topic_changed)) => {
            if changed {
                host.call_state_changed(&call.recording_id);
            }
            if topic_changed {
                fast_loop.topic_changed(&call.recording_id);
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

/// The operations of a reply as the journal keeps them: each applied one
/// with what it created or changed, each rejected one with its reason.
fn journal_ops(values: &[Value], validation: &Validation, applied: &AppliedPatch) -> Vec<CallOp> {
    values
        .iter()
        .enumerate()
        .map(|(index, body)| {
            let accepted = validation.indices.iter().position(|&at| at == index);
            let rejection = validation
                .rejected
                .iter()
                .find(|rejection| rejection.index == index);
            CallOp {
                op: op_name(body),
                body: body.clone(),
                applied: accepted.is_some(),
                reason: rejection.and_then(|rejection| serde_json::to_value(rejection).ok()),
                subject: accepted.and_then(|at| applied.subjects.get(at).cloned().flatten()),
            }
        })
        .collect()
}

/// The operations of a reply none of which was applied, for `reason`.
fn not_applied(values: &[Value], reason: &Value) -> Vec<CallOp> {
    values
        .iter()
        .map(|body| CallOp {
            op: op_name(body),
            body: body.clone(),
            applied: false,
            reason: Some(reason.clone()),
            subject: None,
        })
        .collect()
}

fn op_name(body: &Value) -> String {
    body.get("op")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned()
}

/// Runs `request` on the agent: cancelled by `stop` or the call timeout.
async fn ask(
    call: &CallContext,
    request: AgentRequest,
    stop: &mut oneshot::Receiver<()>,
) -> Result<AgentReply, AgentError> {
    let config = &call.fast_loop.0.config;
    let (cancel, cancelled) = oneshot::channel();
    let running = call.agent.run(request, cancelled);
    tokio::pin!(running);
    // `stop` first: the app's exit sends it and then kills the CLI, so a reply
    // that ended with the process is a cancellation, not an error.
    let interrupted = tokio::select! {
        biased;
        _ = &mut *stop => Err(AgentError::Cancelled),
        reply = &mut running => Ok(reply),
        () = tokio::time::sleep(config.call_timeout) => Err(AgentError::Timeout),
    };
    match interrupted {
        Ok(reply) => reply,
        Err(error) => {
            let _ = cancel.send(());
            let _ = tokio::time::timeout(config.cancel_wait, &mut running).await;
            Err(error)
        }
    }
}

/// How a failed agent call is recorded.
pub(crate) fn outcome_of(error: &AgentError) -> AgentCallOutcome {
    failure(error).0
}

/// How a failed agent call is recorded and what the scheduler does next.
fn failure(error: &AgentError) -> (AgentCallOutcome, CallEnd) {
    match error {
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
        AgentError::Process(_) => (AgentCallOutcome::Error, CallEnd::Failed(error.to_string())),
        AgentError::Cancelled => (AgentCallOutcome::Cancelled, CallEnd::Cancelled),
    }
}

/// The reply's tokens, cost and time into its record.
pub(crate) fn with_usage(record: &mut AgentCallInput, usage: &Usage) {
    let tokens = |count: u64| Some(i64::try_from(count).unwrap_or(i64::MAX));
    record.duration_ms = i64::try_from(usage.duration_ms).unwrap_or(i64::MAX);
    record.input_tokens = tokens(usage.input_tokens);
    record.output_tokens = tokens(usage.output_tokens);
    record.cache_read = tokens(usage.cache_read);
    record.cache_write = tokens(usage.cache_write);
    record.cost_usd = usage.cost_usd;
    record.utilization = usage.utilization;
}

/// The topic check before a fast-loop call, when it is due (question-volume
/// design.md, decision 2): the current topic has gone on for
/// `TopicCheckConfig::after`, the last check was `every` ago, and the
/// client spoke since. A new topic or a switch is applied like the fast
/// loop's `topic` operation. `Some` when the slot must end here (the agent
/// is not signed in, the limit is used up, the call was cancelled); any
/// other failure leaves the topic as it is and the fast-loop call goes on.
async fn run_topic_check(
    call: &CallContext,
    cause: &Cause,
    stop: &mut oneshot::Receiver<()>,
    process: &TreeSlot,
) -> Option<CallEnd> {
    let fast_loop = &call.fast_loop;
    let host = &fast_loop.0.host;
    let settings = fast_loop.0.config.topic_check?;
    let prompt_file = call.topic_prompt_file.clone()?;
    let now = host.now_ms();
    let id = call.recording_id.clone();
    let observed = database(host, move |connection| {
        let state = call_state::get(connection, &id)?;
        let started_at = recordings::get(connection, &id)?.started_at;
        let last_client = transcript::for_recording(connection, &id)?
            .iter()
            .filter(|segment| {
                segment.pass == TranscriptPass::Live && segment.channel == TranscriptChannel::Others
            })
            .map(|segment| started_at + segment.end_ms)
            .max();
        Ok((
            state.current_topic_id,
            state.final_check.is_some(),
            last_client,
        ))
    })
    .await;
    let (topic_id, final_check, last_client) = match observed {
        Ok(observed) => observed,
        Err(error) => {
            eprintln!(
                "grill: the topic of {} was not read: {error}",
                call.recording_id
            );
            return None;
        }
    };
    let ms = |duration: Duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX);
    let minutes = {
        let mut clock = lock(&call.topic_clock);
        clock.observe(topic_id.as_deref(), now);
        let due = topic_id.is_some()
            && !final_check
            && now - clock.since_ms >= ms(settings.after)
            && clock
                .last_check_ms
                .is_none_or(|last| now - last >= ms(settings.every))
            && last_client.is_some_and(|at| at > clock.last_check_ms.unwrap_or(clock.since_ms));
        if !due {
            return None;
        }
        clock.last_check_ms = Some(now);
        (now - clock.since_ms) / 60_000
    };

    let id = call.recording_id.clone();
    let window = settings.window;
    let assembled = match database(host, move |connection| {
        topic_check::assemble(connection, &id, minutes, window)
    })
    .await
    {
        Ok(assembled) => assembled,
        Err(error) => {
            eprintln!(
                "grill: the topic check of {} was not assembled: {error}",
                call.recording_id
            );
            return None;
        }
    };
    let call_id = new_id();
    let started_at = host.now_ms();
    let started = Instant::now();
    let mut prompt = vec![PromptPart::new("file", topic_check::PROMPT)];
    prompt.extend(assembled.parts.iter().cloned());
    let request = AgentRequest {
        system_prompt_file: prompt_file,
        user_message: assembled.user_message.clone(),
        schema: topic_check::SCHEMA.to_owned(),
        process: process.clone(),
        // Not a patch: the CLI must not ask for `ops`.
        options: CallOptions {
            output: OutputKind::Object,
            ..CallOptions::default()
        },
    };
    let reply = ask(call, request, stop).await;
    let mut record = AgentCallInput {
        id: Some(call_id),
        prompt,
        recording_id: call.recording_id.clone(),
        kind: AgentCallKind::TopicCheck,
        started_at,
        duration_ms: i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX),
        trigger: Some(cause.trigger),
        trigger_segment_id: cause.segment_id.clone(),
        window_segments: Some(assembled.window.clone()),
        ..AgentCallInput::default()
    };
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => {
            let (outcome, end) = failure(&error);
            eprintln!(
                "grill: the topic check of {} failed: {error}",
                call.recording_id
            );
            record.outcome = Some(outcome);
            record.error = Some(error.to_string());
            save(host, record).await;
            return match end {
                CallEnd::Failed(_) | CallEnd::Done => None,
                end => Some(end),
            };
        }
    };
    fast_loop.note_utilization(reply.usage.utilization);
    with_usage(&mut record, &reply.usage);
    record.raw_reply = Some(reply.raw);
    record.reply = Some(reply.patch.clone());
    let decision = match topic_check::parse(&reply.patch) {
        Ok(decision) => decision,
        Err(reason) => {
            let message = AgentError::InvalidOutput(reason).to_string();
            eprintln!("grill: the topic check of {}: {message}", call.recording_id);
            record.outcome = Some(AgentCallOutcome::Invalid);
            record.error = Some(message);
            save(host, record).await;
            return None;
        }
    };

    let id = call.recording_id.clone();
    let now = host.now_ms();
    let applied = database(host, move |connection| {
        let mut current = None;
        in_savepoint(connection, || {
            let state = call_state::get(connection, &id)?;
            let body = record.reply.clone().unwrap_or(Value::Null);
            let decided = body
                .get("decision")
                .and_then(Value::as_str)
                .unwrap_or("same")
                .to_owned();
            let mut journaled = CallOp {
                op: decided,
                body,
                applied: false,
                reason: None,
                subject: None,
            };
            let op = match topic_check::check(&decision, &assembled, &state) {
                Ok(op) => op,
                Err(reason) => {
                    eprintln!("grill: the topic check's answer was rejected ({id}): {reason}");
                    let mut rejected = serde_json::to_value(&reason).unwrap_or(Value::Null);
                    if let Value::Object(fields) = &mut rejected {
                        fields.insert("op".to_owned(), Value::from("topic"));
                    }
                    record.rejected = Value::Array(vec![rejected.clone()]);
                    journaled.reason = Some(rejected);
                    None
                }
            };
            record.outcome = Some(if op.is_some() {
                AgentCallOutcome::Ok
            } else {
                AgentCallOutcome::Empty
            });
            if let Some(op) = op {
                let applied = call_state::apply_patch_by(
                    connection,
                    &id,
                    &ValidatedPatch { ops: vec![op] },
                    now,
                    record.id.as_deref(),
                )?;
                journaled.applied = true;
                journaled.subject = applied.subjects.into_iter().next().flatten();
                current = call_state::get(connection, &id)?.current_topic_id;
            }
            record.ops = vec![journaled];
            call_state::insert_agent_call_at(connection, &record, now)?;
            Ok(())
        })?;
        Ok(current)
    })
    .await;
    match applied {
        Ok(Some(topic_id)) => {
            lock(&call.topic_clock).observe(Some(&topic_id), now);
            host.call_state_changed(&call.recording_id);
            fast_loop.topic_changed(&call.recording_id);
        }
        Ok(None) => {}
        Err(error) => {
            eprintln!(
                "grill: the topic check of {} was not applied: {error}",
                call.recording_id
            );
        }
    }
    None
}

/// Records a call that brought no patch.
pub(crate) async fn save(host: &Arc<dyn LoopHost>, record: AgentCallInput) {
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
pub(crate) fn in_savepoint(
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
