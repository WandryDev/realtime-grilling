//! Which projects have a brief build running (projects-people-brief
//! design.md, decisions 4 and 7), and how to stop one. In memory: a build
//! does not survive the app, so neither does its `building` state.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
};

use tokio::sync::oneshot;

use crate::{
    agent::process::TreeSlot,
    storage::projects::{BriefState, Project},
};

/// Managed as Tauri state; clones share the set.
#[derive(Debug, Clone, Default)]
pub struct BriefBuilds(Arc<Mutex<HashMap<String, Control>>>);

/// How a running build is stopped from outside its task.
#[derive(Debug)]
struct Control {
    /// Stops the agent call; taken by the first cancel.
    cancel: Option<oneshot::Sender<()>>,
    /// The CLI's process tree, killed at once by a cancel or the app's exit.
    process: TreeSlot,
    cancelled: Arc<AtomicBool>,
}

impl BriefBuilds {
    fn set(&self) -> MutexGuard<'_, HashMap<String, Control>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Claims the project for a build. `None` when one already runs (one
    /// build per project): join that one instead. The project reads as
    /// `building` until the returned slot is dropped; send the project's
    /// `DataChanged` after claiming and after dropping it so the windows
    /// re-read `briefState`.
    pub fn start(&self, project_id: &str) -> Option<BuildSlot> {
        let mut set = self.set();
        if set.contains_key(project_id) {
            return None;
        }
        let (cancel, cancelled) = oneshot::channel();
        let process = TreeSlot::default();
        let flag = Arc::new(AtomicBool::new(false));
        set.insert(
            project_id.to_owned(),
            Control {
                cancel: Some(cancel),
                process: process.clone(),
                cancelled: Arc::clone(&flag),
            },
        );
        Some(BuildSlot {
            builds: self.clone(),
            project_id: project_id.to_owned(),
            cancel: Some(cancelled),
            process,
            cancelled: flag,
        })
    }

    pub fn is_building(&self, project_id: &str) -> bool {
        self.set().contains_key(project_id)
    }

    /// Stops the project's build: kills the agent's process tree and ends
    /// its call. `false` when none runs.
    pub fn cancel(&self, project_id: &str) -> bool {
        let mut set = self.set();
        let Some(control) = set.get_mut(project_id) else {
            return false;
        };
        control.cancelled.store(true, Ordering::SeqCst);
        control.process.kill();
        if let Some(cancel) = control.cancel.take() {
            let _ = cancel.send(());
        }
        true
    }

    /// The app's exit: kills every build's CLI (it runs in its own process
    /// group and would outlive the app).
    pub fn shutdown(&self) {
        for control in self.set().values() {
            control.cancelled.store(true, Ordering::SeqCst);
            control.process.kill();
        }
    }

    /// Sets `briefState` to `building` when a build of the project runs.
    pub fn mark(&self, mut project: Project) -> Project {
        if self.is_building(&project.id) {
            project.brief_state = BriefState::Building;
        }
        project
    }

    pub fn mark_all(&self, projects: Vec<Project>) -> Vec<Project> {
        projects
            .into_iter()
            .map(|project| self.mark(project))
            .collect()
    }
}

/// A running build of a project; dropping it ends the `building` state.
#[derive(Debug)]
pub struct BuildSlot {
    builds: BriefBuilds,
    project_id: String,
    cancel: Option<oneshot::Receiver<()>>,
    process: TreeSlot,
    cancelled: Arc<AtomicBool>,
}

impl BuildSlot {
    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    /// For the agent call: fires on [`BriefBuilds::cancel`]. `None` once
    /// taken.
    pub fn take_cancel(&mut self) -> Option<oneshot::Receiver<()>> {
        self.cancel.take()
    }

    /// For the agent call: where its process tree is kept.
    pub fn process(&self) -> TreeSlot {
        self.process.clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for BuildSlot {
    fn drop(&mut self) {
        self.builds.set().remove(&self.project_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_build_per_project_until_the_slot_drops() {
        let builds = BriefBuilds::default();
        let slot = builds.start("a").unwrap();
        assert!(builds.start("a").is_none());
        assert!(builds.is_building("a"));
        let other = builds.start("b").unwrap();
        drop(slot);
        assert!(!builds.is_building("a"));
        assert!(builds.is_building(other.project_id()));
        assert!(builds.start("a").is_some());
    }

    #[test]
    fn a_cancel_reaches_the_slot_and_only_a_running_build() {
        let builds = BriefBuilds::default();
        assert!(!builds.cancel("a"));
        let mut slot = builds.start("a").unwrap();
        let mut cancelled = slot.take_cancel().unwrap();
        assert!(slot.take_cancel().is_none());
        assert!(!slot.is_cancelled());
        assert!(builds.cancel("a"));
        assert!(slot.is_cancelled());
        assert!(cancelled.try_recv().is_ok());
        // A second cancel is harmless.
        assert!(builds.cancel("a"));
        drop(slot);
        assert!(!builds.cancel("a"));
    }
}
