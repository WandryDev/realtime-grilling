//! The share of the subscription limit, one for the whole app, and the
//! thresholds of Grill (`specs/agent-limit`, agent-limit-guard design.md,
//! decisions 1–6).
//!
//! Two sources measure the session window (5 hours) and the week window
//! (all models): the free poll of `/usage` ([`usage`]) and the limit event
//! every agent call gets back ([`Metered`]). For each window the fresher
//! measure wins. From the measures and the thresholds of the settings the
//! [`LimitOutlook`] follows: `ok`, `near` (less than [`NEAR_MARGIN`]
//! points to a threshold) or `reached`. A reached threshold stops the
//! agent's calls until it lets go by itself: the window reset (a measure
//! whose reset time passed counts as 0), a new measure below it, a higher
//! threshold. «Продолжить сверх лимита» lets one recording's calls go
//! past it ([`SubscriptionLimit::allow_over`]).
//!
//! Every change goes to the windows as [`SubscriptionLimitChanged`], and to
//! the loops and the summaries through [`SubscriptionLimit::subscribe`].

pub mod app;
pub mod usage;

use std::{
    collections::HashSet,
    fmt,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use tokio::sync::{Notify, watch};

use super::{
    claude_cli::{Agent, AgentFuture, AgentRequest, WindowShare, WindowShares},
    process::TreeSlot,
};
use crate::storage::settings::{self, SettingsMap};

/// The warning before a call: a window this close to its threshold, in
/// percentage points (design.md, decision 9).
pub const NEAR_MARGIN: f64 = 10.0;
/// How often the app polls `/usage` while it runs.
pub const POLL_EVERY: Duration = Duration::from_secs(10 * 60);
/// The longest the reset timer sleeps before it looks at the wall clock
/// again: the async timers stop while the machine sleeps, the wall clock
/// doesn't.
const CLOCK_CHECK: Duration = Duration::from_secs(60);
/// Whole percents of a share given as a fraction (`0.29 * 100` is
/// `28.999…`).
const EPSILON: f64 = 1e-6;

/// The windows the thresholds watch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LimitWindow {
    /// The 5-hour session.
    Session,
    /// The week, all models.
    Week,
}

/// Who measured a window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MeasureSource {
    /// The poll of `/usage`.
    Usage,
    /// The limit event of an agent call.
    Call,
}

/// A window's last measure as the windows show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WindowMeasure {
    /// Whole percents used, 0–100; 0 once the reset time passed.
    pub used: u32,
    /// Unix ms; `null` when unknown, or once it passed.
    pub resets_at: Option<i64>,
    /// When it was measured, Unix ms.
    pub measured_at: i64,
    pub source: MeasureSource,
}

/// The thresholds of Grill in percents; `null`: «Без ограничения».
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LimitThresholds {
    pub session: Option<u32>,
    pub week: Option<u32>,
}

impl Default for LimitThresholds {
    /// As the settings' defaults: 90 % of the session, 80 % of the week.
    fn default() -> Self {
        Self {
            session: Some(settings::DEFAULT_AGENT_LIMIT_SESSION),
            week: Some(settings::DEFAULT_AGENT_LIMIT_WEEK),
        }
    }
}

impl LimitThresholds {
    /// `agentLimitSession` and `agentLimitWeek` of the settings.
    pub fn of(stored: &SettingsMap) -> Self {
        Self {
            session: settings::agent_limit(stored, settings::AGENT_LIMIT_SESSION),
            week: settings::agent_limit(stored, settings::AGENT_LIMIT_WEEK),
        }
    }

    const fn of_window(self, window: LimitWindow) -> Option<u32> {
        match window {
            LimitWindow::Session => self.session,
            LimitWindow::Week => self.week,
        }
    }
}

/// A window at or near its threshold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LimitHit {
    pub window: LimitWindow,
    /// Whole percents used.
    pub used: u32,
    pub threshold: u32,
    /// Unix ms, when known.
    pub resets_at: Option<i64>,
}

/// What the measures say of the thresholds (design.md, decision 4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LimitOutlook {
    /// Every window with a threshold is at least [`NEAR_MARGIN`] below it,
    /// or not known.
    Ok,
    /// A window is less than [`NEAR_MARGIN`] below its threshold: the one
    /// closest to it.
    Near { hit: LimitHit },
    /// A threshold is reached: the calls stop. With both, the window that
    /// resets later.
    Reached { hit: LimitHit },
}

/// The share of the limit as the windows show it: `call_agent_limit_get`
/// and every change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionLimitView {
    /// `null`: «нет данных».
    pub session: Option<WindowMeasure>,
    pub week: Option<WindowMeasure>,
    pub thresholds: LimitThresholds,
    pub outlook: LimitOutlook,
    /// A poll of `/usage` runs.
    pub checking: bool,
}

/// The share of the limit, its thresholds or its outlook changed. To
/// every window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionLimitChanged {
    pub limit: SubscriptionLimitView,
}

/// The wall clock, Unix ms: the reset times are on it.
#[derive(Clone)]
pub struct Clock(Arc<dyn Fn() -> i64 + Send + Sync>);

impl Clock {
    pub fn system() -> Self {
        Self(Arc::new(crate::storage::now_ms))
    }

    /// `start_ms` now, then on the runtime's clock: a paused test runtime
    /// moves it.
    #[cfg(test)]
    pub fn paused(start_ms: i64) -> Self {
        let base = tokio::time::Instant::now();
        Self(Arc::new(move || {
            start_ms + i64::try_from(base.elapsed().as_millis()).unwrap_or(i64::MAX)
        }))
    }

    pub fn now(&self) -> i64 {
        (self.0)()
    }
}

/// Told every change (the app emits [`SubscriptionLimitChanged`]).
pub type Listener = Arc<dyn Fn(&SubscriptionLimitView) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Measure {
    /// Percents, 0–100.
    used: f64,
    resets_at: Option<i64>,
    measured_at: i64,
    source: MeasureSource,
}

impl Measure {
    /// As of `now`: a window whose reset time passed is empty until the
    /// next measure.
    fn at(self, now: i64) -> Self {
        if self.resets_at.is_some_and(|resets_at| resets_at <= now) {
            Self {
                used: 0.0,
                resets_at: None,
                ..self
            }
        } else {
            self
        }
    }

    fn shown(self) -> u32 {
        // Saturating: a share is 0–100.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let whole = (self.used + EPSILON).floor().max(0.0) as u32;
        whole
    }
}

#[derive(Debug, Default)]
struct State {
    session: Option<Measure>,
    week: Option<Measure>,
    thresholds: LimitThresholds,
    checking: bool,
}

impl State {
    fn slot(&mut self, window: LimitWindow) -> &mut Option<Measure> {
        match window {
            LimitWindow::Session => &mut self.session,
            LimitWindow::Week => &mut self.week,
        }
    }

    const fn measure(&self, window: LimitWindow) -> Option<Measure> {
        match window {
            LimitWindow::Session => self.session,
            LimitWindow::Week => self.week,
        }
    }

    fn outlook(&self, now: i64) -> LimitOutlook {
        let mut reached: Option<LimitHit> = None;
        let mut near: Option<(f64, LimitHit)> = None;
        for window in [LimitWindow::Session, LimitWindow::Week] {
            let (Some(measure), Some(threshold)) =
                (self.measure(window), self.thresholds.of_window(window))
            else {
                continue;
            };
            let measure = measure.at(now);
            let hit = LimitHit {
                window,
                used: measure.shown(),
                threshold,
                resets_at: measure.resets_at,
            };
            let gap = f64::from(threshold) - measure.used;
            if gap <= EPSILON {
                // An unknown reset counts as the latest.
                let later = |hit: &LimitHit| hit.resets_at.unwrap_or(i64::MAX);
                if reached
                    .as_ref()
                    .is_none_or(|other| later(&hit) > later(other))
                {
                    reached = Some(hit);
                }
            } else if gap < NEAR_MARGIN && near.as_ref().is_none_or(|(other, _)| gap < *other) {
                near = Some((gap, hit));
            }
        }
        match (reached, near) {
            (Some(hit), _) => LimitOutlook::Reached { hit },
            (None, Some((_, hit))) => LimitOutlook::Near { hit },
            (None, None) => LimitOutlook::Ok,
        }
    }

    fn view(&self, now: i64) -> SubscriptionLimitView {
        let shown = |measure: Option<Measure>| {
            measure.map(|measure| {
                let measure = measure.at(now);
                WindowMeasure {
                    used: measure.shown(),
                    resets_at: measure.resets_at,
                    measured_at: measure.measured_at,
                    source: measure.source,
                }
            })
        };
        SubscriptionLimitView {
            session: shown(self.session),
            week: shown(self.week),
            thresholds: self.thresholds,
            outlook: self.outlook(now),
            checking: self.checking,
        }
    }

    /// The nearest reset time after `now`.
    fn next_reset(&self, now: i64) -> Option<i64> {
        [self.session, self.week]
            .into_iter()
            .flatten()
            .filter_map(|measure| measure.resets_at)
            .filter(|resets_at| *resets_at > now)
            .min()
    }
}

struct Inner {
    clock: Clock,
    state: Mutex<State>,
    /// The recordings whose calls go past the thresholds.
    over: Mutex<HashSet<String>>,
    generation: watch::Sender<u64>,
    listener: Mutex<Option<Listener>>,
    /// Wakes the reset timer: the measures changed.
    measures_changed: Notify,
    /// One poll at a time; a request during one joins it.
    poll: tokio::sync::Mutex<()>,
    polls: AtomicU64,
    /// The poll's CLI while it runs, for the app's exit to kill.
    poll_process: TreeSlot,
}

/// The share of the limit of the app. Managed as Tauri state; cheap to
/// clone, all clones are the same.
#[derive(Clone)]
pub struct SubscriptionLimit(Arc<Inner>);

impl fmt::Debug for SubscriptionLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("SubscriptionLimit")
            .field(&*self.state())
            .finish()
    }
}

impl Default for SubscriptionLimit {
    /// No measures (nothing ever stops), default thresholds, the system
    /// clock: the loops of the tests and of `grill-eval`.
    fn default() -> Self {
        Self::new(Clock::system(), LimitThresholds::default())
    }
}

/// Whether a build of the summary or the brief looks at the thresholds of
/// Grill (design.md, decisions 7 and 8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LimitPolicy {
    /// A reached threshold keeps the agent from being called.
    Respect,
    /// «Собрать сверх лимита»: the agent is called anyway.
    Over,
}

impl LimitPolicy {
    pub const fn over(over: bool) -> Self {
        if over { Self::Over } else { Self::Respect }
    }
}

/// How a [`SubscriptionLimit::refresh`] went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refresh {
    /// The poll measured both windows.
    Measured,
    /// It joined a poll that was running.
    Joined,
    /// The agent is not ready: no poll.
    NotReady,
    /// The poll failed or its text was not understood: the measures stay.
    Failed(String),
}

impl SubscriptionLimit {
    pub fn new(clock: Clock, thresholds: LimitThresholds) -> Self {
        Self(Arc::new(Inner {
            clock,
            state: Mutex::new(State {
                thresholds,
                ..State::default()
            }),
            over: Mutex::new(HashSet::new()),
            generation: watch::Sender::new(0),
            listener: Mutex::new(None),
            measures_changed: Notify::new(),
            poll: tokio::sync::Mutex::new(()),
            polls: AtomicU64::new(0),
            poll_process: TreeSlot::default(),
        }))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn over(&self) -> MutexGuard<'_, HashSet<String>> {
        self.0.over.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn now(&self) -> i64 {
        self.0.clock.now()
    }

    /// `listener` hears every change.
    pub fn on_change(&self, listener: Listener) {
        *self
            .0
            .listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(listener);
    }

    /// Changes from now on: the value is a counter, the news is that it
    /// moved.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.0.generation.subscribe()
    }

    pub fn view(&self) -> SubscriptionLimitView {
        let now = self.now();
        self.state().view(now)
    }

    pub fn outlook(&self) -> LimitOutlook {
        let now = self.now();
        self.state().outlook(now)
    }

    /// The threshold that stops the calls now, whatever the recording.
    pub fn reached(&self) -> Option<LimitHit> {
        match self.outlook() {
            LimitOutlook::Reached { hit } => Some(hit),
            LimitOutlook::Ok | LimitOutlook::Near { .. } => None,
        }
    }

    /// The guard before a call of `recording_id` (design.md, decision 5):
    /// the threshold that stops it, unless the recording goes past them.
    pub fn blocks(&self, recording_id: &str) -> Option<LimitHit> {
        if self.over().contains(recording_id) {
            return None;
        }
        self.reached()
    }

    /// «Продолжить сверх лимита»: the thresholds no longer stop the calls
    /// of `recording_id`.
    pub fn allow_over(&self, recording_id: &str) {
        let added = self.over().insert(recording_id.to_owned());
        if added {
            self.changed();
        }
    }

    /// The recording ended: a new one starts without the flag.
    pub fn forget(&self, recording_id: &str) {
        self.over().remove(recording_id);
    }

    /// New thresholds from the settings.
    pub fn set_thresholds(&self, thresholds: LimitThresholds) {
        let changed = {
            let mut state = self.state();
            let changed = state.thresholds != thresholds;
            state.thresholds = thresholds;
            changed
        };
        if changed {
            self.changed();
        }
    }

    /// A measure of `source` at `at` (Unix ms): each window it names takes
    /// it unless a fresher measure is there.
    pub fn observe(&self, source: MeasureSource, shares: WindowShares, at: i64) {
        if shares.is_empty() {
            return;
        }
        let changed = {
            let mut state = self.state();
            let mut changed = false;
            for (window, share) in [
                (LimitWindow::Session, shares.session),
                (LimitWindow::Week, shares.week),
            ] {
                let Some(WindowShare { used, resets_at }) = share else {
                    continue;
                };
                let slot = state.slot(window);
                if slot.is_some_and(|measure| measure.measured_at > at) {
                    continue;
                }
                *slot = Some(Measure {
                    used: (used * 100.0).clamp(0.0, 100.0),
                    resets_at,
                    measured_at: at,
                    source,
                });
                changed = true;
            }
            changed
        };
        if changed {
            self.changed();
        }
    }

    fn set_checking(&self, checking: bool) {
        self.state().checking = checking;
        self.changed();
    }

    fn changed(&self) {
        self.0.generation.send_modify(|generation| {
            *generation = generation.wrapping_add(1);
        });
        self.0.measures_changed.notify_one();
        let listener = self
            .0
            .listener
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(listener) = listener {
            listener(&self.view());
        }
    }

    /// Runs for the app's life: at each reset time the outlook may change,
    /// so the windows, the loops and the summaries hear of it then.
    pub async fn watch_resets(self) {
        loop {
            let now = self.now();
            let next = self.state().next_reset(now);
            let wait = next.map(|at| {
                Duration::from_millis(u64::try_from(at - now).unwrap_or(0)).min(CLOCK_CHECK)
            });
            tokio::select! {
                () = sleep(wait) => {
                    if next.is_some_and(|at| at <= self.now()) {
                        self.changed();
                    }
                }
                () = self.0.measures_changed.notified() => {}
            }
        }
    }

    /// Polls `/usage` once the agent is ready (`ready` gives the CLI and
    /// its work dir, `None` when it isn't). A request while a poll runs
    /// joins it.
    pub async fn refresh<F, Fut>(&self, ready: F) -> Refresh
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Option<(PathBuf, PathBuf)>>,
    {
        let seen = self.0.polls.load(Ordering::SeqCst);
        let _one = self.0.poll.lock().await;
        if self.0.polls.load(Ordering::SeqCst) != seen {
            return Refresh::Joined;
        }
        let outcome = self.poll(ready).await;
        self.0.polls.fetch_add(1, Ordering::SeqCst);
        outcome
    }

    async fn poll<F, Fut>(&self, ready: F) -> Refresh
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Option<(PathBuf, PathBuf)>>,
    {
        let Some((cli, cwd)) = ready().await else {
            return Refresh::NotReady;
        };
        self.set_checking(true);
        let clock = self.0.clock.clone();
        let polled = usage::poll(&cli, &cwd, &self.0.poll_process, usage::TIMEOUT, || {
            clock.now()
        })
        .await;
        let at = self.now();
        let outcome = match polled {
            Ok(shares) => {
                self.observe(MeasureSource::Usage, shares, at);
                Refresh::Measured
            }
            Err(message) => {
                eprintln!("grill: the subscription limit was not polled: {message}");
                Refresh::Failed(message)
            }
        };
        self.set_checking(false);
        outcome
    }

    /// The app exits: the poll's CLI is killed now.
    pub fn shutdown(&self) {
        self.0.poll_process.kill();
    }
}

async fn sleep(wait: Option<Duration>) {
    match wait {
        Some(wait) => tokio::time::sleep(wait).await,
        None => std::future::pending().await,
    }
}

/// An agent whose every reply also measures the limit: the limit event of
/// each call (both loops, the topic check, the summaries, the brief)
/// updates [`SubscriptionLimit`].
pub struct Metered {
    pub agent: Arc<dyn Agent>,
    pub limit: SubscriptionLimit,
}

impl Agent for Metered {
    fn run(
        &self,
        request: AgentRequest,
        cancel: tokio::sync::oneshot::Receiver<()>,
    ) -> AgentFuture<'_> {
        Box::pin(async move {
            let reply = self.agent.run(request, cancel).await;
            if let Ok(reply) = &reply {
                self.limit
                    .observe(MeasureSource::Call, reply.usage.windows, self.limit.now());
            }
            reply
        })
    }
}

#[cfg(test)]
mod tests;

/// The poll against a fake `claude` script, never the real CLI.
#[cfg(all(test, unix))]
mod fake_cli_tests;
