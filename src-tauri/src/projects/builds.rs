//! Which projects have a brief build running (projects-people-brief
//! design.md, decisions 4, 7 and 8), how to stop one, and which inputs
//! failed lately. In memory: a build does not survive the app, so neither
//! does its `building` state or a failure.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use tokio::sync::oneshot;

use crate::{
    agent::process::TreeSlot,
    storage::projects::{BriefState, Project},
};

/// How long `brief_prepare` leaves inputs alone after a build of them
/// failed: each attempt is a paid agent call. A manual build still runs.
pub const FAILED_BACKOFF: Duration = Duration::from_secs(60 * 60);

/// Managed as Tauri state; clones share the set.
#[derive(Debug, Clone, Default)]
pub struct BriefBuilds(Arc<Mutex<Builds>>);

#[derive(Debug, Default)]
struct Builds {
    running: HashMap<String, Control>,
    /// Per project: the fingerprint of the inputs its last build failed on,
    /// and when.
    failed: HashMap<String, (String, Instant)>,
}

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
    fn state(&self) -> MutexGuard<'_, Builds> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Claims the project for a build. `None` when one already runs (one
    /// build per project): join that one instead. The project reads as
    /// `building` until the returned slot is dropped; send the project's
    /// `DataChanged` after claiming and after dropping it so the windows
    /// re-read `briefState`.
    pub fn start(&self, project_id: &str) -> Option<BuildSlot> {
        let mut state = self.state();
        if state.running.contains_key(project_id) {
            return None;
        }
        let (cancel, cancelled) = oneshot::channel();
        let process = TreeSlot::default();
        let flag = Arc::new(AtomicBool::new(false));
        state.running.insert(
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
            fingerprint: None,
        })
    }

    pub fn is_building(&self, project_id: &str) -> bool {
        self.state().running.contains_key(project_id)
    }

    /// A build of these inputs of the project failed less than
    /// [`FAILED_BACKOFF`] ago: `brief_prepare` does not try them again.
    pub fn failed_lately(&self, project_id: &str, fingerprint: &str) -> bool {
        self.state()
            .failed
            .get(project_id)
            .is_some_and(|(failed, at)| failed == fingerprint && at.elapsed() < FAILED_BACKOFF)
    }

    /// Makes the project's last failure `by` older (the backoff in tests).
    #[cfg(test)]
    pub fn age_failure(&self, project_id: &str, by: Duration) {
        if let Some((_, at)) = self.state().failed.get_mut(project_id) {
            *at = at.checked_sub(by).unwrap_or(*at);
        }
    }

    /// Stops the project's build: kills the agent's process tree and ends
    /// its call. `false` when none runs.
    pub fn cancel(&self, project_id: &str) -> bool {
        let mut state = self.state();
        let Some(control) = state.running.get_mut(project_id) else {
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
        for control in self.state().running.values() {
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
    /// What the build is made from, once read.
    fingerprint: Option<String>,
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

    /// The flag [`BriefBuilds::cancel`] sets, for a check under the
    /// database lock just before saving.
    pub fn cancel_flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancelled)
    }

    /// The fingerprint of the inputs this build is made from.
    pub fn set_fingerprint(&mut self, fingerprint: String) {
        self.fingerprint = Some(fingerprint);
    }

    /// The build failed: `brief_prepare` leaves its inputs alone for a while.
    /// Nothing is kept when the inputs were not read yet.
    pub fn failed(&self) {
        if let Some(fingerprint) = &self.fingerprint {
            self.builds.state().failed.insert(
                self.project_id.clone(),
                (fingerprint.clone(), Instant::now()),
            );
        }
    }

    /// The build saved a brief: an earlier failure is forgotten.
    pub fn succeeded(&self) {
        self.builds.state().failed.remove(&self.project_id);
    }
}

impl Drop for BuildSlot {
    fn drop(&mut self) {
        self.builds.state().running.remove(&self.project_id);
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

    #[test]
    fn a_failure_is_remembered_per_inputs_for_the_backoff() {
        let builds = BriefBuilds::default();
        let mut slot = builds.start("a").unwrap();
        // Before the inputs were read nothing is kept.
        slot.failed();
        assert!(!builds.failed_lately("a", "f1"));
        slot.set_fingerprint("f1".to_owned());
        slot.failed();
        drop(slot);
        assert!(builds.failed_lately("a", "f1"));
        assert!(!builds.failed_lately("a", "f2"));
        assert!(!builds.failed_lately("b", "f1"));

        builds.age_failure("a", FAILED_BACKOFF - Duration::from_secs(60));
        assert!(builds.failed_lately("a", "f1"));
        builds.age_failure("a", Duration::from_secs(61));
        assert!(!builds.failed_lately("a", "f1"));

        // A success forgets it.
        let mut slot = builds.start("a").unwrap();
        slot.set_fingerprint("f1".to_owned());
        slot.failed();
        assert!(builds.failed_lately("a", "f1"));
        slot.succeeded();
        assert!(!builds.failed_lately("a", "f1"));
    }
}
