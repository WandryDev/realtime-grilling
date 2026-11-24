//! The slow loop's scheduler (agent-slow-loop design.md, decision 1): one
//! [`SlowLoop`] in the app, a task per recording whose live pass runs, its
//! own gate of one call at a time across recordings, apart from the fast
//! loop's: a slow call never waits for a fast one, nor holds it up.
//!
//! At the start of the live pass the index of the project's ready sources
//! is built (off the async workers) and the prompt file written; a project
//! without a ready source gets no calls at all. Then a call is due:
//! - when the current topic changes (the fast loop says so), at once;
//! - once [`SlowConfig::every`] passed since the last call started (the
//!   first: since the recording started), if the client said at least
//!   [`SlowConfig::min_words`] words in «Остальные» since then.
//!
//! A call due during another one starts after it. After a failed call the
//! next waits [`SlowConfig::retry_after`]. «Нужен вход» and the limit stop
//! both loops ([`AgentHalt`]). The end of the live pass cancels the running
//! call and its findings are not stored; the app's exit also kills its
//! CLI's process tree.
//!
//! A call: wait for the gate → read the state and the transcript → search
//! with the agent's previous queries and the client's last minute → no
//! candidates: an `empty` call without a process → run the agent → parse →
//! check → in one transaction check again, store the findings and the call
//! → `CallStateChanged`. The windows see the search in
//! `CallState.contextSearch`; the agent's state (`AgentStatus`) is the fast
//! loop's alone.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use tokio::{
    runtime::Handle,
    sync::{Semaphore, mpsc, oneshot},
    task::JoinHandle,
    time::Instant,
};

use super::{
    assembly,
    search::{Candidate, Index},
    validate::{self, Reply, SlowContext, SlowRejectReason, SlowRejection},
};
use crate::{
    agent::{
        claude_cli::{self, Agent, AgentError, AgentRequest, CallOptions, OutputKind},
        fast_loop::scheduler::{AgentProvider, LoopHost, database, in_savepoint, save, with_usage},
        halt::{AgentHalt, Halted},
        process::TreeSlot,
    },
    storage::{
        call_state::{
            self, AgentCallInput, AgentCallKind, AgentCallOutcome, CallTrigger, QuestionStatus,
        },
        context_findings::{self, ContextSearch, Inserted, NewFinding},
        journal::{self, CallOp, PromptPart, SubjectKind},
        new_id, now_ms, recordings, sources,
        transcript::{self, TranscriptChannel},
    },
};

#[derive(Debug, Clone)]
pub struct SlowConfig {
    /// Where the prompt files go: the CLI's work dir.
    pub prompt_dir: PathBuf,
    /// The least time between the starts of calls the client's words make
    /// due; the first from the start of the recording.
    pub every: Duration,
    /// The client's words in «Остальные» since the last call started that
    /// make the next one due.
    pub min_words: usize,
    /// After a failed call.
    pub retry_after: Duration,
    /// A call still running then is cancelled.
    pub call_timeout: Duration,
    /// How long a cancelled call may take to stop.
    pub cancel_wait: Duration,
}

impl SlowConfig {
    pub fn new(prompt_dir: impl Into<PathBuf>) -> Self {
        Self {
            prompt_dir: prompt_dir.into(),
            every: Duration::from_secs(60),
            min_words: 15,
            retry_after: Duration::from_secs(60),
            call_timeout: claude_cli::TIMEOUT + Duration::from_secs(2),
            cancel_wait: Duration::from_secs(5),
        }
    }
}

#[derive(Debug)]
enum Message {
    /// Words of «Остальные» and their segment's id.
    ClientWords(usize, Option<String>),
    TopicChanged,
    /// A status check found the agent ready.
    Resume,
    Stop,
}

struct InFlight {
    stop: oneshot::Sender<()>,
    process: TreeSlot,
}

struct Inner {
    host: Arc<dyn LoopHost>,
    provider: Arc<dyn AgentProvider>,
    runtime: Handle,
    config: SlowConfig,
    halt: AgentHalt,
    /// The recordings whose live pass runs.
    sessions: Mutex<HashMap<String, mpsc::UnboundedSender<Message>>>,
    /// The search of each recording whose scheduler runs.
    searches: Mutex<HashMap<String, ContextSearch>>,
    /// One slow call at a time across recordings; closed by the app's exit.
    gate: Arc<Semaphore>,
    in_flight: Mutex<HashMap<String, InFlight>>,
    closed: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The slow loop of the app. Managed as Tauri state; cheap to clone.
#[derive(Clone)]
pub struct SlowLoop(Arc<Inner>);

impl SlowLoop {
    /// Schedulers run on `runtime`; `halt` is the fast loop's.
    pub fn new(
        host: Arc<dyn LoopHost>,
        provider: Arc<dyn AgentProvider>,
        runtime: Handle,
        config: SlowConfig,
        halt: AgentHalt,
    ) -> Self {
        Self(Arc::new(Inner {
            host,
            provider,
            runtime,
            config,
            halt,
            sessions: Mutex::new(HashMap::new()),
            searches: Mutex::new(HashMap::new()),
            gate: Arc::new(Semaphore::new(1)),
            in_flight: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
        }))
    }

    /// The live pass of `recording_id` started: its index is built and its
    /// scheduler runs, unless its project has no ready source.
    pub fn live_started(&self, recording_id: &str) {
        if self.0.closed.load(Ordering::SeqCst) {
            return;
        }
        let receiver = {
            let mut sessions = lock(&self.0.sessions);
            if sessions.contains_key(recording_id) {
                return;
            }
            let (sender, receiver) = mpsc::unbounded_channel();
            sessions.insert(recording_id.to_owned(), sender);
            receiver
        };
        let this = self.clone();
        let recording_id = recording_id.to_owned();
        self.0
            .runtime
            .spawn(async move { this.start(recording_id, receiver).await });
    }

    /// A live phrase of `recording_id` was stored.
    /// `segment_id`: the phrase's segment, the trigger of the next call
    /// (call-analytics design.md, decision 3).
    pub fn phrase(
        &self,
        recording_id: &str,
        channel: TranscriptChannel,
        text: &str,
        segment_id: Option<&str>,
    ) {
        if channel == TranscriptChannel::Others {
            let words = text.split_whitespace().count();
            self.send(
                recording_id,
                Message::ClientWords(words, segment_id.map(str::to_owned)),
            );
        }
    }

    /// The fast loop changed the current topic of `recording_id`.
    pub fn topic_changed(&self, recording_id: &str) {
        self.send(recording_id, Message::TopicChanged);
    }

    /// A status check found the agent ready.
    pub fn agent_ready(&self) {
        self.0.halt.clear_login();
        for sender in lock(&self.0.sessions).values() {
            let _ = sender.send(Message::Resume);
        }
    }

    /// The live pass of `recording_id` is over: its running call is
    /// cancelled (its findings are not stored), and no other starts.
    pub fn live_finished(&self, recording_id: &str) {
        if let Some(sender) = lock(&self.0.sessions).remove(recording_id) {
            let _ = sender.send(Message::Stop);
        }
        self.cancel_call(recording_id);
    }

    /// The app exits: every running call is cancelled and its CLI's process
    /// tree killed now, the schedulers stop, the prompt files go.
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
        for (_, sender) in lock(&self.0.sessions).drain() {
            let _ = sender.send(Message::Stop);
        }
        if let Err(error) = assembly::sweep_prompts(&self.0.config.prompt_dir, |_| false) {
            eprintln!("grill: could not remove the slow loop's prompt files: {error}");
        }
    }

    /// Removes the prompt files no live recording owns. Returns how many
    /// went.
    pub fn sweep_prompts(&self) -> usize {
        let sessions = lock(&self.0.sessions);
        match assembly::sweep_prompts(&self.0.config.prompt_dir, |recording_id| {
            sessions.contains_key(recording_id)
        }) {
            Ok(removed) => removed,
            Err(error) => {
                eprintln!("grill: could not sweep the slow loop's prompt files: {error}");
                0
            }
        }
    }

    /// The search of `recording_id` for `CallState.contextSearch`; `None`
    /// when it doesn't search.
    pub fn search(&self, recording_id: &str) -> Option<ContextSearch> {
        lock(&self.0.searches).get(recording_id).cloned()
    }

    fn send(&self, recording_id: &str, message: Message) {
        if let Some(sender) = lock(&self.0.sessions).get(recording_id) {
            let _ = sender.send(message);
        }
    }

    fn has_session(&self, recording_id: &str) -> bool {
        lock(&self.0.sessions).contains_key(recording_id)
    }

    fn set_search(&self, recording_id: &str, search: Option<ContextSearch>) {
        {
            let mut searches = lock(&self.0.searches);
            match search {
                Some(search) => searches.insert(recording_id.to_owned(), search),
                None => searches.remove(recording_id),
            };
        }
        self.0.host.call_state_changed(recording_id);
    }

    fn cancel_call(&self, recording_id: &str) {
        if let Some(call) = lock(&self.0.in_flight).remove(recording_id) {
            let _ = call.stop.send(());
        }
    }

    /// Builds the index and writes the prompt, then runs the scheduler.
    async fn start(self, recording_id: String, receiver: mpsc::UnboundedReceiver<Message>) {
        // The first call's minute counts from the start of the recording,
        // not from when a large index is ready.
        let started = Instant::now();
        let id = recording_id.clone();
        let read = database(&self.0.host, move |connection| {
            let project_id = recordings::get(connection, &id)?.project_id;
            let texts = match &project_id {
                Some(project_id) => sources::searchable_texts(connection, project_id)?,
                None => Vec::new(),
            };
            Ok((texts, assembly::prompt(connection, &id)?))
        })
        .await;
        let (texts, prompt) = match read {
            Ok(read) => read,
            Err(error) => {
                eprintln!("grill: the slow loop of {recording_id} did not start: {error}");
                return;
            }
        };
        let index = if texts.is_empty() {
            Index::default()
        } else {
            tokio::task::spawn_blocking(move || Index::build(texts))
                .await
                .unwrap_or_default()
        };
        // Without a source there is nothing to search: no calls.
        if index.is_empty() || !self.has_session(&recording_id) {
            return;
        }
        let prompt_file =
            match assembly::write_prompt(&self.0.config.prompt_dir, &recording_id, &prompt) {
                Ok(path) => path,
                Err(error) => {
                    eprintln!("grill: the slow loop's prompt of {recording_id}: {error}");
                    return;
                }
            };
        self.set_search(
            &recording_id,
            Some(ContextSearch {
                running: false,
                queries: Vec::new(),
            }),
        );
        let scheduler = Scheduler {
            call: CallContext {
                slow_loop: self.clone(),
                recording_id,
                index: Arc::new(index),
                prompt_file,
                prompt: Arc::new(prompt),
                agent: None,
            },
            started,
            last_start: None,
            words: 0,
            topic_due: false,
            retry_at: None,
            waiting_for_agent: false,
            queries: Vec::new(),
            last_client_segment: None,
        };
        scheduler.run(receiver).await;
    }
}

/// How a call ended, for the scheduler.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CallEnd {
    /// The agent answered (or there was nothing to search): the queries
    /// for the next call, when it gave them.
    Done {
        queries: Option<Vec<String>>,
    },
    Failed,
    NotLoggedIn,
    RateLimited {
        resets_at: Option<i64>,
    },
    Cancelled,
}

#[derive(Clone)]
struct CallContext {
    slow_loop: SlowLoop,
    recording_id: String,
    index: Arc<Index>,
    prompt_file: PathBuf,
    /// The prompt file's text, for the journal.
    prompt: Arc<String>,
    agent: Option<Arc<dyn Agent>>,
}

/// Why a call started and the client's last phrase, for the journal.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Cause {
    trigger: CallTrigger,
    segment_id: Option<String>,
}

struct Scheduler {
    call: CallContext,
    /// When the live pass started (the first call's clock).
    started: Instant,
    last_start: Option<Instant>,
    /// Words of «Остальные» since the last call started.
    words: usize,
    /// The topic changed since the last call started.
    topic_due: bool,
    retry_at: Option<Instant>,
    /// The agent was not ready: no calls until a status check finds it.
    waiting_for_agent: bool,
    /// The agent's queries of the last call.
    queries: Vec<String>,
    /// The last phrase of «Остальные»: the next call's trigger.
    last_client_segment: Option<String>,
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn joined(call: &mut Option<JoinHandle<CallEnd>>) -> CallEnd {
    match call {
        Some(handle) => handle.await.unwrap_or(CallEnd::Failed),
        None => std::future::pending().await,
    }
}

impl Scheduler {
    fn inner(&self) -> &Inner {
        &self.call.slow_loop.0
    }

    async fn run(mut self, mut messages: mpsc::UnboundedReceiver<Message>) {
        let mut call: Option<JoinHandle<CallEnd>> = None;
        let mut stopping = false;
        while !(stopping && call.is_none()) {
            let due_at = self.due_at().filter(|_| call.is_none() && !stopping);
            tokio::select! {
                message = messages.recv(), if !stopping => match message {
                    Some(Message::ClientWords(words, segment_id)) => {
                        self.words += words;
                        if segment_id.is_some() {
                            self.last_client_segment = segment_id;
                        }
                    }
                    Some(Message::TopicChanged) => self.topic_due = true,
                    Some(Message::Resume) => self.waiting_for_agent = false,
                    Some(Message::Stop) | None => {
                        stopping = true;
                        self.call.slow_loop.cancel_call(&self.call.recording_id);
                    }
                },
                end = joined(&mut call) => {
                    call = None;
                    lock(&self.inner().in_flight).remove(&self.call.recording_id);
                    if !stopping {
                        self.finish(end);
                    }
                }
                () = sleep_until(due_at) => {
                    // A wake-up at the limit's reset is no call by itself.
                    let due = self.call_due().is_some_and(|due| due <= Instant::now());
                    if self.inner().halt.active().is_none() && due {
                        call = self.start_call().await;
                    }
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
        self.call
            .slow_loop
            .set_search(&self.call.recording_id, None);
    }

    /// When the next call is due while none runs: at once after a topic
    /// change, else once `every` passed since the last start (or the
    /// recording's start) if the client said enough since; never before a
    /// retry after an error, nor while the calls are stopped (until the
    /// limit resets, when known).
    fn due_at(&self) -> Option<Instant> {
        if self.waiting_for_agent {
            return None;
        }
        if let Some(halted) = self.inner().halt.active() {
            let due = self.call_due()?;
            return match halted {
                Halted::RateLimited { until, .. } => until.map(|until| until.max(due)),
                Halted::NeedsLogin => None,
            };
        }
        self.call_due()
    }

    /// When the next call is due by the topic, the client's words and the
    /// retry, whatever stops the calls.
    fn call_due(&self) -> Option<Instant> {
        let config = &self.inner().config;
        let due = if self.topic_due {
            Some(Instant::now())
        } else if self.words >= config.min_words {
            Some(self.last_start.unwrap_or(self.started) + config.every)
        } else {
            None
        };
        due.map(|due| self.retry_at.map_or(due, |retry| due.max(retry)))
    }

    /// Starts a call, once the agent is there: the first call asks the
    /// provider for it; when it is not ready, no call until a status check
    /// finds it ready.
    async fn start_call(&mut self) -> Option<JoinHandle<CallEnd>> {
        if self.call.agent.is_none() {
            match self.inner().provider.provide().await {
                Ok(agent) => self.call.agent = Some(agent),
                Err(_) => {
                    self.waiting_for_agent = true;
                    return None;
                }
            }
        }
        let cause = Cause {
            trigger: if self.topic_due {
                CallTrigger::TopicChanged
            } else {
                CallTrigger::Interval
            },
            segment_id: self.last_client_segment.clone(),
        };
        self.last_start = Some(Instant::now());
        self.words = 0;
        self.topic_due = false;
        self.retry_at = None;
        self.call.slow_loop.set_search(
            &self.call.recording_id,
            Some(ContextSearch {
                running: true,
                queries: self.queries.clone(),
            }),
        );
        let (stop, stopped) = oneshot::channel();
        let process = TreeSlot::default();
        lock(&self.inner().in_flight).insert(
            self.call.recording_id.clone(),
            InFlight {
                stop,
                process: process.clone(),
            },
        );
        Some(tokio::spawn(run_call(
            self.call.clone(),
            cause,
            self.queries.clone(),
            stopped,
            process,
        )))
    }

    fn finish(&mut self, end: CallEnd) {
        let halt = &self.inner().halt;
        match end {
            CallEnd::Done { queries } => {
                if let Some(queries) = queries {
                    self.queries = queries;
                }
            }
            CallEnd::Failed => {
                self.retry_at = Some(Instant::now() + self.inner().config.retry_after);
            }
            CallEnd::NotLoggedIn => halt.set(Halted::NeedsLogin),
            CallEnd::RateLimited { resets_at } => {
                // The CLI's reset time is on the real wall clock.
                let until = resets_at.map(|resets_at| {
                    let wait = u64::try_from(resets_at.saturating_sub(now_ms())).unwrap_or(0);
                    Instant::now() + Duration::from_millis(wait)
                });
                halt.set(Halted::RateLimited { until, resets_at });
            }
            CallEnd::Cancelled => {}
        }
        self.call.slow_loop.set_search(
            &self.call.recording_id,
            Some(ContextSearch {
                running: false,
                queries: self.queries.clone(),
            }),
        );
    }
}

/// Whether the call was cancelled (its sender fired or is gone).
fn stopped(stop: &mut oneshot::Receiver<()>) -> bool {
    !matches!(stop.try_recv(), Err(oneshot::error::TryRecvError::Empty))
}

/// Runs `request` on the agent: cancelled by `stop` or the call timeout.
async fn ask(
    agent: &Arc<dyn Agent>,
    config: &SlowConfig,
    request: AgentRequest,
    stop: &mut oneshot::Receiver<()>,
) -> Result<claude_cli::AgentReply, AgentError> {
    let (cancel, cancelled) = oneshot::channel();
    let running = agent.run(request, cancelled);
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
        AgentError::Timeout => (AgentCallOutcome::Timeout, CallEnd::Failed),
        AgentError::InvalidOutput(_) => (AgentCallOutcome::Invalid, CallEnd::Failed),
        AgentError::Process(_) => (AgentCallOutcome::Error, CallEnd::Failed),
        AgentError::Cancelled => (AgentCallOutcome::Cancelled, CallEnd::Cancelled),
    }
}

/// The open questions of a state.
fn open_questions(state: &call_state::CallState) -> Vec<String> {
    state
        .questions
        .iter()
        .filter(|question| question.status == QuestionStatus::Open)
        .map(|question| question.id.clone())
        .collect()
}

fn elapsed_ms(started: Instant) -> i64 {
    i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX)
}

/// The JSON Schema of the reply on one line, as `--json-schema` takes it.
pub fn schema_argument() -> &'static str {
    static MINIFIED: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
        let schema: serde_json::Value =
            serde_json::from_str(assembly::SCHEMA).expect("slow_loop.schema.json is valid JSON");
        schema.to_string()
    });
    &MINIFIED
}

/// One call, start to end: it waits for the slow loop's gate. `stop` (or
/// its sender dropped) cancels it. Every call past the gate is recorded in
/// `agent_calls` as `slowLoop`, one without candidates as `empty` without
/// running the agent.
async fn run_call(
    call: CallContext,
    cause: Cause,
    queries: Vec<String>,
    mut stop: oneshot::Receiver<()>,
    process: TreeSlot,
) -> CallEnd {
    let inner = &call.slow_loop.0;
    let host = &inner.host;
    let gate = Arc::clone(&inner.gate);
    let _permit = tokio::select! {
        permit = gate.acquire_owned() => match permit {
            Ok(permit) => permit,
            Err(_) => return CallEnd::Cancelled,
        },
        _ = &mut stop => return CallEnd::Cancelled,
    };
    // Made before the findings are stored: the journal points at it
    // (call-analytics design.md, decision 1).
    let call_id = new_id();
    let started_at = host.now_ms();
    let started = Instant::now();
    let mut record = AgentCallInput {
        id: Some(call_id.clone()),
        recording_id: call.recording_id.clone(),
        kind: AgentCallKind::SlowLoop,
        started_at,
        trigger: Some(cause.trigger),
        trigger_segment_id: cause.segment_id,
        ..AgentCallInput::default()
    };

    let id = call.recording_id.clone();
    let read = database(host, move |connection| {
        Ok((
            call_state::get(connection, &id)?,
            transcript::for_recording(connection, &id)?,
            context_findings::known(connection, &id)?,
        ))
    })
    .await;
    let (state, segments, known) = match read {
        Ok(read) => read,
        Err(error) => {
            eprintln!(
                "grill: the slow loop's call of {} was not assembled: {error}",
                call.recording_id
            );
            return CallEnd::Failed;
        }
    };
    let mut searched = queries.clone();
    let client = assembly::client_query(&segments);
    record.queries = Some(serde_json::json!({ "agent": queries, "client": client }));
    if !client.trim().is_empty() {
        searched.push(client);
    }
    let index = Arc::clone(&call.index);
    let candidates: Vec<Candidate> = tokio::task::spawn_blocking(move || index.search(&searched))
        .await
        .unwrap_or_default();
    if candidates.is_empty() {
        // Nothing to pick from: no process.
        record.duration_ms = elapsed_ms(started);
        record.outcome = Some(AgentCallOutcome::Empty);
        save(host, record).await;
        return CallEnd::Done { queries: None };
    }
    let Some(agent) = call.agent.clone() else {
        return CallEnd::Failed;
    };
    let parts = assembly::user_message_parts(&state, &segments, &queries, &candidates);
    record.prompt = vec![PromptPart::new("file", call.prompt.as_str())];
    record.prompt.extend(parts.iter().cloned());
    record.candidates = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| journal::Candidate {
            label: format!("C{}", index + 1),
            rank: i64::try_from(index + 1).unwrap_or(i64::MAX),
            chunk_key: candidate.key.clone(),
            source_id: Some(candidate.source.id.clone()),
            source_kind: candidate.source.kind,
            source_name: candidate.source.name.clone(),
            source_url: candidate.source.url.clone(),
            heading_path: candidate.path.clone(),
            text: candidate.text.clone(),
        })
        .collect();
    let request = AgentRequest {
        system_prompt_file: call.prompt_file.clone(),
        user_message: crate::agent::sections::join(&parts),
        schema: schema_argument().to_owned(),
        process,
        options: CallOptions {
            effort: Some("low"),
            timeout: Some(claude_cli::TIMEOUT),
            output: OutputKind::Object,
            ..CallOptions::default()
        },
    };
    let context = SlowContext {
        candidates,
        open_questions: open_questions(&state),
        known,
    };
    let reply = ask(&agent, &inner.config, request, &mut stop).await;
    record.duration_ms = elapsed_ms(started);
    let reply = match reply {
        Ok(reply) => reply,
        Err(error) => {
            let (outcome, end) = failure(&error);
            eprintln!(
                "grill: the slow loop's call of {} failed: {error}",
                call.recording_id
            );
            record.outcome = Some(outcome);
            record.error = Some(error.to_string());
            save(host, record).await;
            return end;
        }
    };
    with_usage(&mut record, &reply.usage);
    record.raw_reply = Some(reply.raw);
    record.reply = Some(reply.patch.clone());
    let finding_values = reply
        .patch
        .get("findings")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let parsed = match Reply::parse(reply.patch) {
        Ok(parsed) => parsed,
        Err(reason) => {
            let message = AgentError::InvalidOutput(reason).to_string();
            eprintln!(
                "grill: the slow loop's call of {}: {message}",
                call.recording_id
            );
            record.outcome = Some(AgentCallOutcome::Invalid);
            record.error = Some(message);
            save(host, record).await;
            return CallEnd::Failed;
        }
    };
    let checked = validate::validate(&parsed, &context);
    // The live pass ended while the agent answered: nothing is stored.
    if stopped(&mut stop) {
        record.outcome = Some(AgentCallOutcome::Cancelled);
        record.error = Some(AgentError::Cancelled.to_string());
        save(host, record).await;
        return CallEnd::Cancelled;
    }

    let id = call.recording_id.clone();
    let now = host.now_ms();
    let next_queries = parsed.queries.clone();
    let stored = database(host, move |connection| {
        let mut added = false;
        in_savepoint(connection, || {
            let fresh = SlowContext {
                candidates: context.candidates.clone(),
                open_questions: open_questions(&call_state::get(connection, &id)?),
                known: context_findings::known(connection, &id)?,
            };
            let validation = validate::recheck(&parsed, checked, &fresh);
            let mut rejected = validation.rejected;
            let mut inserted = Vec::new();
            let mut stored_at: Vec<(usize, String)> = Vec::new();
            for (index, accepted) in validation.accepted {
                let new = NewFinding {
                    source_id: Some(accepted.candidate.source.id.clone()),
                    source_kind: accepted.candidate.source.kind,
                    source_name: accepted.candidate.source.name.clone(),
                    source_url: accepted.candidate.source.url.clone(),
                    chunk_key: accepted.candidate.key.clone(),
                    quote: accepted.quote,
                    note: accepted.note,
                    question_id: accepted.question_id,
                    agent_call_id: None,
                };
                match context_findings::insert_at(connection, &id, &new, now)? {
                    Inserted::Added { id, .. } => {
                        stored_at.push((index, id.clone()));
                        inserted.push(id);
                    }
                    Inserted::NoRoom => rejected.push(SlowRejection {
                        index,
                        op: "finding",
                        subject: parsed.findings[index].candidate.clone(),
                        reason: SlowRejectReason::NoRoom,
                    }),
                }
            }
            rejected.sort_by_key(|rejection| rejection.index);
            for rejection in &rejected {
                eprintln!("grill: the slow loop's finding was rejected ({id}): {rejection}");
            }
            record.rejected = serde_json::to_value(&rejected)
                .unwrap_or_else(|_| serde_json::Value::Array(Vec::new()));
            record.ops = finding_values
                .iter()
                .enumerate()
                .map(|(index, body)| {
                    let stored = stored_at.iter().find(|(at, _)| *at == index);
                    CallOp {
                        op: "finding".to_owned(),
                        body: body.clone(),
                        applied: stored.is_some(),
                        reason: rejected
                            .iter()
                            .find(|rejection| rejection.index == index)
                            .and_then(|rejection| serde_json::to_value(rejection).ok()),
                        subject: stored.map(|(_, id)| (SubjectKind::Finding, id.clone())),
                    }
                })
                .collect();
            record.outcome = Some(if inserted.is_empty() {
                AgentCallOutcome::Empty
            } else {
                AgentCallOutcome::Ok
            });
            let call_id = call_state::insert_agent_call_at(connection, &record, now)?;
            for finding in &inserted {
                context_findings::attach_call(connection, finding, &call_id)?;
            }
            added = !inserted.is_empty();
            Ok(())
        })
        .or_else(|error| {
            record.outcome = Some(AgentCallOutcome::Error);
            record.error = Some(error.to_string());
            for op in &mut record.ops {
                op.applied = false;
                op.subject = None;
            }
            call_state::insert_agent_call_at(connection, &record, now)?;
            Err(error)
        })?;
        Ok(added)
    })
    .await;
    match stored {
        Ok(added) => {
            if added {
                host.call_state_changed(&call.recording_id);
            }
            CallEnd::Done {
                queries: Some(next_queries),
            }
        }
        Err(error) => {
            eprintln!(
                "grill: the slow loop's findings for {} were not stored: {error}",
                call.recording_id
            );
            CallEnd::Failed
        }
    }
}

#[cfg(test)]
mod tests;
