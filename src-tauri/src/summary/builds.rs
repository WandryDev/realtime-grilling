//! Which calls have a summary build running (post-call design.md, decision
//! 1), how to stop one and where it is. In memory, like `BriefBuilds`: a
//! build does not survive the app; the next start reads what it left as
//! `failed` / `interrupted` (`summaries::interrupt_building`).
//!
//! One build per call. A stopped build may still be winding down when the
//! call needs a new one ("Отменить завершение", then "Завершить" again):
//! the new build takes the call's place, and the old one, no longer
//! [`current`](SummaryBuilds::is_current), writes nothing more.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use tokio::sync::oneshot;

use super::SummaryProgress;
use crate::agent::process::TreeSlot;

/// Why a build was stopped. The first reason stays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// «Остановить» (`summary_cancel`): the summary is `failed` /
    /// [`CANCELLED`](super::CANCELLED) and the call is closed.
    Stopped,
    /// "Отменить завершение", "Удалить все данные", the call or its project
    /// deleted: nothing is saved and the call is left as it is.
    Aborted,
    /// The app exits: nothing is written, the next start tidies up.
    Shutdown,
}

/// Managed as Tauri state; clones share the set.
#[derive(Debug, Clone, Default)]
pub struct SummaryBuilds(Arc<Mutex<Builds>>);

#[derive(Debug, Default)]
struct Builds {
    running: HashMap<String, Control>,
    /// The last generation handed out.
    generation: u64,
}

/// How a running build is reached from outside its task.
#[derive(Debug)]
struct Control {
    generation: u64,
    /// Set once the build knows its call's project.
    project_id: Option<String>,
    stop: Option<Stop>,
    /// Ends the agent call running now; replaced for each call.
    cancel: Option<oneshot::Sender<()>>,
    /// The CLI's process tree, killed at once by a stop.
    process: TreeSlot,
    /// The last progress the build sent, for a window that opens late.
    last: Option<SummaryProgress>,
}

impl Control {
    fn stop(&mut self, reason: Stop) {
        self.stop.get_or_insert(reason);
        self.process.kill();
        if let Some(cancel) = self.cancel.take() {
            let _ = cancel.send(());
        }
    }
}

impl SummaryBuilds {
    fn state(&self) -> MutexGuard<'_, Builds> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Claims the call for a build. `None` while a build of it runs and was
    /// not stopped (one build per call): follow that one instead. A stopped
    /// one gives its place to the new build.
    pub fn start(&self, call_id: &str) -> Option<BuildSlot> {
        let mut state = self.state();
        if state
            .running
            .get(call_id)
            .is_some_and(|control| control.stop.is_none())
        {
            return None;
        }
        state.generation += 1;
        let generation = state.generation;
        let process = TreeSlot::default();
        state.running.insert(
            call_id.to_owned(),
            Control {
                generation,
                project_id: None,
                stop: None,
                cancel: None,
                process: process.clone(),
                last: None,
            },
        );
        Some(BuildSlot {
            builds: self.clone(),
            call_id: call_id.to_owned(),
            generation,
            process,
        })
    }

    /// A build of the call runs (also one stopped and winding down).
    pub fn is_building(&self, call_id: &str) -> bool {
        self.state().running.contains_key(call_id)
    }

    /// The last progress of the call's running build.
    pub fn progress(&self, call_id: &str) -> Option<SummaryProgress> {
        self.state()
            .running
            .get(call_id)
            .and_then(|control| control.last.clone())
    }

    /// Stops the call's build: kills the agent's process tree and ends its
    /// call. `false` when none runs.
    pub fn stop(&self, call_id: &str, reason: Stop) -> bool {
        let mut state = self.state();
        let Some(control) = state.running.get_mut(call_id) else {
            return false;
        };
        control.stop(reason);
        true
    }

    /// The project is deleted: its calls' builds stop, saving nothing.
    pub fn stop_project(&self, project_id: &str) {
        for control in self.state().running.values_mut() {
            if control.project_id.as_deref() == Some(project_id) {
                control.stop(Stop::Aborted);
            }
        }
    }

    /// The app's exit: kills every build's CLI (it runs in its own process
    /// group and would outlive the app).
    pub fn shutdown(&self) {
        for control in self.state().running.values_mut() {
            control.stop(Stop::Shutdown);
        }
    }

    /// Whether `generation` is the call's build. Checked under the database
    /// lock before every write of a build.
    pub fn is_current(&self, call_id: &str, generation: u64) -> bool {
        self.state()
            .running
            .get(call_id)
            .is_some_and(|control| control.generation == generation)
    }

    fn with<T>(
        &self,
        call_id: &str,
        generation: u64,
        work: impl FnOnce(&mut Control) -> T,
    ) -> Option<T> {
        let mut state = self.state();
        state
            .running
            .get_mut(call_id)
            .filter(|control| control.generation == generation)
            .map(work)
    }
}

/// A running build of a call; dropping it ends the build's claim.
#[derive(Debug)]
pub struct BuildSlot {
    builds: SummaryBuilds,
    call_id: String,
    generation: u64,
    process: TreeSlot,
}

impl BuildSlot {
    pub fn call_id(&self) -> &str {
        &self.call_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn builds(&self) -> &SummaryBuilds {
        &self.builds
    }

    /// Why it was stopped; `None` while it may go on. A build that lost its
    /// place reads as aborted.
    pub fn stopped(&self) -> Option<Stop> {
        self.builds
            .with(&self.call_id, self.generation, |control| control.stop)
            .unwrap_or(Some(Stop::Aborted))
    }

    pub fn set_project(&self, project_id: Option<String>) {
        self.builds.with(&self.call_id, self.generation, |control| {
            control.project_id = project_id;
        });
    }

    /// For one agent call: fires on a stop, at once when the build was
    /// stopped already.
    pub fn arm(&self) -> oneshot::Receiver<()> {
        let (cancel, cancelled) = oneshot::channel();
        let mut cancel = Some(cancel);
        self.builds.with(&self.call_id, self.generation, |control| {
            if control.stop.is_none() {
                control.cancel = cancel.take();
            }
        });
        // Stopped already, or no longer the call's build.
        if let Some(cancel) = cancel {
            let _ = cancel.send(());
        }
        cancelled
    }

    /// For the agent calls: where their process tree is kept.
    pub fn process(&self) -> TreeSlot {
        self.process.clone()
    }

    /// Keeps the progress a window opening late reads.
    pub fn record(&self, progress: &SummaryProgress) {
        self.builds.with(&self.call_id, self.generation, |control| {
            control.last = Some(progress.clone());
        });
    }
}

impl Drop for BuildSlot {
    fn drop(&mut self) {
        let mut state = self.builds.state();
        if state
            .running
            .get(&self.call_id)
            .is_some_and(|control| control.generation == self.generation)
        {
            state.running.remove(&self.call_id);
        }
    }
}
