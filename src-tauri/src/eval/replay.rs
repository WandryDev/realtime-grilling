//! `grill-eval replay`: a corpus through the real fast loop
//! (question-quality design.md, decision 3). Only the phrases' source, the
//! database and the clocks differ from the app: the scheduler, the prompt
//! assembly, the checks and the patch are the app's own code.
//!
//! - The database is in memory, seeded from the corpus (project, brief,
//!   people, recording, settings); the app's is never opened.
//! - The host ([`ReplayHost`]) keeps what the loop reports in the run's log
//!   instead of telling windows, and gives the loop the call's wall clock:
//!   the corpus's start plus the time on tokio's clock.
//! - The driver feeds each live segment at its `end_ms`, the moment the
//!   live pass stored it: it inserts the segment (under the corpus's id)
//!   and calls [`FastLoop::phrase`].
//!
//! The clock is tokio's paused one, so idle time costs nothing: with no
//! call running the driver's sleep to the next phrase ends at once, as
//! tokio moves a paused clock to the next timer whenever the runtime has
//! nothing to do. While a call runs that would be wrong: the CLI is a child
//! process, a wait on I/O that the clock doesn't see, so tokio would jump
//! to the next phrase, then past the call's timeout, all while the CLI is
//! still thinking. [`Clocked`] prevents it: while its call runs it keeps a
//! blocking task in flight (tokio doesn't move a paused clock while one
//! runs) and moves the clock itself in steps of 100 ms of real time.
//! Phrases due meanwhile are fed as they come and wait for the next call,
//! as in a live call.
//!
//! `--realtime` runs on the real clock instead (the check that both agree).

use std::{
    borrow::Cow,
    collections::HashMap,
    path::Path,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use rusqlite::Connection;
use tokio::{
    runtime::Handle,
    sync::{oneshot, watch},
    time::Instant,
};

use super::{
    corpus::{Corpus, Segment},
    report::{self, Flags, LogEntry, LogEvent, Report, Run},
};
use crate::{
    agent::{
        claude_cli::{Agent, AgentError, AgentFuture, AgentRequest},
        fast_loop::{
            events::{AgentLoopState, AgentStatus},
            scheduler::{
                self, AgentProvider, DbWork, FastLoop, LoopConfig, LoopHost, ProvideFuture,
            },
        },
    },
    error::CommandResult,
    speech::context,
    storage::{
        self, people,
        people::PersonCreate,
        projects::{self, ProjectCreate},
        recordings::{self, RecordingFiles, RecordingLinks},
        settings,
        transcript::{self, SegmentInput},
    },
};

/// What `grill-eval replay` was asked.
#[derive(Debug, Clone, Default)]
pub struct Options {
    /// `--from` / `--to` in minutes: the segments that start in
    /// `[from, to)`.
    pub from_min: Option<f64>,
    pub to_min: Option<f64>,
    pub label: String,
    /// `--rules`: the file and its text, instead of `assembly::RULES`.
    pub rules: Option<Rules>,
    pub realtime: bool,
    /// Progress lines on stderr.
    pub progress: bool,
}

#[derive(Debug, Clone)]
pub struct Rules {
    pub file: String,
    pub text: String,
}

/// How the paused clock follows a running call: `step` every `every` of
/// real time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Follow {
    pub step: Duration,
    pub every: Duration,
}

/// The clock moves with real time, 100 ms at a time.
pub const FOLLOW: Follow = Follow {
    step: Duration::from_millis(100),
    every: Duration::from_millis(100),
};

fn minutes_ms(minutes: f64) -> i64 {
    // Minutes of a call: far from the limits of i64.
    #[allow(clippy::cast_possible_truncation)]
    let ms = (minutes * 60_000.0).round() as i64;
    ms.max(0)
}

fn ms(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// The live segments a run feeds, in the order the live pass stored them.
fn selected(corpus: &Corpus, from_ms: Option<i64>, to_ms: Option<i64>) -> Vec<&Segment> {
    let mut picked: Vec<&Segment> = corpus
        .live
        .iter()
        .filter(|segment| from_ms.is_none_or(|from| segment.start_ms >= from))
        .filter(|segment| to_ms.is_none_or(|to| segment.start_ms < to))
        .collect();
    picked.sort_by(|a, b| (a.end_ms, a.start_ms, &a.id).cmp(&(b.end_ms, b.start_ms, &b.id)));
    picked
}

/// The corpus's project, people and recording in `connection`. Returns the
/// recording's id.
pub(super) fn seed(connection: &Connection, corpus: &Corpus) -> CommandResult<String> {
    settings::put(connection, &corpus.settings)?;
    let mut people_ids: HashMap<&str, String> = HashMap::new();
    let project_id = match &corpus.project {
        Some(project) => {
            let (created, _) = projects::create(
                connection,
                ProjectCreate {
                    name: project.name.clone(),
                    description: Some(project.description.clone()),
                    notes: Some(project.notes.clone()),
                    brief: project.brief.clone(),
                },
            )?;
            for person in &corpus.people {
                let (added, _) = people::create(
                    connection,
                    PersonCreate {
                        project_id: created.id.clone(),
                        name: person.name.clone(),
                        role: Some(person.role.clone()),
                        profile: Some(person.profile.clone()),
                    },
                )?;
                people_ids.insert(&person.id, added.id);
            }
            Some(created.id)
        }
        None => None,
    };
    let links = RecordingLinks {
        call_id: None,
        project_id,
        participant_ids: corpus
            .participant_ids
            .iter()
            .filter_map(|id| people_ids.get(id.as_str()).cloned())
            .collect(),
    };
    recordings::create(connection, &links, corpus.recording.started_at, |id| {
        RecordingFiles {
            me: format!("recordings/{id}/me.opus"),
            others: format!("recordings/{id}/others.opus"),
        }
    })
}

/* The host */

/// The loop's host in a replay: the in-memory database, the run's log and
/// the call's clock.
struct ReplayHost {
    db: Mutex<Connection>,
    /// The corpus's start of the call, Unix ms.
    call_started_at: i64,
    /// The call's wall clock at `t0`, Unix ms: past `call_started_at` by
    /// the minutes before `--from`.
    wall_at_t0: i64,
    t0: Instant,
    log: Mutex<Vec<LogEntry>>,
    /// The agent's last state, for the driver.
    state: watch::Sender<Option<AgentLoopState>>,
    progress: bool,
    calls: AtomicUsize,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `mm:ss`.
fn clock(at_ms: i64) -> String {
    let seconds = at_ms.max(0) / 1000;
    format!("{:02}:{:02}", seconds / 60, seconds % 60)
}

impl ReplayHost {
    /// From the start of the call.
    fn at_ms(&self) -> i64 {
        self.now_ms() - self.call_started_at
    }

    fn push(&self, event: LogEvent) -> i64 {
        let at_ms = self.at_ms();
        lock(&self.log).push(LogEntry { at_ms, event });
        at_ms
    }
}

impl LoopHost for ReplayHost {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        work(&lock(&self.db))
    }

    fn call_state_changed(&self, _recording_id: &str) {
        let at_ms = self.push(LogEvent::CallStateChanged);
        if self.progress {
            eprintln!("{} состояние звонка обновлено", clock(at_ms));
        }
    }

    fn agent_status(&self, status: &AgentStatus) {
        let at_ms = self.push(LogEvent::AgentStatus {
            state: status.state.clone(),
        });
        if self.progress {
            match &status.state {
                AgentLoopState::Thinking => {
                    let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
                    eprintln!("{} вызов {call}", clock(at_ms));
                }
                AgentLoopState::Error { message, .. } => {
                    eprintln!("{} вызов не удался: {message}", clock(at_ms));
                }
                AgentLoopState::NeedsLogin | AgentLoopState::RateLimited { .. } => {
                    eprintln!("{} агент недоступен", clock(at_ms));
                }
                AgentLoopState::Idle => {}
            }
        }
        self.state.send_replace(Some(status.state.clone()));
    }

    fn now_ms(&self) -> i64 {
        self.wall_at_t0 + ms(self.t0.elapsed())
    }
}

/// The agent, ready from the start.
struct Ready(Arc<dyn Agent>);

impl AgentProvider for Ready {
    fn provide(&self) -> ProvideFuture {
        let agent = Arc::clone(&self.0);
        Box::pin(async move { Ok(agent) })
    }
}

/* The clock during a call */

/// An agent whose calls the paused clock follows (see the module's doc);
/// on the real clock (`follow: None`) the agent as it is.
struct Clocked {
    inner: Arc<dyn Agent>,
    follow: Option<Follow>,
}

/// Moves the paused clock with real time, forever. Each step waits in a
/// blocking task: while one runs tokio doesn't move the clock by itself.
async fn follow_real_time(follow: Follow) {
    loop {
        let every = follow.every;
        let _ = tokio::task::spawn_blocking(move || std::thread::sleep(every)).await;
        tokio::time::advance(follow.step).await;
    }
}

impl Agent for Clocked {
    fn run(&self, request: AgentRequest, cancel: oneshot::Receiver<()>) -> AgentFuture<'_> {
        let running = self.inner.run(request, cancel);
        let Some(follow) = self.follow else {
            return running;
        };
        Box::pin(async move {
            // Both start in the same poll: the clock is held before the
            // call can wait on anything.
            tokio::select! {
                biased;
                reply = running => reply,
                () = follow_real_time(follow) => {
                    Err(AgentError::Process("Часы прогона остановились".to_owned()))
                }
            }
        })
    }
}

/* The driver */

/// Lets every task that can run finish its step: on the paused clock the
/// sleeps end only once the runtime has nothing else to do.
async fn settle() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

/// Why the run must stop: the agent can't go on until a person acts.
fn halted(state: Option<&AgentLoopState>) -> Option<String> {
    match state? {
        AgentLoopState::NeedsLogin => Some(AgentError::NotLoggedIn.to_string()),
        AgentLoopState::RateLimited { resets_at } => Some(
            AgentError::RateLimited {
                resets_at: *resets_at,
            }
            .to_string(),
        ),
        _ => None,
    }
}

/// Until `due`, unless the agent halts first.
async fn wait_until(
    due: Instant,
    states: &mut watch::Receiver<Option<AgentLoopState>>,
) -> Option<String> {
    loop {
        if let Some(reason) = halted(states.borrow_and_update().as_ref()) {
            return Some(reason);
        }
        tokio::select! {
            () = tokio::time::sleep_until(due) => return halted(states.borrow().as_ref()),
            changed = states.changed() => {
                if changed.is_err() {
                    tokio::time::sleep_until(due).await;
                    return None;
                }
            }
        }
    }
}

/// After the last phrase: until the running call, if any, ends.
async fn drain(states: &mut watch::Receiver<Option<AgentLoopState>>) -> Option<String> {
    loop {
        settle().await;
        let state = states.borrow_and_update().clone();
        if let Some(reason) = halted(state.as_ref()) {
            return Some(reason);
        }
        if state != Some(AgentLoopState::Thinking) || states.changed().await.is_err() {
            return None;
        }
    }
}

/// Replays `corpus` with `agent` and returns the report (`complete: false`
/// when the agent halted). The prefix files go to `prompt_dir`. Runs on a
/// current-thread runtime whose clock is paused, unless `options.realtime`.
pub async fn run(
    corpus: &Corpus,
    agent: Arc<dyn Agent>,
    options: &Options,
    prompt_dir: &Path,
    follow: Follow,
) -> Result<Report, String> {
    let wall_start = std::time::Instant::now();
    let run_started_at = storage::now_ms();
    let connection = storage::open_in_memory()?;
    let recording_id = seed(&connection, corpus).map_err(|error| error.to_string())?;
    let glossary = context::load(&connection, &recording_id)
        .map_err(|error| error.to_string())?
        .glossary;
    if glossary.full() != corpus.glossary && options.progress {
        eprintln!("Глоссарий прогона отличается от глоссария набора (его собрала другая версия)");
    }

    let from_ms = options.from_min.map(minutes_ms);
    let to_ms = options.to_min.map(minutes_ms);
    let segments = selected(corpus, from_ms, to_ms);
    // The clock starts at `--from`: no wait for the minutes before it, even
    // on the real clock.
    let skipped = from_ms.unwrap_or(0);
    let (state, mut states) = watch::channel(None);
    let host = Arc::new(ReplayHost {
        db: Mutex::new(connection),
        call_started_at: corpus.recording.started_at,
        wall_at_t0: corpus.recording.started_at + skipped,
        t0: Instant::now(),
        log: Mutex::new(Vec::new()),
        state,
        progress: options.progress,
        calls: AtomicUsize::new(0),
    });
    let loop_host: Arc<dyn LoopHost> = host.clone();
    let agent: Arc<dyn Agent> = Arc::new(Clocked {
        inner: agent,
        follow: (!options.realtime).then_some(follow),
    });
    let mut config = LoopConfig::new(prompt_dir);
    if let Some(rules) = &options.rules {
        config.rules = Cow::Owned(rules.text.clone());
    }
    let rules_sha256 = report::sha256_hex(&config.rules);
    let fast_loop = FastLoop::new(
        Arc::clone(&loop_host),
        Arc::new(Ready(agent)),
        Handle::current(),
        config,
    );
    fast_loop.live_started(&recording_id);

    let mut stopped = None;
    let mut fed = 0;
    let mut last_fed_ms = None;
    for segment in &segments {
        let offset = u64::try_from(segment.end_ms - skipped).unwrap_or(0);
        let due = host.t0 + Duration::from_millis(offset);
        stopped = wait_until(due, &mut states).await;
        if stopped.is_some() {
            break;
        }
        let (id, input) = (
            segment.id.clone(),
            SegmentInput {
                channel: segment.channel,
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                text: segment.text.clone(),
            },
        );
        let recording = recording_id.clone();
        scheduler::database(&loop_host, move |connection| {
            transcript::append_live_as(connection, &recording, id, input).map(|_| ())
        })
        .await
        .map_err(|error| format!("Не удалось записать фразу {}: {error}", segment.id))?;
        fast_loop.phrase(&recording_id, segment.channel);
        fed += 1;
        last_fed_ms = Some(segment.end_ms);
    }
    if stopped.is_none() {
        stopped = drain(&mut states).await;
    }
    fast_loop.live_finished(&recording_id);
    settle().await;
    fast_loop.shutdown();

    let started_at = corpus.recording.started_at;
    let (topics, questions, calls) = report::results(&lock(&host.db), &recording_id, started_at)
        .map_err(|error| error.to_string())?;
    Ok(Report {
        version: report::FORMAT,
        corpus: corpus.name.clone(),
        label: options.label.clone(),
        complete: stopped.is_none(),
        stopped,
        channels: corpus.channels,
        rules_sha256,
        flags: Flags {
            from_min: options.from_min,
            to_min: options.to_min,
            realtime: options.realtime,
            rules_file: options.rules.as_ref().map(|rules| rules.file.clone()),
        },
        run: Run {
            started_at: run_started_at,
            wall_ms: ms(wall_start.elapsed()),
            call_started_at: started_at,
            segments: segments.len(),
            segments_fed: fed,
            last_fed_ms,
        },
        topics,
        questions,
        calls,
        log: std::mem::take(&mut lock(&host.log)),
    })
}

#[cfg(test)]
mod tests;
