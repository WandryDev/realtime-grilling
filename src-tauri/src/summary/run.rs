//! Running a summary build (design.md, decisions 1–6): in the background,
//! one per call, through the stages of [`SummaryStage`].
//!
//! - `transcript`: the summary reads `building` (`start_building`), the
//!   build waits for the second pass ([`transcript::wait_for_passes`]) and
//!   reads the inputs. A call without any transcript fails here: there is
//!   nothing to pay an agent call for.
//! - `summary`: call A; a reply that is not one fails the build, the
//!   previous summary stays.
//! - `proposals`: call B, only with a project. Its failure fails only this
//!   stage: the summary is saved and the previous pending proposals stay.
//! - `saving`: the checks, then one transaction (`save_build`).
//!
//! Every write first checks, under the database lock, that this build is
//! still the call's and was not stopped: a stop that came after the reply
//! saves nothing. At its end the build closes the call (the call's
//! manager does nothing unless the call is still finishing), unless it was
//! aborted ("Отменить завершение", "Удалить все данные", a delete) or the
//! app exits.

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event as _;
use tokio::sync::broadcast;

use super::{
    CANCELLED, EFFORT, MODEL, PROPOSALS_CLOSING, PROPOSALS_PROMPT, REFINE_SILENCE, SUMMARY_CLOSING,
    SUMMARY_PROMPT, SummaryCounts, SummaryProgress, SummaryStage, SummaryStageState, TIMEOUT,
    builds::{BuildSlot, Stop, SummaryBuilds},
    input::{self, SummaryMessage},
    proposals_schema_argument,
    reply::{ProposalsReply, SummaryReply},
    summary_schema_argument,
    transcript::{self, Waited},
    validate::{self, Knowledge},
};
use crate::{
    agent::claude_cli::{Agent, AgentError, AgentRequest, CallOptions, OutputKind, Usage},
    call::CallManager,
    error::CommandError,
    events::EventSink,
    projects::brief::run::{AgentLookup, BriefHost},
    speech::{events::TranscriptRefine, refiner::Refiner},
    storage::{
        Storage, calls, people, projects,
        proposals::ProposalDecision,
        summaries::{self, SummaryBuild},
    },
};

pub type CloseFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// What a build needs from the app; tests give their own.
pub trait SummaryHost: EventSink + 'static {
    fn storage(&self) -> Option<&Storage>;
    /// To every window.
    fn progress(&self, progress: SummaryProgress);
    /// The agent when its status is `ready`, else what to show.
    fn agent(&self) -> AgentLookup<'_>;
    /// Where the prompt files of running builds go.
    fn prompt_dir(&self) -> PathBuf;
    /// The second pass's progress from now on.
    fn refine_news(&self) -> broadcast::Receiver<TranscriptRefine>;
    /// The build ended: the call is closed if it is still finishing.
    fn close_call(&self, call_id: &str) -> CloseFuture<'_>;
    /// Questions of the recording changed (`CallStateChanged`).
    fn call_state_changed(&self, recording_id: &str);
    /// How long `transcript` waits without news of the second pass.
    fn silence(&self) -> Duration {
        REFINE_SILENCE
    }
}

impl<R: Runtime> SummaryHost for AppHandle<R> {
    fn storage(&self) -> Option<&Storage> {
        self.try_state::<Storage>().map(|state| state.inner())
    }

    fn progress(&self, progress: SummaryProgress) {
        if let Err(error) = progress.emit(self) {
            eprintln!("grill: failed to emit summary-progress: {error}");
        }
    }

    fn agent(&self) -> AgentLookup<'_> {
        // The brief's check: the CLI found, installed and logged in.
        BriefHost::agent(self)
    }

    fn prompt_dir(&self) -> PathBuf {
        crate::agent::fast_loop::app::work_dir(self).join("summaries")
    }

    fn refine_news(&self) -> broadcast::Receiver<TranscriptRefine> {
        self.try_state::<Refiner>().map_or_else(
            // No second pass in the app: no news, the silence ends the wait.
            || broadcast::channel(1).1,
            |refiner| refiner.subscribe(),
        )
    }

    fn close_call(&self, call_id: &str) -> CloseFuture<'_> {
        let calls = self
            .try_state::<CallManager>()
            .map(|calls| calls.inner().clone());
        let call_id = call_id.to_owned();
        Box::pin(async move {
            let Some(calls) = calls else {
                return;
            };
            match calls.close(&call_id).await {
                // Not the current call: closed already (the window's own
                // close, or a rebuild of a finished call).
                Ok(_) | Err(CommandError::Invalid { .. } | CommandError::NotFound { .. }) => {}
                Err(error) => eprintln!("grill: the call {call_id} was not closed: {error}"),
            }
        })
    }

    fn call_state_changed(&self, recording_id: &str) {
        crate::agent::fast_loop::app::call_state_changed(self, recording_id);
    }
}

/// Starts a build of the call unless one runs (then `None`: follow its
/// progress). Returns at once.
pub fn start<H: SummaryHost>(
    host: &Arc<H>,
    builds: &SummaryBuilds,
    call_id: &str,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let slot = builds.start(call_id)?;
    let host = Arc::clone(host);
    Some(tauri::async_runtime::spawn(async move {
        build(&host, slot).await;
    }))
}

/// «Остановить» (`summary_cancel`): the build stops, saves nothing and
/// closes the call, its summary `failed` / [`CANCELLED`]. Without a build
/// a call still finishing is closed all the same.
pub async fn stop<H: SummaryHost>(host: &H, builds: &SummaryBuilds, call_id: &str) {
    if !builds.stop(call_id, Stop::Stopped) {
        host.close_call(call_id).await;
    }
}

/// How a build ended short of a saved summary.
#[derive(Debug)]
enum End {
    Failed(String),
    Cancelled,
}

fn failed(message: impl Into<String>) -> End {
    End::Failed(message.into())
}

fn unless_stopped(slot: &BuildSlot) -> Result<(), End> {
    match slot.stopped() {
        Some(_) => Err(End::Cancelled),
        None => Ok(()),
    }
}

/// A storage error as the end of the build: the call or its project gone
/// meanwhile is a cancel, not a failure.
fn storage_end(error: CommandError) -> End {
    match error {
        CommandError::NotFound { .. } => End::Cancelled,
        error => failed(error.to_string()),
    }
}

async fn build<H: SummaryHost>(host: &Arc<H>, slot: BuildSlot) {
    let emit_host = Arc::clone(host);
    let stages = Stages {
        call_id: slot.call_id().to_owned(),
        builds: slot.builds().clone(),
        generation: slot.generation(),
        emit: Box::new(move |progress| emit_host.progress(progress)),
        state: Mutex::new(StagesState::default()),
    };
    let call_id = slot.call_id().to_owned();
    let outcome = attempt(host.as_ref(), &slot, &stages).await;
    let (last, close) = match outcome {
        Ok(()) => (SummaryStageState::Done, true),
        Err(End::Failed(message)) => {
            eprintln!("grill: the summary of {call_id} was not built: {message}");
            write_failed(host.as_ref(), &slot, &message).await;
            (SummaryStageState::Failed { message }, true)
        }
        Err(End::Cancelled) => {
            let stop = slot.stopped();
            if stop != Some(Stop::Shutdown) {
                write_failed(host.as_ref(), &slot, CANCELLED).await;
            }
            (SummaryStageState::Cancelled, stop == Some(Stop::Stopped))
        }
    };
    // The call is free for a new build before anyone hears this one ended.
    drop(slot);
    match last {
        SummaryStageState::Done => stages.finish(),
        state => stages.end(state),
    }
    if close {
        host.close_call(&call_id).await;
    }
}

/// The summary becomes `failed` with `message` (a saved one stays), if
/// this build is still the call's.
async fn write_failed<H: SummaryHost>(host: &H, slot: &BuildSlot, message: &str) {
    let Some(storage) = host.storage() else {
        return;
    };
    let (builds, call_id, generation) = (
        slot.builds().clone(),
        slot.call_id().to_owned(),
        slot.generation(),
    );
    let message = message.to_owned();
    let written = storage
        .write(host, move |db| {
            if !builds.is_current(&call_id, generation) {
                return Ok(((), Vec::new()));
            }
            summaries::save_failed(db, &call_id, &message).map(|(_, events)| ((), events))
        })
        .await;
    match written {
        Ok(()) | Err(CommandError::NotFound { .. }) => {}
        Err(error) => eprintln!(
            "grill: the failed summary of {} was not written: {error}",
            slot.call_id()
        ),
    }
}

async fn attempt<H: SummaryHost>(host: &H, slot: &BuildSlot, stages: &Stages) -> Result<(), End> {
    stages.advance(SummaryStage::Transcript);
    let storage = host
        .storage()
        .ok_or_else(|| failed("Хранилище ещё не открыто"))?;
    let call_id = slot.call_id().to_owned();
    let guard = Guard::of(slot);

    // The summary reads `building` from now on.
    let id = call_id.clone();
    let started = guard.clone();
    let call = storage
        .write(host, move |db| {
            if !started.holds() {
                return Ok((None, Vec::new()));
            }
            let call = calls::get(db, &id)?;
            let (_, events) = summaries::start_building(db, &id)?;
            Ok((Some(call), events))
        })
        .await
        .map_err(storage_end)?
        .ok_or(End::Cancelled)?;
    slot.set_project(call.project_id.clone());

    // The second pass of every recording, or a minute of silence.
    let mut news = host.refine_news();
    let read = || {
        let id = call_id.clone();
        storage.read(move |db| transcript::recordings_of(db, &id))
    };
    let waited = tokio::select! {
        waited = transcript::wait_for_passes(read, &mut news, host.silence()) => {
            waited.map_err(storage_end)?
        }
        _ = slot.arm() => return Err(End::Cancelled),
    };
    let id = call_id.clone();
    let inputs = storage
        .read(move |db| input::read(db, &id))
        .await
        .map_err(storage_end)?;
    if waited == Waited::Silence {
        eprintln!(
            "grill: the summary of {call_id} goes on without the second pass of some recordings \
             ({:?})",
            inputs.transcript.pass
        );
    }
    if inputs.transcript.segment_count() == 0 {
        return Err(failed("В звонке нет расшифровки: итоги не из чего собрать"));
    }
    let message = input::compose(&inputs).map_err(End::Failed)?;
    let pass = inputs.transcript.pass;
    stages.set_counts(SummaryCounts {
        segments: u32::try_from(message.segment_count).unwrap_or(u32::MAX),
        topics: u32::try_from(message.topics.len()).unwrap_or(u32::MAX),
        transcript_pass: pass,
        proposals: None,
    });
    unless_stopped(slot)?;

    stages.advance(SummaryStage::Summary);
    let agent = host.agent().await.map_err(End::Failed)?;
    unless_stopped(slot)?;
    let reply = ask(host, slot, &agent, Ask::Summary, &message).await?;
    let reply = SummaryReply::from_reply(reply)
        .map_err(|error| failed(format!("Агент ответил не по схеме итогов: {error}")))?;
    let mut checked = validate::summary(reply, &message, pass);
    stages.update_counts(|counts| {
        counts.topics = u32::try_from(checked.summary.content.topics.len()).unwrap_or(u32::MAX);
    });
    unless_stopped(slot)?;

    let has_project = call.project_id.is_some();
    let proposals = if has_project {
        stages.advance(SummaryStage::Proposals);
        match ask(host, slot, &agent, Ask::Proposals, &message).await {
            Ok(reply) => match ProposalsReply::from_reply(reply) {
                Ok(reply) => Some(reply),
                Err(error) => {
                    stages.fail_current(format!("Агент ответил не по схеме предложений: {error}"));
                    None
                }
            },
            Err(End::Cancelled) => return Err(End::Cancelled),
            Err(End::Failed(message)) => {
                eprintln!("grill: the proposals of {call_id} were not built: {message}");
                stages.fail_current(message);
                None
            }
        }
    } else {
        Some(ProposalsReply {
            proposals: Vec::new(),
        })
    };
    unless_stopped(slot)?;

    stages.advance(SummaryStage::Saving);
    let id = call_id.clone();
    let saving = guard.clone();
    let mut dropped = std::mem::take(&mut checked.dropped);
    let saved = storage
        .write(host, move |db| {
            if !saving.holds() {
                return Ok((None, Vec::new()));
            }
            // `before` from the brief and the profiles as they are now.
            let call = calls::get(db, &id)?;
            let (brief, people) = match &call.project_id {
                Some(project_id) => (
                    projects::get(db, project_id)?.brief,
                    people::list(db, project_id)?,
                ),
                None => (None, Vec::new()),
            };
            let knowledge = Knowledge {
                brief: brief.as_ref(),
                people: &people,
            };
            let proposals = proposals.map(|reply| {
                validate::proposals(reply, &message, has_project, &knowledge, &mut dropped)
            });
            let build = SummaryBuild {
                summary: checked.summary,
                proposals,
                answered: checked.answered,
            };
            let (saved, events) = summaries::save_build(db, &id, &build)?;
            Ok((Some((saved, dropped)), events))
        })
        .await
        .map_err(storage_end)?;
    let Some((saved, dropped)) = saved else {
        return Err(End::Cancelled);
    };
    for reason in &dropped {
        eprintln!("grill: the summary of {call_id} dropped {reason}");
    }
    for recording_id in &saved.answered.recording_ids {
        host.call_state_changed(recording_id);
    }
    let pending = saved
        .proposals
        .iter()
        .filter(|proposal| proposal.decision == ProposalDecision::Pending)
        .count();
    stages.update_counts(|counts| {
        counts.proposals = Some(u32::try_from(pending).unwrap_or(u32::MAX));
    });
    Ok(())
}

/// The check before every write, under the database lock: this build is
/// still the call's and was not stopped.
#[derive(Clone)]
struct Guard {
    builds: SummaryBuilds,
    call_id: String,
    generation: u64,
}

impl Guard {
    fn of(slot: &BuildSlot) -> Self {
        Self {
            builds: slot.builds().clone(),
            call_id: slot.call_id().to_owned(),
            generation: slot.generation(),
        }
    }

    fn holds(&self) -> bool {
        self.builds
            .running_and_not_stopped(&self.call_id, self.generation)
    }
}

/// One of the two agent calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ask {
    /// Call A.
    Summary,
    /// Call B.
    Proposals,
}

impl Ask {
    fn name(self) -> &'static str {
        match self {
            Self::Summary => "summary",
            Self::Proposals => "proposals",
        }
    }
}

/// Runs one agent call and returns its reply, not checked yet.
async fn ask<H: SummaryHost>(
    host: &H,
    slot: &BuildSlot,
    agent: &Arc<dyn Agent>,
    ask: Ask,
    message: &SummaryMessage,
) -> Result<Value, End> {
    let (rules, closing, schema) = match ask {
        Ask::Summary => (SUMMARY_PROMPT, SUMMARY_CLOSING, summary_schema_argument()),
        Ask::Proposals => (
            PROPOSALS_PROMPT,
            PROPOSALS_CLOSING,
            proposals_schema_argument(),
        ),
    };
    let name = format!("{}-{}", slot.call_id(), ask.name());
    let prompt = PromptFile::write(&host.prompt_dir(), &name, rules)
        .map_err(|error| failed(format!("Не удалось записать промпт итогов: {error}")))?;
    let user_message = message.for_call(closing);
    let chars = user_message.chars().count();
    let request = AgentRequest {
        system_prompt_file: prompt.0.clone(),
        user_message,
        schema: schema.to_owned(),
        process: slot.process(),
        options: CallOptions {
            model: Some(MODEL),
            effort: Some(EFFORT),
            timeout: Some(TIMEOUT),
            output: OutputKind::Object,
            on_output: None,
        },
    };
    let reply = agent.run(request, slot.arm()).await;
    drop(prompt);
    match reply {
        Ok(reply) => {
            log_cost(slot.call_id(), ask, &reply.usage, chars, message.shortened);
            Ok(reply.patch)
        }
        Err(_) if slot.stopped().is_some() => Err(End::Cancelled),
        Err(AgentError::Cancelled) => Err(End::Cancelled),
        Err(error) => Err(failed(error.to_string())),
    }
}

/// The cost and the time of a call (design.md, risks): not in
/// `agent_calls`, which keeps the recordings' calls.
fn log_cost(call_id: &str, ask: Ask, usage: &Usage, chars: usize, shortened: bool) {
    let cost = usage
        .cost_usd
        .map_or_else(|| "?".to_owned(), |cost| format!("{cost:.4}"));
    eprintln!(
        "grill: {} of call {call_id} in {:.1} s, ${cost}; tokens in {} (cache read {}, write \
         {}), out {}; message {chars} chars{}",
        ask.name(),
        Duration::from_millis(usage.duration_ms).as_secs_f64(),
        usage.input_tokens,
        usage.cache_read,
        usage.cache_write,
        usage.output_tokens,
        if shortened { ", shortened" } else { "" },
    );
}

#[derive(Debug, Default)]
struct StagesState {
    /// The stage running now; `None` before the first, and after the
    /// running one failed without ending the build.
    current: Option<SummaryStage>,
    /// The last stage started.
    reached: Option<SummaryStage>,
    counts: Option<SummaryCounts>,
}

/// The stage events of one build, in order whatever thread sends them.
struct Stages {
    call_id: String,
    builds: SummaryBuilds,
    generation: u64,
    emit: Box<dyn Fn(SummaryProgress) + Send + Sync>,
    state: Mutex<StagesState>,
}

impl Stages {
    fn lock(&self) -> std::sync::MutexGuard<'_, StagesState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn send(&self, stage: SummaryStage, state: SummaryStageState, counts: Option<SummaryCounts>) {
        let progress = SummaryProgress {
            call_id: self.call_id.clone(),
            stage,
            state,
            counts,
        };
        self.builds
            .record(&self.call_id, self.generation, &progress);
        (self.emit)(progress);
    }

    /// Ends the running stage and starts `stage`.
    fn advance(&self, stage: SummaryStage) {
        let mut state = self.lock();
        if state.current == Some(stage) {
            return;
        }
        if let Some(current) = state.current {
            self.send(current, SummaryStageState::Done, state.counts.clone());
        }
        state.current = Some(stage);
        state.reached = Some(stage);
        self.send(stage, SummaryStageState::Running, state.counts.clone());
    }

    /// The running stage failed, the build goes on.
    fn fail_current(&self, message: String) {
        let mut state = self.lock();
        if let Some(current) = state.current.take() {
            self.send(
                current,
                SummaryStageState::Failed { message },
                state.counts.clone(),
            );
        }
    }

    fn set_counts(&self, counts: SummaryCounts) {
        self.lock().counts = Some(counts);
    }

    fn update_counts(&self, update: impl FnOnce(&mut SummaryCounts)) {
        if let Some(counts) = self.lock().counts.as_mut() {
            update(counts);
        }
    }

    /// The build ends with `state` at the stage it reached.
    fn end(&self, end: SummaryStageState) {
        let state = self.lock();
        let stage = state.reached.unwrap_or(SummaryStage::Transcript);
        self.send(stage, end, state.counts.clone());
    }

    /// `(saving, done)`.
    fn finish(&self) {
        self.advance(SummaryStage::Saving);
        self.end(SummaryStageState::Done);
    }
}

/// The rules of a call as a file for `--system-prompt-file`; removed when
/// dropped.
struct PromptFile(PathBuf);

impl PromptFile {
    fn write(dir: &Path, name: &str, rules: &str) -> std::io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(format!("{name}.md"));
        std::fs::write(&path, rules)?;
        Ok(Self(path))
    }
}

impl Drop for PromptFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
