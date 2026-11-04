//! Building a brief (design.md, decisions 4, 6 and 8): one agent call of
//! its own, in the background, one per project. The fast loop's
//! single-flight semaphore is not taken: a refresh before a call must not
//! hold up its questions.
//!
//! Stages go out as [`BriefProgress`], always in order: 1 reading the
//! documents (and the fingerprint), 2 starting the agent, 3 the agent reads
//! (its first delta), 4 the agent writes (its first `input_json_delta` or
//! `StructuredOutput`), 5 checking and saving. Only a reply that is a brief
//! replaces the old one, with the fingerprint read before the call. The
//! project's `DataChanged` goes out when the build starts and when it ends.

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event as _;

use super::{Brief, BriefProgress, BriefStageState, PROMPT, input, schema_argument};
use crate::{
    agent::{
        self, AgentState,
        claude_cli::{
            Agent, AgentError, AgentRequest, CallOptions, ClaudeCodeCli, OutputHook, OutputKind,
            OutputPhase, Usage,
        },
        discover::SearchEnv,
    },
    error::{CommandError, CommandResult},
    events::EventSink,
    projects::{
        brief_inputs,
        builds::{BriefBuilds, BuildSlot},
    },
    storage::{
        Storage, people,
        projects::{self, BriefState},
        sources::{self, SourceStatus},
    },
};

/// The full name: an alias may move to another model.
pub const MODEL: &str = "claude-sonnet-5-5";
/// A brief is built rarely; quality matters more than speed.
pub const EFFORT: &str = "medium";
pub const TIMEOUT: Duration = Duration::from_secs(5 * 60);
const LAST_STAGE: u8 = 5;

pub type AgentLookup<'a> =
    Pin<Box<dyn Future<Output = Result<Arc<dyn Agent>, String>> + Send + 'a>>;

/// What a build needs from the app; tests give their own.
pub trait BriefHost: EventSink + 'static {
    fn storage(&self) -> Option<&Storage>;
    /// To every window.
    fn progress(&self, progress: BriefProgress);
    /// The agent when its status is `ready` (the fast loop's check), else
    /// what to show.
    fn agent(&self) -> AgentLookup<'_>;
    /// Where the prompt files of running builds go.
    fn prompt_dir(&self) -> PathBuf;
}

impl<R: Runtime> BriefHost for AppHandle<R> {
    fn storage(&self) -> Option<&Storage> {
        self.try_state::<Storage>().map(|state| state.inner())
    }

    fn progress(&self, progress: BriefProgress) {
        if let Err(error) = progress.emit(self) {
            eprintln!("grill: failed to emit brief-progress: {error}");
        }
    }

    fn agent(&self) -> AgentLookup<'_> {
        Box::pin(async move {
            let storage = self
                .storage()
                .ok_or_else(|| "Хранилище ещё не открыто".to_owned())?;
            let cwd = self
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let env = SearchEnv::from_process();
            let cli = agent::ready_cli(storage, self, &env, &cwd)
                .await
                .map_err(not_ready)?;
            let work_dir = agent::fast_loop::app::work_dir(self);
            Ok(Arc::new(ClaudeCodeCli::new(cli, work_dir)) as Arc<dyn Agent>)
        })
    }

    fn prompt_dir(&self) -> PathBuf {
        agent::fast_loop::app::work_dir(self).join("briefs")
    }
}

/// What to show for a CLI that isn't ready.
fn not_ready(state: AgentState) -> String {
    match state {
        AgentState::NeedsLogin { .. } => "Нужен вход в Claude Code".to_owned(),
        AgentState::NotInstalled => "Claude Code не установлен".to_owned(),
        AgentState::Error { message } => message,
        AgentState::Ready { .. } => "Claude Code не найден".to_owned(),
    }
}

/// Starts a build of the project unless one runs (then `None`: follow its
/// progress). `agent` is the one already checked, else it is looked up at
/// stage 2.
pub fn start<H: BriefHost>(
    host: &Arc<H>,
    builds: &BriefBuilds,
    project_id: &str,
    agent: Option<Arc<dyn Agent>>,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let mut slot = builds.start(project_id)?;
    host.data_changed(projects::changed(project_id));
    let host = Arc::clone(host);
    Some(tauri::async_runtime::spawn(async move {
        build(&host, &mut slot, agent).await;
        let project_id = slot.project_id().to_owned();
        drop(slot);
        host.data_changed(projects::changed(&project_id));
    }))
}

/// Before a call (decision 8): starts a build in the background when the
/// brief is `outdated`, or `none` while there is something to build it
/// from, the agent is ready and no build runs. `true` when it started one.
pub async fn prepare<H: BriefHost>(
    host: &Arc<H>,
    builds: &BriefBuilds,
    project_id: &str,
) -> CommandResult<bool> {
    if builds.is_building(project_id) {
        return Ok(false);
    }
    let storage = host
        .storage()
        .ok_or_else(|| CommandError::storage("Хранилище ещё не открыто"))?;
    let id = project_id.to_owned();
    let needed = storage
        .read(move |db| {
            let project = projects::get(db, &id)?;
            Ok(match project.brief_state {
                BriefState::Outdated => true,
                BriefState::None => has_materials(db, &project)?,
                BriefState::Fresh | BriefState::Building => false,
            })
        })
        .await?;
    if !needed {
        return Ok(false);
    }
    let Ok(agent) = host.agent().await else {
        return Ok(false);
    };
    Ok(start(host, builds, project_id, Some(agent)).is_some())
}

/// Something to build a brief from, without reading the documents' text.
fn has_materials(db: &rusqlite::Connection, project: &projects::Project) -> CommandResult<bool> {
    Ok(!project.description.trim().is_empty()
        || !project.notes.trim().is_empty()
        || !people::list(db, &project.id)?.is_empty()
        || !sources::ready_hashes(db, &project.id)?.is_empty())
}

/// How a build ended short of a brief.
enum End {
    Failed(String),
    Cancelled,
}

async fn build<H: BriefHost>(host: &Arc<H>, slot: &mut BuildSlot, agent: Option<Arc<dyn Agent>>) {
    let emit_host = Arc::clone(host);
    let stages = Arc::new(Stages {
        project_id: slot.project_id().to_owned(),
        emit: Box::new(move |progress| emit_host.progress(progress)),
        current: Mutex::new(0),
    });
    match attempt(host.as_ref(), slot, agent, &stages).await {
        Ok(()) => stages.finish(),
        Err(End::Cancelled) => stages.end(BriefStageState::Cancelled),
        Err(End::Failed(message)) => {
            eprintln!(
                "grill: the brief of {} was not built: {message}",
                slot.project_id()
            );
            stages.end(BriefStageState::Failed { message });
        }
    }
}

fn failed(message: impl Into<String>) -> End {
    End::Failed(message.into())
}

fn unless_cancelled(slot: &BuildSlot) -> Result<(), End> {
    if slot.is_cancelled() {
        Err(End::Cancelled)
    } else {
        Ok(())
    }
}

async fn attempt<H: BriefHost>(
    host: &H,
    slot: &mut BuildSlot,
    agent: Option<Arc<dyn Agent>>,
    stages: &Arc<Stages>,
) -> Result<(), End> {
    stages.advance(1);
    let storage = host
        .storage()
        .ok_or_else(|| failed("Хранилище ещё не открыто"))?;
    let id = slot.project_id().to_owned();
    let inputs = storage
        .read(move |db| brief_inputs::read(db, &id))
        .await
        .map_err(|error| failed(error.to_string()))?;
    if inputs.is_empty() {
        return Err(failed(
            "Не из чего собирать бриф: добавьте описание, заметки, людей или документы",
        ));
    }
    let message = input::compose(&inputs);
    unless_cancelled(slot)?;

    stages.advance(2);
    let agent = match agent {
        Some(agent) => agent,
        None => host.agent().await.map_err(End::Failed)?,
    };
    unless_cancelled(slot)?;
    let prompt = PromptFile::write(&host.prompt_dir(), slot.project_id())
        .map_err(|error| failed(format!("Не удалось записать промпт брифа: {error}")))?;
    let hook_stages = Arc::clone(stages);
    let request = AgentRequest {
        system_prompt_file: prompt.0.clone(),
        user_message: message.text.clone(),
        schema: schema_argument().to_owned(),
        process: slot.process(),
        options: CallOptions {
            model: Some(MODEL),
            effort: Some(EFFORT),
            timeout: Some(TIMEOUT),
            output: OutputKind::Object,
            on_output: Some(OutputHook::new(move |phase| {
                hook_stages.advance(match phase {
                    OutputPhase::Reading => 3,
                    OutputPhase::Writing => 4,
                });
            })),
        },
    };
    let cancel = slot
        .take_cancel()
        .ok_or_else(|| failed("Сборка брифа уже запускалась"))?;
    let reply = agent.run(request, cancel).await;
    drop(prompt);
    let reply = match reply {
        Ok(reply) => reply,
        Err(_) if slot.is_cancelled() => return Err(End::Cancelled),
        Err(AgentError::Cancelled) => return Err(End::Cancelled),
        Err(error) => return Err(failed(error.to_string())),
    };
    log_cost(slot.project_id(), &reply.usage, &message);
    unless_cancelled(slot)?;

    stages.advance(LAST_STAGE);
    let mut brief = Brief::from_reply(reply.patch)
        .map_err(|error| failed(format!("Агент ответил не по схеме брифа: {error}")))?;
    brief.resolve_documents(&message.documents);
    let id = slot.project_id().to_owned();
    let (fingerprint, truncated) = (inputs.fingerprint, message.truncated);
    storage
        .write(host, move |db| {
            // A document may have gone during the build.
            let ready: Vec<String> = sources::list(db, &id)?
                .into_iter()
                .filter(|source| source.status == SourceStatus::Ready)
                .map(|source| source.id)
                .collect();
            brief.keep_documents(&ready);
            let value = serde_json::to_value(&brief)?;
            projects::save_brief(db, &id, &value, &fingerprint, truncated)?;
            // The project's event goes when the build ends.
            Ok(((), Vec::new()))
        })
        .await
        .map_err(|error| failed(error.to_string()))
}

/// The cost and the time of a build, for tuning the budget (design.md,
/// risks): not in `agent_calls`, which keeps the recordings' calls.
fn log_cost(project_id: &str, usage: &Usage, message: &input::BriefMessage) {
    let cost = usage
        .cost_usd
        .map_or_else(|| "?".to_owned(), |cost| format!("{cost:.4}"));
    eprintln!(
        "grill: brief of {project_id} built in {:.1} s, ${cost}; tokens in {} (cache read {}, \
         write {}), out {}; message {} chars{}",
        Duration::from_millis(usage.duration_ms).as_secs_f64(),
        usage.input_tokens,
        usage.cache_read,
        usage.cache_write,
        usage.output_tokens,
        message.text.chars().count(),
        if message.truncated { ", shortened" } else { "" },
    );
}

/// The stage events of one build, in order whatever thread sends them.
struct Stages {
    project_id: String,
    emit: Box<dyn Fn(BriefProgress) + Send + Sync>,
    /// The stage running now; 0 before the first.
    current: Mutex<u8>,
}

impl Stages {
    fn send(&self, stage: u8, state: BriefStageState) {
        (self.emit)(BriefProgress {
            project_id: self.project_id.clone(),
            stage,
            state,
        });
    }

    /// Ends the stages before `stage` and starts it; never goes back.
    fn advance(&self, stage: u8) {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        while *current < stage {
            if *current > 0 {
                self.send(*current, BriefStageState::Done);
            }
            *current += 1;
            self.send(*current, BriefStageState::Running);
        }
    }

    /// The stage running now ends with `state`.
    fn end(&self, state: BriefStageState) {
        let current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        self.send((*current).max(1), state);
    }

    fn finish(&self) {
        self.advance(LAST_STAGE);
        self.end(BriefStageState::Done);
    }
}

/// The build's rules as a file for `--system-prompt-file`; removed when
/// dropped.
struct PromptFile(PathBuf);

impl PromptFile {
    fn write(dir: &Path, project_id: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{project_id}.md"));
        std::fs::write(&path, PROMPT)?;
        Ok(Self(path))
    }
}

impl Drop for PromptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
