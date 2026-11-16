//! The call in progress (`specs/call-lifecycle`, design.md decisions 1–9).
//!
//! [`CallManager`] (Tauri state) owns it: "Начать" creates the call in the
//! database and records it, "Завершить" stops the recording and starts the
//! summary build (`summary/`), "Отменить завершение" stops the build and
//! records the same call again, `close` ends it: the build once it is over
//! (or a window, before it; the build then still saves). Every change goes to every window
//! (`CallSessionChanged`, after the call's `DataChanged`), moves the windows
//! ([`windows`]) and the tray menu.
//!
//! ```text
//! Idle ──start──▶ Live ──finish / countdown──▶ Finishing ──close──▶ Idle
//!                  ▲                               │
//!                  └──────────── resume ───────────┘
//! ```
//!
//! Every change runs under one async lock, so two windows pressing
//! "Начать" at once get one call. The microphone watcher feeds the
//! countdown "Завершать звонок сам" and "Сразу записывать" through a queue
//! that keeps its order.

mod app;
pub mod windows;

#[cfg(test)]
mod tests;

use std::{
    sync::{
        Arc, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use rusqlite::{Connection, Transaction};
use serde::Deserialize;
use specta::Type;
use tokio::{runtime::Handle, sync::mpsc, task::JoinHandle};

pub use self::app::{finish_current, manager_for_app, toggle_call};
use self::windows::WindowStep;
use crate::{
    audio::mic_watch::state::Transition,
    error::{CommandError, CommandResult},
    events::{CallAutoEnd, CallSession, CallSessionStatus, DataChanged},
    storage::{
        calls::{self, CallCreate, CallSetup, CallStatus, CallUpdate},
        now_ms,
        recordings::RecordingLinks,
    },
};

/// "Начать" in a window: the project (none for a call without one) and the
/// client's people on the call, people of that project.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CallStart {
    #[specta(optional)]
    pub project_id: Option<String>,
    #[specta(optional)]
    pub participant_ids: Option<Vec<String>>,
}

/// The recorder as the call sees it: `RecordingManager` in the app, a fake
/// in tests. Both block (devices, files): called off the async workers.
pub trait CallRecorder: Send + Sync + 'static {
    /// Starts a recording and returns its id; no microphone access is an
    /// `External` error with `reason: noAccess`.
    fn start(&self, links: &RecordingLinks) -> CommandResult<String>;
    fn stop(&self, id: &str) -> CommandResult<()>;
}

/// The settings a change of the call reads when it happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallSettings {
    /// "Компактный оверлей": a start shows the overlay.
    pub compact_overlay: bool,
    /// "Завершать звонок сам"; `None` for "Никогда".
    pub auto_end: Option<Duration>,
}

/// Runs a closure on the database (blocking).
pub type DbWork<'a> = &'a mut dyn FnMut(&Connection) -> CommandResult<()>;

/// Where the call is stored and shown: the app, a recorder in tests.
pub trait CallHost: Send + Sync + 'static {
    /// Runs `work` on the database (blocking).
    fn database(&self, work: DbWork<'_>) -> CommandResult<()>;
    /// `DataChanged` to every window.
    fn data_changed(&self, event: DataChanged);
    /// `CallSessionChanged` to every window.
    fn session_changed(&self, session: &CallSession);
    /// Read when the change happens (blocking).
    fn settings(&self) -> CallSettings;
    fn window(&self, step: WindowStep);
    /// The start widget naming `app`, as the microphone watcher shows it.
    fn show_widget(&self, app: &str);
    /// The tray menu for a call in progress, or without one.
    fn tray(&self, in_call: bool);
    /// The wall clock, milliseconds since the Unix epoch: the countdown
    /// ends by it (`endsAt`), also after the machine slept.
    fn now(&self) -> i64 {
        now_ms()
    }
    /// The call is finishing: its summary build starts (post-call design.md,
    /// decision 1). The build closes the call when it ends.
    fn summary_start(&self, _call_id: &str) {}
    /// The finishing call goes back to live or away: its build stops and
    /// saves nothing.
    fn summary_cancel(&self, _call_id: &str) {}
}

/// How often a countdown looks at the wall clock: the async timers stop
/// while the machine sleeps, the wall clock doesn't.
const CLOCK_CHECK: Duration = Duration::from_secs(5);

/// Who began the call.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Origin {
    /// "Начать" in a window, with what it picked.
    Window(CallStart),
    /// "Сразу записывать": the last call's project and people, the overlay.
    MicBusy,
}

/// What the microphone watcher reports, in its order.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MicEvent {
    /// Another app captures from an input again.
    Busy,
    /// `app` let the input go at `released_at`.
    Free { app: String, released_at: i64 },
    /// A busy period began with "Сразу записывать"; `app` took the input.
    Record { app: String },
}

/// Under the async lock: the call and its countdown.
struct Control {
    session: CallSession,
    /// The countdown's task; dropped (detached) when it is the one ending.
    timer: Option<JoinHandle<()>>,
    /// Changes with every countdown started or stopped, so a countdown
    /// that woke late does nothing.
    generation: u64,
}

impl Control {
    fn stop_countdown(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
        self.generation += 1;
        self.session.auto_end = None;
    }
}

struct Shared {
    host: Box<dyn CallHost>,
    recorder: Box<dyn CallRecorder>,
    runtime: Handle,
    control: tokio::sync::Mutex<Control>,
    /// What the windows last got: reads never wait for a change.
    current: Mutex<CallSession>,
    /// The call in progress shows in the overlay, as its start chose
    /// ("Компактный оверлей" then, or "Сразу записывать"). Written under
    /// `control`.
    overlay: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn is_active(session: &CallSession) -> bool {
    session.status != CallSessionStatus::Idle
}

fn idle_error(call_id: &str) -> CommandError {
    CommandError::invalid(format!("Звонок {call_id} сейчас не идёт"))
}

impl Shared {
    /// Blocking work (database, recorder) off the async workers.
    async fn blocking<T: Send + 'static>(
        self: &Arc<Self>,
        work: impl FnOnce(&Self) -> T + Send + 'static,
    ) -> CommandResult<T> {
        let shared = Arc::clone(self);
        self.runtime
            .spawn_blocking(move || work(&shared))
            .await
            .map_err(|error| CommandError::storage(error.to_string()))
    }

    /// Runs `work` on the database (blocking).
    fn read<T>(&self, work: impl FnOnce(&Connection) -> CommandResult<T>) -> CommandResult<T> {
        let mut work = Some(work);
        let mut output = None;
        self.host.database(&mut |connection| {
            if let Some(work) = work.take() {
                output = Some(work(connection)?);
            }
            Ok(())
        })?;
        output.ok_or_else(|| CommandError::storage("База данных не ответила"))
    }

    /// One transaction (blocking). The events are the caller's to send.
    fn write<T>(
        &self,
        work: impl FnOnce(&Transaction) -> CommandResult<(T, Vec<DataChanged>)>,
    ) -> CommandResult<(T, Vec<DataChanged>)> {
        self.read(|connection| {
            let transaction = connection.unchecked_transaction()?;
            let written = work(&transaction)?;
            transaction.commit()?;
            Ok(written)
        })
    }

    fn send(&self, events: Vec<DataChanged>) {
        for event in events {
            self.host.data_changed(event);
        }
    }

    /// The windows get the call as `control` has it; the tray follows a
    /// call that starts or ends.
    fn publish(&self, control: &Control) {
        let was_active = {
            let mut current = lock(&self.current);
            let was_active = is_active(&current);
            *current = control.session.clone();
            was_active
        };
        self.host.session_changed(&control.session);
        let active = is_active(&control.session);
        if active != was_active {
            self.host.tray(active);
        }
    }

    fn move_windows(&self, steps: Vec<WindowStep>) {
        for step in steps {
            self.host.window(step);
        }
    }

    /// `NotFound` for an unknown call, `Invalid` for a call that isn't the
    /// current one.
    async fn check_current(
        self: &Arc<Self>,
        control: &Control,
        call_id: &str,
    ) -> CommandResult<()> {
        if control.session.call_id.as_deref() == Some(call_id) {
            return Ok(());
        }
        let id = call_id.to_owned();
        self.blocking(move |shared| shared.read(|connection| calls::get(connection, &id)))
            .await??;
        Err(idle_error(call_id))
    }

    async fn start(self: &Arc<Self>, origin: Origin) -> CommandResult<CallSession> {
        let mut control = self.control.lock().await;
        if is_active(&control.session) {
            return Ok(control.session.clone());
        }
        let overlay_anyway = origin == Origin::MicBusy;
        let (session, events, settings) =
            self.blocking(move |shared| shared.begin(origin)).await??;
        self.send(events);
        let overlay = settings.compact_overlay || overlay_anyway;
        self.overlay.store(overlay, Ordering::SeqCst);
        control.session = session;
        self.publish(&control);
        self.move_windows(windows::started(overlay));
        Ok(control.session.clone())
    }

    /// Creates the call and records it (blocking). A recording that doesn't
    /// start takes the call's row along: a call is never `live` without
    /// one, and no window ever saw it.
    fn begin(
        &self,
        origin: Origin,
    ) -> CommandResult<(CallSession, Vec<DataChanged>, CallSettings)> {
        let started_at = now_ms();
        let ((call, participants), events) = self.write(|connection| {
            let setup = match origin {
                Origin::Window(input) => CallSetup {
                    project_id: input.project_id,
                    participant_ids: input.participant_ids.unwrap_or_default(),
                },
                Origin::MicBusy => calls::last_setup(connection)?,
            };
            let input = CallCreate {
                project_id: setup.project_id,
                status: Some(CallStatus::Live),
                started_at: Some(started_at),
                participant_ids: Some(setup.participant_ids),
                ..CallCreate::default()
            };
            let (call, events) = calls::create(connection, input)?;
            let names = calls::participants(connection, &call.id)?
                .into_iter()
                .map(|person| person.name)
                .collect::<Vec<_>>();
            Ok(((call, names), events))
        })?;
        let links = RecordingLinks {
            call_id: Some(call.id.clone()),
            project_id: call.project_id.clone(),
            participant_ids: call.participant_ids.clone(),
        };
        let recording_id = match self.recorder.start(&links) {
            Ok(id) => id,
            Err(error) => {
                if let Err(removal) = self.write(|connection| calls::delete(connection, &call.id)) {
                    eprintln!(
                        "grill: could not remove the call {} after a failed start: {removal}",
                        call.id
                    );
                }
                return Err(error);
            }
        };
        let session = CallSession {
            status: CallSessionStatus::Live,
            call_id: Some(call.id),
            project_id: call.project_id,
            participant_ids: call.participant_ids,
            participants,
            started_at: call.started_at,
            recording_id: Some(recording_id),
            auto_end: None,
        };
        Ok((session, events, self.host.settings()))
    }

    async fn finish(self: &Arc<Self>, call_id: &str) -> CommandResult<CallSession> {
        let mut control = self.control.lock().await;
        self.check_current(&control, call_id).await?;
        if control.session.status == CallSessionStatus::Live {
            self.end_live(&mut control).await?;
        }
        Ok(control.session.clone())
    }

    /// `Live → Finishing`: "Завершить", the tray or the countdown. The
    /// recording stops and the call gets its end time. A call deleted
    /// meanwhile is gone (`NotFound`, see [`Self::forget`]); a database
    /// that failed is logged (the next start finishes the call) and the
    /// windows go on to the summary.
    async fn end_live(self: &Arc<Self>, control: &mut Control) -> CommandResult<()> {
        control.stop_countdown();
        let Some(call_id) = control.session.call_id.clone() else {
            return Ok(());
        };
        let recording_id = control.session.recording_id.clone();
        let id = call_id.clone();
        let ended = self
            .blocking(move |shared| {
                if let Some(id) = &recording_id
                    && let Err(error) = shared.recorder.stop(id)
                {
                    eprintln!("grill: could not stop the recording {id}: {error}");
                }
                shared.write(|connection| {
                    let call = calls::get(connection, &id)?;
                    let ended_at = call
                        .started_at
                        .map_or(now_ms(), |start| now_ms().max(start));
                    let patch = CallUpdate {
                        status: Some(CallStatus::Finishing),
                        ended_at: Some(Some(ended_at)),
                        ..CallUpdate::default()
                    };
                    calls::update(connection, &id, patch)
                })
            })
            .await
            .and_then(|written| written);
        match ended {
            Ok((_, events)) => self.send(events),
            // The recording has stopped already.
            Err(error @ CommandError::NotFound { .. }) => {
                self.forget(control);
                return Err(error);
            }
            Err(error) => eprintln!("grill: could not mark the call finishing: {error}"),
        }
        control.session.status = CallSessionStatus::Finishing;
        self.publish(control);
        self.move_windows(windows::finishing());
        self.host.summary_start(&call_id);
        Ok(())
    }

    /// The call is gone without a summary: deleted meanwhile, or discarded
    /// before its data is. A live call's recording stops, no call is
    /// current and the overlay goes; the main window stays where it is.
    async fn drop_call(self: &Arc<Self>, control: &mut Control) {
        control.stop_countdown();
        let recording = match control.session.status {
            CallSessionStatus::Live => control.session.recording_id.clone(),
            _ => None,
        };
        if let Some(id) = recording {
            let stopped = self
                .blocking(move |shared| shared.recorder.stop(&id).map_err(|error| (id, error)))
                .await;
            match stopped {
                Ok(Err((id, error))) => {
                    eprintln!("grill: could not stop the recording {id}: {error}");
                }
                Err(error) => eprintln!("grill: could not stop the recording: {error}"),
                Ok(Ok(())) => {}
            }
        }
        self.forget(control);
    }

    /// No call is current any more, and the overlay goes.
    fn forget(&self, control: &mut Control) {
        control.session = CallSession::idle();
        self.publish(control);
        self.move_windows(windows::gone());
    }

    /// "Отменить завершение": the same call, recorded again. A recording
    /// that doesn't start leaves the call live without one; the error says
    /// why.
    async fn resume(self: &Arc<Self>, call_id: &str) -> CommandResult<CallSession> {
        let mut control = self.control.lock().await;
        self.check_current(&control, call_id).await?;
        if control.session.status != CallSessionStatus::Finishing {
            return Ok(control.session.clone());
        }
        // The summary is not built for a call that goes on.
        self.host.summary_cancel(call_id);
        let id = call_id.to_owned();
        let links = RecordingLinks {
            call_id: Some(id.clone()),
            project_id: control.session.project_id.clone(),
            participant_ids: control.session.participant_ids.clone(),
        };
        let resumed = self
            .blocking(move |shared| {
                let patch = CallUpdate {
                    status: Some(CallStatus::Live),
                    ended_at: Some(None),
                    ..CallUpdate::default()
                };
                let (_, events) =
                    shared.write(|connection| calls::update(connection, &id, patch))?;
                Ok::<_, CommandError>((events, shared.recorder.start(&links)))
            })
            .await?;
        let (events, recording) = match resumed {
            Ok(resumed) => resumed,
            // Deleted while it finished: nothing to record on.
            Err(error @ CommandError::NotFound { .. }) => {
                self.drop_call(&mut control).await;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        self.send(events);
        control.session.status = CallSessionStatus::Live;
        control.session.recording_id = recording.as_ref().ok().cloned();
        self.publish(&control);
        recording.map(|_| control.session.clone())
    }

    /// The summary is built: the call is `finished`, no call is current.
    async fn close(self: &Arc<Self>, call_id: &str) -> CommandResult<CallSession> {
        let mut control = self.control.lock().await;
        self.check_current(&control, call_id).await?;
        if control.session.status != CallSessionStatus::Finishing {
            return Ok(control.session.clone());
        }
        let id = call_id.to_owned();
        let closed = self
            .blocking(move |shared| {
                let patch = CallUpdate {
                    status: Some(CallStatus::Finished),
                    ..CallUpdate::default()
                };
                shared.write(|connection| calls::update(connection, &id, patch))
            })
            .await?;
        match closed {
            Ok((_, events)) => self.send(events),
            // Deleted meanwhile: nothing to close.
            Err(CommandError::NotFound { .. }) => {}
            Err(error) => return Err(error),
        }
        control.session = CallSession::idle();
        self.publish(&control);
        Ok(control.session.clone())
    }

    /// "Продолжить": no countdown until the microphone is let go again. A
    /// call deleted meanwhile is gone (`NotFound`).
    async fn keep(self: &Arc<Self>, call_id: &str) -> CommandResult<CallSession> {
        let mut control = self.control.lock().await;
        self.check_current(&control, call_id).await?;
        let id = call_id.to_owned();
        let stored = self
            .blocking(move |shared| shared.read(|connection| calls::get(connection, &id)))
            .await?;
        if let Err(error @ CommandError::NotFound { .. }) = stored {
            self.drop_call(&mut control).await;
            return Err(error);
        }
        if control.session.auto_end.is_some() {
            control.stop_countdown();
            self.publish(&control);
        }
        Ok(control.session.clone())
    }

    async fn on_mic(self: &Arc<Self>, event: MicEvent) {
        match event {
            MicEvent::Busy => {
                let mut control = self.control.lock().await;
                if control.session.auto_end.is_some() {
                    control.stop_countdown();
                    self.publish(&control);
                }
            }
            MicEvent::Free { app, released_at } => self.count_down(app, released_at).await,
            // A call that doesn't start (no microphone access, say) falls
            // back to the start widget: its "Начать" says why.
            MicEvent::Record { app } => {
                if let Err(error) = self.start(Origin::MicBusy).await {
                    eprintln!("grill: «Сразу записывать» could not start a call: {error}");
                    self.host.show_widget(&app);
                }
            }
        }
    }

    /// Discards the call before its data is deleted ("Удалить все данные"):
    /// no summary, the main window stays. The call's row is the delete's.
    async fn discard(self: &Arc<Self>, call_id: &str) -> CommandResult<CallSession> {
        let mut control = self.control.lock().await;
        self.check_current(&control, call_id).await?;
        if is_active(&control.session) {
            self.host.summary_cancel(call_id);
            self.drop_call(&mut control).await;
        }
        Ok(control.session.clone())
    }

    /// The meeting app let the microphone go during a live call: every
    /// window offers to end it, with the countdown of "Завершать звонок
    /// сам" as set now; with "Никогда" without one.
    async fn count_down(self: &Arc<Self>, app: String, released_at: i64) {
        let mut control = self.control.lock().await;
        if control.session.status != CallSessionStatus::Live || control.session.auto_end.is_some() {
            return;
        }
        let settings = match self.blocking(|shared| shared.host.settings()).await {
            Ok(settings) => settings,
            Err(error) => {
                eprintln!("grill: no countdown, the settings are unavailable: {error}");
                return;
            }
        };
        control.stop_countdown();
        let ends_at = settings.auto_end.map(|delay| {
            let delay_ms = i64::try_from(delay.as_millis()).unwrap_or(i64::MAX);
            released_at.saturating_add(delay_ms)
        });
        if let Some(ends_at) = ends_at {
            let timer = run_out(Arc::downgrade(self), ends_at, control.generation);
            control.timer = Some(self.runtime.spawn(timer));
        }
        control.session.auto_end = Some(CallAutoEnd {
            app,
            released_at,
            ends_at,
        });
        self.publish(&control);
    }

    /// The countdown ran out: the call ends as by "Завершить".
    async fn expire(self: &Arc<Self>, generation: u64) {
        let mut control = self.control.lock().await;
        if control.generation != generation || control.session.status != CallSessionStatus::Live {
            return;
        }
        // This very task: detach it, `end_live` must not abort itself.
        drop(control.timer.take());
        if let Err(error) = self.end_live(&mut control).await {
            eprintln!("grill: the countdown found no call to end: {error}");
        }
    }
}

/// The countdown's task: waits until the wall clock reaches `ends_at`,
/// looking at it every [`CLOCK_CHECK`] (a timer alone would wait out the
/// time the machine slept), then ends the call.
async fn run_out(shared: Weak<Shared>, ends_at: i64, generation: u64) {
    loop {
        let Some(left) = shared.upgrade().map(|shared| ends_at - shared.host.now()) else {
            return;
        };
        if left <= 0 {
            break;
        }
        let left = Duration::from_millis(u64::try_from(left).unwrap_or(0));
        tokio::time::sleep(left.min(CLOCK_CHECK)).await;
    }
    if let Some(shared) = shared.upgrade() {
        shared.expire(generation).await;
    }
}

/// Feeds the microphone's changes to the call one by one.
async fn follow_mic(shared: Weak<Shared>, mut events: mpsc::UnboundedReceiver<MicEvent>) {
    while let Some(event) = events.recv().await {
        let Some(shared) = shared.upgrade() else {
            return;
        };
        shared.on_mic(event).await;
    }
}

/// No call starts while it lives (`CallManager::hold_idle`): a start, the
/// window's or «Сразу записывать», waits for it to drop.
pub struct IdleHold<'a> {
    _control: tokio::sync::MutexGuard<'a, Control>,
}

/// The call in progress, in the Tauri state. Cheap to clone.
#[derive(Clone)]
pub struct CallManager {
    shared: Arc<Shared>,
    mic: mpsc::UnboundedSender<MicEvent>,
}

impl CallManager {
    /// The countdowns and the microphone's queue run on `runtime`.
    pub fn new(host: impl CallHost, recorder: impl CallRecorder, runtime: Handle) -> Self {
        let shared = Arc::new(Shared {
            host: Box::new(host),
            recorder: Box::new(recorder),
            runtime: runtime.clone(),
            control: tokio::sync::Mutex::new(Control {
                session: CallSession::idle(),
                timer: None,
                generation: 0,
            }),
            current: Mutex::new(CallSession::idle()),
            overlay: AtomicBool::new(false),
        });
        let (mic, events) = mpsc::unbounded_channel();
        runtime.spawn(follow_mic(Arc::downgrade(&shared), events));
        Self { shared, mic }
    }

    /// The call as the windows last got it.
    pub fn current(&self) -> CallSession {
        lock(&self.shared.current).clone()
    }

    /// A call is live or finishing: no start widget then.
    pub fn is_active(&self) -> bool {
        is_active(&lock(&self.shared.current))
    }

    /// The `toggle-call` shortcut and "Открыть звонок": the call in
    /// progress in the window its start chose, or the start widget.
    pub fn toggle_steps(&self) -> Vec<WindowStep> {
        let status = self.current().status;
        windows::toggle_call(status, self.shared.overlay.load(Ordering::SeqCst))
    }

    /// Keeps the manager idle while the hold lives («Удалить всё» deletes
    /// the data under it). `Invalid` while a call is live or finishing.
    pub async fn hold_idle(&self) -> CommandResult<IdleHold<'_>> {
        let control = self.shared.control.lock().await;
        if is_active(&control.session) {
            return Err(CommandError::invalid(
                "Идёт звонок: завершите или удалите его, потом удаляйте данные",
            ));
        }
        Ok(IdleHold { _control: control })
    }

    /// "Начать": creates the call and records it, or returns the call in
    /// progress (nothing is created then). No microphone access: the error,
    /// and no call.
    pub async fn start(&self, input: CallStart) -> CommandResult<CallSession> {
        self.shared.start(Origin::Window(input)).await
    }

    /// "Завершить": a live call stops recording and finishes; otherwise
    /// nothing changes.
    pub async fn finish(&self, call_id: &str) -> CommandResult<CallSession> {
        self.shared.finish(call_id).await
    }

    /// "Отменить завершение" of a finishing call; otherwise nothing changes.
    pub async fn resume(&self, call_id: &str) -> CommandResult<CallSession> {
        self.shared.resume(call_id).await
    }

    /// The summary of a finishing call is built; otherwise nothing changes.
    pub async fn close(&self, call_id: &str) -> CommandResult<CallSession> {
        self.shared.close(call_id).await
    }

    /// "Продолжить": the countdown stops.
    pub async fn keep(&self, call_id: &str) -> CommandResult<CallSession> {
        self.shared.keep(call_id).await
    }

    /// The call in progress goes without a summary, its row stays for the
    /// delete that follows; otherwise nothing changes.
    pub async fn discard(&self, call_id: &str) -> CommandResult<CallSession> {
        self.shared.discard(call_id).await
    }

    /// "Завершить звонок" in the tray: the call in progress, if it is live.
    pub async fn finish_current(&self) {
        let Some(call_id) = self.current().call_id else {
            return;
        };
        if let Err(error) = self.finish(&call_id).await {
            eprintln!("grill: could not finish the call from the tray: {error}");
        }
    }

    /// A busy / free change of the microphone (the watcher's thread).
    pub fn mic_changed(&self, transition: &Transition) {
        let event = match transition {
            Transition::Busy { .. } => MicEvent::Busy,
            Transition::Free { app, released_at } => MicEvent::Free {
                app: app.clone(),
                released_at: *released_at,
            },
            Transition::AppChanged { .. } => return,
        };
        let _ = self.mic.send(event);
    }

    /// "Сразу записывать" as `app` took the microphone: a call with the
    /// last call's project and people, shown in the overlay; the start
    /// widget when it doesn't start.
    pub fn start_on_mic(&self, app: &str) {
        let _ = self.mic.send(MicEvent::Record {
            app: app.to_owned(),
        });
    }
}
