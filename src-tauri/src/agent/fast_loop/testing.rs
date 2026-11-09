//! What the fast-loop tests share: a database with a project, people and a
//! recording, a host that keeps what the loop reported, a fake agent and a
//! provider.

use std::{
    collections::VecDeque,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicI64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use rusqlite::Connection;
use serde_json::{Value, json};
use tokio::{sync::oneshot, time::Instant};

use super::{
    events::{AgentLoopState, AgentStatus},
    scheduler::{AgentProvider, DbWork, FastLoop, LoopConfig, LoopHost, ProvideFuture},
};
use crate::{
    agent::claude_cli::{Agent, AgentError, AgentFuture, AgentReply, AgentRequest, Usage},
    error::CommandResult,
    storage::{
        self,
        people::{self, PersonCreate},
        projects::{self, ProjectCreate},
        recordings::{self, RecordingFiles, RecordingLinks},
        settings::{self, SettingsMap},
        transcript::{self, SegmentInput, TranscriptChannel, TranscriptSegment},
    },
};

/// A migrated in-memory database.
pub fn database() -> Connection {
    storage::open_in_memory().unwrap()
}

/// A project «Телемедиа» with a brief and two people, and a recording of it
/// with Ольга on the call. Returns the recording id.
pub fn recording(connection: &Connection) -> String {
    let (project, _) = projects::create(
        connection,
        ProjectCreate {
            name: "Телемедиа".to_owned(),
            description: Some("Единая система приёма звонков для сети клиник".to_owned()),
            // The shape of `projects/brief/brief.schema.json`.
            brief: Some(json!({
                "product": "Клиники теряют до половины звонков пациентов",
                "stack": ["amoCRM API v4", "Mango Office"],
                "modules": [],
                "glossary": [{ "term": "Первичка", "definition": "Пациент без карты" }],
                "keyDocuments": [{
                    "sourceId": "0196f3a2-7c41-7d2e-9a10-3b5c8d4e6f70",
                    "title": "Архитектура телефонии",
                    "why": "Схема очередей"
                }],
            })),
            ..ProjectCreate::default()
        },
    )
    .unwrap();
    let person = |name: &str, role: &str, profile: Value| {
        people::create(
            connection,
            PersonCreate {
                project_id: project.id.clone(),
                name: name.to_owned(),
                role: Some(role.to_owned()),
                profile: Some(profile),
            },
        )
        .unwrap()
        .0
    };
    let olga = person(
        "Ольга Демченко",
        "CEO",
        json!({ "howToAsk": "Через деньги и сроки, без терминов", "tech": 1, "initials": "ОД" }),
    );
    person("Игорь Савчук", "Техлид", json!({ "tech": 5 }));
    let links = RecordingLinks {
        call_id: None,
        project_id: Some(project.id),
        participant_ids: vec![olga.id],
    };
    recordings::create(connection, &links, 1_000, |id| RecordingFiles {
        me: format!("recordings/{id}/me.opus"),
        others: format!("recordings/{id}/others.opus"),
    })
    .unwrap()
}

/// Stores a live phrase.
pub fn say(
    connection: &Connection,
    recording_id: &str,
    channel: TranscriptChannel,
    start_ms: i64,
    text: &str,
) -> TranscriptSegment {
    let segment = SegmentInput {
        channel,
        start_ms,
        end_ms: start_ms + 2_000,
        text: text.to_owned(),
    };
    transcript::append_live(connection, recording_id, segment)
        .unwrap()
        .0
}

pub fn set_setting(connection: &Connection, key: &str, value: Value) {
    settings::put(connection, &SettingsMap::from([(key.to_owned(), value)])).unwrap();
}

/// What the loop reported.
#[derive(Debug, Clone, PartialEq)]
pub enum Reported {
    Changed(String),
    Status(AgentStatus),
}

pub struct TestHost {
    pub db: Mutex<Connection>,
    pub reported: Mutex<Vec<Reported>>,
    /// Added to the wall clock the host gives the loop (ms).
    pub clock_shift: AtomicI64,
}

impl TestHost {
    pub fn new(connection: Connection) -> Arc<Self> {
        Arc::new(Self {
            db: Mutex::new(connection),
            reported: Mutex::new(Vec::new()),
            clock_shift: AtomicI64::new(0),
        })
    }

    pub fn db<T>(&self, work: impl FnOnce(&Connection) -> T) -> T {
        work(&self.db.lock().unwrap())
    }

    pub fn states(&self) -> Vec<AgentLoopState> {
        self.reported
            .lock()
            .unwrap()
            .iter()
            .filter_map(|reported| match reported {
                Reported::Status(status) => Some(status.state.clone()),
                Reported::Changed(_) => None,
            })
            .collect()
    }

    pub fn last_state(&self) -> Option<AgentLoopState> {
        self.states().pop()
    }

    pub fn changes(&self) -> usize {
        self.reported
            .lock()
            .unwrap()
            .iter()
            .filter(|reported| matches!(reported, Reported::Changed(_)))
            .count()
    }
}

impl LoopHost for TestHost {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        work(&self.db.lock().unwrap())
    }

    fn call_state_changed(&self, recording_id: &str) {
        self.reported
            .lock()
            .unwrap()
            .push(Reported::Changed(recording_id.to_owned()));
    }

    fn agent_status(&self, status: &AgentStatus) {
        self.reported
            .lock()
            .unwrap()
            .push(Reported::Status(status.clone()));
    }

    fn now_ms(&self) -> i64 {
        storage::now_ms() + self.clock_shift.load(Ordering::SeqCst)
    }
}

/// One answer of the fake agent, after `delay`.
#[derive(Debug, Clone)]
pub struct Step {
    pub delay: Duration,
    pub reply: Result<Value, AgentError>,
    pub usage: Usage,
}

impl Step {
    pub fn patch(patch: Value) -> Self {
        Self {
            delay: Duration::from_secs(5),
            reply: Ok(patch),
            usage: Usage::default(),
        }
    }

    pub fn empty() -> Self {
        Self::patch(json!({ "ops": [] }))
    }

    pub fn fail(error: AgentError) -> Self {
        Self {
            delay: Duration::from_secs(5),
            reply: Err(error),
            usage: Usage::default(),
        }
    }

    pub fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

/// A call the fake agent got.
#[derive(Debug, Clone)]
pub struct Received {
    pub at: Instant,
    pub request: AgentRequest,
    /// The prefix file's bytes when the call came.
    pub prompt: Vec<u8>,
}

/// Answers from a script; an empty patch once the script is over.
/// `Step::delay` of `Duration::MAX` hangs until cancelled. Counts how many
/// of its calls ran at once.
#[derive(Default)]
pub struct FakeAgent {
    script: Mutex<VecDeque<Step>>,
    pub received: Mutex<Vec<Received>>,
    running: Arc<AtomicUsize>,
    most_at_once: Arc<AtomicUsize>,
}

/// One running call of the fake, until dropped.
struct Running(Arc<AtomicUsize>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl FakeAgent {
    pub fn new(steps: impl IntoIterator<Item = Step>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(steps.into_iter().collect()),
            ..Self::default()
        })
    }

    /// The most calls that ran at the same time.
    pub fn most_at_once(&self) -> usize {
        self.most_at_once.load(Ordering::SeqCst)
    }

    pub fn push(&self, step: Step) {
        self.script.lock().unwrap().push_back(step);
    }

    pub fn calls(&self) -> usize {
        self.received.lock().unwrap().len()
    }

    pub fn starts(&self) -> Vec<Instant> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .map(|received| received.at)
            .collect()
    }

    pub fn received(&self, index: usize) -> Received {
        self.received.lock().unwrap()[index].clone()
    }
}

impl Agent for FakeAgent {
    fn run(&self, request: AgentRequest, cancel: oneshot::Receiver<()>) -> AgentFuture<'_> {
        let prompt = std::fs::read(&request.system_prompt_file).unwrap_or_default();
        self.received.lock().unwrap().push(Received {
            at: Instant::now(),
            request,
            prompt,
        });
        let step = self
            .script
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(Step::empty);
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_at_once.fetch_max(now, Ordering::SeqCst);
        let running = Running(Arc::clone(&self.running));
        Box::pin(async move {
            let _running = running;
            let wait = async {
                if step.delay == Duration::MAX {
                    std::future::pending::<()>().await;
                }
                tokio::time::sleep(step.delay).await;
            };
            tokio::select! {
                () = wait => {}
                _ = cancel => return Err(AgentError::Cancelled),
            }
            step.reply.map(|patch| AgentReply {
                patch,
                usage: step.usage,
            })
        })
    }
}

/// Gives the agent, or says why it can't, after `delay` (a status check
/// takes time).
pub struct Provider {
    pub agent: Mutex<Result<Arc<dyn Agent>, AgentLoopState>>,
    pub delay: Mutex<Duration>,
}

impl Provider {
    pub fn ready(agent: Arc<dyn Agent>) -> Arc<Self> {
        Arc::new(Self {
            agent: Mutex::new(Ok(agent)),
            delay: Mutex::new(Duration::ZERO),
        })
    }

    pub fn not_ready(state: AgentLoopState) -> Arc<Self> {
        Arc::new(Self {
            agent: Mutex::new(Err(state)),
            delay: Mutex::new(Duration::ZERO),
        })
    }
}

impl AgentProvider for Provider {
    fn provide(&self) -> ProvideFuture {
        let agent = self.agent.lock().unwrap().clone();
        let delay = *self.delay.lock().unwrap();
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            agent
        })
    }
}

/// A fast loop on the current runtime, prefix files in `dir`.
pub fn fast_loop(host: Arc<TestHost>, provider: Arc<Provider>, dir: PathBuf) -> FastLoop {
    FastLoop::new(
        host,
        provider,
        tokio::runtime::Handle::current(),
        LoopConfig::new(dir),
    )
}
