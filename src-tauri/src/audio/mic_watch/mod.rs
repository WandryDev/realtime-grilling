//! "Микрофон занят другим приложением" (`specs/mic-activity`, design.md
//! decisions 1–6): a watcher per OS reports who captures from an input,
//! [`state::Debouncer`] turns that into busy / free, the windows get
//! [`MicActivityChanged`] and Rust shows the start widget on busy.
//!
//! The watcher never opens an input device and needs no microphone access.

#[cfg(target_os = "macos")]
mod mac;
pub mod names;
pub mod state;
#[cfg(windows)]
mod win;

use std::{
    sync::{
        Arc, Mutex, MutexGuard, PoisonError, RwLock,
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_specta::Event;

use self::state::{Activity, Debouncer, Holder, Transition};
use crate::{
    events::Navigate,
    shell::windows,
    storage::{
        Storage,
        settings::{self, MicBusyBehavior},
    },
};

/// Whether another app captures from an input. Sent to every window on
/// every change; `mic_activity_get` returns the current one.
///
/// - busy: `app` holds the input since `since` (the start of the busy
///   period; a takeover by another app keeps it);
/// - free: `app` held it last and released it at `since`. Before the first
///   busy period `app` is absent and `since` is the app's start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct MicActivityChanged {
    pub busy: bool,
    #[specta(optional)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    /// Milliseconds since the Unix epoch.
    pub since: i64,
}

impl From<Activity> for MicActivityChanged {
    fn from(activity: Activity) -> Self {
        Self {
            busy: activity.busy,
            app: activity.app,
            since: activity.since,
        }
    }
}

/// Whether a call is being recorded: no widget then. The recorder
/// (`RecordingManager`) implements it and registers itself with
/// [`MicWatch::set_recording_probe`]; until then [`NoRecorder`] answers.
pub trait RecordingProbe: Send + Sync + 'static {
    fn is_recording(&self) -> bool;
}

/// No recorder yet: never recording.
pub struct NoRecorder;

impl RecordingProbe for NoRecorder {
    fn is_recording(&self) -> bool {
        false
    }
}

impl<F: Fn() -> bool + Send + Sync + 'static> RecordingProbe for F {
    fn is_recording(&self) -> bool {
        self()
    }
}

/// The settings the widget rule reads when the input becomes busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WidgetSettings {
    pub onboarding_completed: bool,
    pub behavior: MicBusyBehavior,
}

/// What the watcher acts on: the app's windows, a recorder in tests.
pub trait MicHost: Send + Sync + 'static {
    /// To every window.
    fn emit(&self, event: &MicActivityChanged);
    fn widget_settings(&self) -> WidgetSettings;
    /// Shows the start widget naming `app`.
    fn show_widget(&self, app: &str);
}

/// The input of the widget rule at the start of a busy period.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WidgetRule {
    pub onboarding_completed: bool,
    pub recording: bool,
    pub behavior: MicBusyBehavior,
    /// The widget was already shown in this busy period.
    pub shown: bool,
}

/// `specs/mic-activity`, "Виджет старта по занятому микрофону": onboarding
/// done, no recording, the setting isn't "nothing" (`record` behaves as
/// `widget` until the call lifecycle exists), once per busy period.
pub const fn should_show_widget(rule: WidgetRule) -> bool {
    rule.onboarding_completed
        && !rule.recording
        && !matches!(rule.behavior, MicBusyBehavior::Nothing)
        && !rule.shown
}

/// The widget's route naming the app: `/widget?app=<percent-encoded>`.
pub fn widget_route(app: &str) -> String {
    use std::fmt::Write as _;
    let mut route = String::from("/widget?app=");
    for byte in app.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            route.push(char::from(byte));
        } else {
            let _ = write!(route, "%{byte:02X}");
        }
    }
    route
}

struct Inner {
    debouncer: Debouncer,
    shown: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    host: Box<dyn MicHost>,
    recording: RwLock<Box<dyn RecordingProbe>>,
    worker: Mutex<Option<Worker>>,
}

/// The watcher in the Tauri state. Cheap to clone.
#[derive(Clone)]
pub struct MicWatch(Arc<Shared>);

impl MicWatch {
    pub fn new(host: impl MicHost) -> Self {
        Self(Arc::new(Shared {
            inner: Mutex::new(Inner {
                debouncer: Debouncer::new(std::process::id(), now_ms()),
                shown: false,
            }),
            host: Box::new(host),
            recording: RwLock::new(Box::new(NoRecorder)),
            worker: Mutex::new(None),
        }))
    }

    /// The seam for the recorder: "is a recording running" from now on.
    pub fn set_recording_probe(&self, probe: impl RecordingProbe) {
        *self
            .0
            .recording
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Box::new(probe);
    }

    /// The current state, for `mic_activity_get`.
    pub fn current(&self) -> MicActivityChanged {
        self.inner().debouncer.activity().into()
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.0.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// A snapshot of who captures from an input, taken at `now` (ms since
    /// the epoch). Called by the OS watcher, or by hand in tests.
    pub fn observe(&self, holders: &[Holder], now: i64) {
        let changed = {
            let mut inner = self.inner();
            inner
                .debouncer
                .observe(holders, now)
                .map(|transition| (transition, inner.debouncer.activity()))
        };
        if let Some((transition, activity)) = changed {
            self.changed(&transition, activity);
        }
    }

    /// Time passed without a snapshot: may send `free`.
    pub fn tick(&self, now: i64) {
        let changed = {
            let mut inner = self.inner();
            inner
                .debouncer
                .tick(now)
                .map(|transition| (transition, inner.debouncer.activity()))
        };
        if let Some((transition, activity)) = changed {
            self.changed(&transition, activity);
        }
    }

    /// When the next `tick` may send `free`.
    fn deadline(&self) -> Option<i64> {
        self.inner().debouncer.deadline()
    }

    /// The watcher thread is the only caller, so events keep their order.
    fn changed(&self, transition: &Transition, activity: Activity) {
        self.0.host.emit(&activity.into());
        match transition {
            Transition::Busy { app, .. } => {
                let settings = self.0.host.widget_settings();
                let recording = self
                    .0
                    .recording
                    .read()
                    .unwrap_or_else(PoisonError::into_inner)
                    .is_recording();
                let show = {
                    let mut inner = self.inner();
                    let show = should_show_widget(WidgetRule {
                        onboarding_completed: settings.onboarding_completed,
                        recording,
                        behavior: settings.behavior,
                        shown: inner.shown,
                    });
                    inner.shown |= show;
                    show
                };
                if show {
                    self.0.host.show_widget(app);
                }
            }
            Transition::Free { .. } => self.inner().shown = false,
            Transition::AppChanged { .. } => {}
        }
    }

    /// Starts the OS watcher thread (once). Without a watcher for this OS
    /// the state stays "free".
    pub fn start(&self) {
        let mut worker = self.0.worker.lock().unwrap_or_else(PoisonError::into_inner);
        if worker.is_some() {
            return;
        }
        #[cfg(target_os = "macos")]
        {
            *worker = Some(Worker::spawn(self.clone(), mac::run));
        }
        #[cfg(windows)]
        {
            *worker = Some(Worker::spawn(self.clone(), win::run));
        }
    }

    /// Stops the watcher thread: on app exit.
    pub fn stop(&self) {
        let worker = self
            .0
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(worker);
    }
}

/// What the watcher thread waits for between scans.
enum Signal {
    /// A HAL listener fired: scan now.
    Wake,
    Stop,
}

/// The watcher thread. Dropping it stops the thread and waits a little for
/// it to clean up (listeners, COM).
struct Worker {
    signals: Sender<Signal>,
    done: Receiver<()>,
    thread: Option<JoinHandle<()>>,
}

/// How long `stop` waits for the thread before leaving it behind: exit
/// must not hang on a stuck OS call.
const STOP_WAIT: Duration = Duration::from_secs(1);

impl Worker {
    fn spawn(watch: MicWatch, run: fn(&Driver)) -> Self {
        let (signals, receiver) = mpsc::channel();
        let (done_sender, done) = mpsc::channel();
        let wake = signals.clone();
        let thread = std::thread::Builder::new()
            .name("grill-mic-watch".to_owned())
            .spawn(move || {
                run(&Driver {
                    watch,
                    signals: receiver,
                    wake,
                    clock: Clock::new(),
                });
                let _ = done_sender.send(());
            })
            .map_err(|error| eprintln!("grill: mic watcher thread failed: {error}"))
            .ok();
        Self {
            signals,
            done,
            thread,
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.signals.send(Signal::Stop);
        let Some(thread) = self.thread.take() else {
            return;
        };
        if self.done.recv_timeout(STOP_WAIT).is_ok() {
            let _ = thread.join();
        }
    }
}

/// What a watcher thread gets: the watch to feed, its signals, the clock.
struct Driver {
    watch: MicWatch,
    signals: Receiver<Signal>,
    /// For HAL listeners to wake the thread.
    wake: Sender<Signal>,
    clock: Clock,
}

/// Why [`Driver::wait`] returned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Woken {
    /// The next scan is due.
    Poll,
    /// A listener fired.
    Wake,
    Stop,
}

impl Driver {
    /// Feeds a snapshot at the current time.
    fn observe(&self, holders: &[Holder]) {
        self.watch.observe(holders, self.clock.now_ms());
    }

    /// Waits until `next_scan`, ticking the debouncer at its deadline on the
    /// way, so `free` comes on time between scans.
    fn wait(&self, next_scan: Instant) -> Woken {
        loop {
            let now = Instant::now();
            let until_scan = next_scan.saturating_duration_since(now);
            let until_deadline = self.watch.deadline().map(|deadline| {
                Duration::from_millis(u64::try_from(deadline - self.clock.now_ms()).unwrap_or(0))
            });
            let timeout = until_deadline.map_or(until_scan, |until| until.min(until_scan));
            match self.signals.recv_timeout(timeout) {
                Ok(Signal::Wake) => {
                    // A burst of notifications is one scan.
                    loop {
                        match self.signals.try_recv() {
                            Ok(Signal::Wake) => {}
                            Ok(Signal::Stop) | Err(mpsc::TryRecvError::Disconnected) => {
                                return Woken::Stop;
                            }
                            Err(mpsc::TryRecvError::Empty) => return Woken::Wake,
                        }
                    }
                }
                Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => return Woken::Stop,
                Err(RecvTimeoutError::Timeout) => {
                    if Instant::now() >= next_scan {
                        return Woken::Poll;
                    }
                    self.watch.tick(self.clock.now_ms());
                }
            }
        }
    }
}

/// Wall-clock milliseconds that never go back: the start time plus a
/// monotonic clock, so a clock change can't stretch or skip the delay.
struct Clock {
    epoch: i64,
    start: Instant,
}

impl Clock {
    fn new() -> Self {
        Self {
            epoch: now_ms(),
            start: Instant::now(),
        }
    }

    fn now_ms(&self) -> i64 {
        self.epoch
            .saturating_add(i64::try_from(self.start.elapsed().as_millis()).unwrap_or(i64::MAX))
    }
}

fn now_ms() -> i64 {
    crate::storage::now_ms()
}

/// The app's windows and settings.
pub struct AppHost<R: Runtime>(pub AppHandle<R>);

impl<R: Runtime> MicHost for AppHost<R> {
    fn emit(&self, event: &MicActivityChanged) {
        if let Err(error) = event.emit(&self.0) {
            eprintln!("grill: failed to emit mic-activity-changed: {error}");
        }
    }

    /// From the database; no widget when it can't be read (the main window
    /// shows the storage error instead).
    fn widget_settings(&self) -> WidgetSettings {
        let stored = self
            .0
            .try_state::<Storage>()
            .and_then(|storage| storage.read_now(settings::get).ok());
        stored.map_or(
            WidgetSettings {
                onboarding_completed: false,
                behavior: MicBusyBehavior::Widget,
            },
            |stored| WidgetSettings {
                onboarding_completed: settings::flag(&stored, settings::ONBOARDING_COMPLETED),
                behavior: settings::mic_busy_behavior(&stored),
            },
        )
    }

    fn show_widget(&self, app: &str) {
        let navigate = Navigate {
            route: widget_route(app),
        };
        if let Err(error) = navigate.emit_to(&self.0, windows::WIDGET) {
            eprintln!("grill: failed to send the widget route: {error}");
        }
        windows::show(&self.0, windows::WIDGET);
    }
}

/// The watcher of the app, started in `setup`.
pub fn start_for_app<R: Runtime>(app: &AppHandle<R>) -> MicWatch {
    let watch = MicWatch::new(AppHost(app.clone()));
    watch.start();
    watch
}

/// Stops the watcher on exit.
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    if let Some(watch) = app.try_state::<MicWatch>() {
        watch.stop();
    }
}

#[cfg(test)]
mod tests;
