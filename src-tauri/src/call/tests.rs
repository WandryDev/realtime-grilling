//! Scenarios of `specs/call-lifecycle` on a fake recorder and a host that
//! records what the windows got, over an in-memory database.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, Ordering},
    },
    thread,
    time::Instant,
};

use super::*;
use crate::{
    error::CaptureFailure,
    events::{Change, Entity},
    shell::windows::{MAIN, OVERLAY, WIDGET},
    storage::{
        Storage,
        call_state::{
            self, CardLens, Evidence, EvidenceSource, GapType, NewQuestion, ValidatedOp,
            ValidatedPatch,
        },
        calls::Call,
        people::{self, PersonCreate},
        projects::{self, ProjectCreate},
        recordings::{self, RecordingFiles, RecordingState},
        transcript::{self, SegmentInput, TranscriptChannel},
    },
};

/// What the host was asked to do, in order.
#[derive(Debug, Clone, PartialEq)]
enum Seen {
    Data(DataChanged),
    Session(CallSession),
    Window(WindowStep),
    /// The start widget naming the app.
    Widget(String),
    Tray(bool),
}

struct Record {
    storage: Storage,
    seen: Mutex<Vec<Seen>>,
    settings: Mutex<CallSettings>,
    /// The microphone is denied: a start fails as `RecordingManager`'s.
    denied: AtomicBool,
    /// How long a start takes (the devices opening).
    start_delay: Mutex<Duration>,
    starts: Mutex<Vec<RecordingLinks>>,
    stops: Mutex<Vec<String>>,
    running: Mutex<Option<String>>,
    /// The wall clock: the time of the fixture's start, moving with
    /// tokio's clock (paused in the countdown tests)…
    clock_start: (i64, tokio::time::Instant),
    /// …and a jump of it, as after the machine slept.
    slept: AtomicI64,
    /// What the summary builds were told: `("start" | "cancel", call)`.
    summary: Mutex<Vec<(&'static str, String)>>,
}

impl Record {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn windows(&self) -> Vec<WindowStep> {
        self.seen()
            .into_iter()
            .filter_map(|seen| match seen {
                Seen::Window(step) => Some(step),
                _ => None,
            })
            .collect()
    }

    fn sessions(&self) -> Vec<CallSession> {
        self.seen()
            .into_iter()
            .filter_map(|seen| match seen {
                Seen::Session(session) => Some(session),
                _ => None,
            })
            .collect()
    }

    fn clear(&self) {
        self.seen.lock().unwrap().clear();
    }

    fn set(&self, settings: CallSettings) {
        *self.settings.lock().unwrap() = settings;
    }

    fn now(&self) -> i64 {
        let (wall, start) = self.clock_start;
        let passed = i64::try_from(start.elapsed().as_millis()).unwrap();
        wall + passed + self.slept.load(Ordering::SeqCst)
    }
}

struct FakeHost(Arc<Record>);

impl CallHost for FakeHost {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        self.0.storage.read_now(|connection| work(connection))
    }

    fn data_changed(&self, event: DataChanged) {
        self.0.seen.lock().unwrap().push(Seen::Data(event));
    }

    fn session_changed(&self, session: &CallSession) {
        self.0
            .seen
            .lock()
            .unwrap()
            .push(Seen::Session(session.clone()));
    }

    fn settings(&self) -> CallSettings {
        *self.0.settings.lock().unwrap()
    }

    fn window(&self, step: WindowStep) {
        self.0.seen.lock().unwrap().push(Seen::Window(step));
    }

    fn show_widget(&self, app: &str) {
        self.0
            .seen
            .lock()
            .unwrap()
            .push(Seen::Widget(app.to_owned()));
    }

    fn now(&self) -> i64 {
        self.0.now()
    }

    fn tray(&self, in_call: bool) {
        self.0.seen.lock().unwrap().push(Seen::Tray(in_call));
    }

    fn summary_start(&self, call_id: &str) {
        self.0
            .summary
            .lock()
            .unwrap()
            .push(("start", call_id.to_owned()));
    }

    fn summary_cancel(&self, call_id: &str) {
        self.0
            .summary
            .lock()
            .unwrap()
            .push(("cancel", call_id.to_owned()));
    }
}

/// Writes recording rows as `RecordingManager` does; no devices, no files.
struct FakeRecorder(Arc<Record>);

impl CallRecorder for FakeRecorder {
    fn start(&self, links: &RecordingLinks) -> CommandResult<String> {
        let delay = *self.0.start_delay.lock().unwrap();
        thread::sleep(delay);
        if self.0.denied.load(Ordering::SeqCst) {
            return Err(CommandError::capture(
                CaptureFailure::NoAccess,
                "Нет доступа к микрофону",
            ));
        }
        let mut running = self.0.running.lock().unwrap();
        if let Some(id) = running.as_ref() {
            return Ok(id.clone());
        }
        let id = self.0.storage.read_now(|connection| {
            recordings::create(connection, links, now_ms(), |id| RecordingFiles {
                me: format!("recordings/{id}/me.opus"),
                others: format!("recordings/{id}/others.opus"),
            })
        })?;
        self.0.starts.lock().unwrap().push(links.clone());
        *running = Some(id.clone());
        Ok(id)
    }

    /// The running recording stops even when its row is gone (a deleted
    /// call), as `RecordingManager`'s devices do.
    fn stop(&self, id: &str) -> CommandResult<()> {
        let was_running = self
            .0
            .running
            .lock()
            .unwrap()
            .take_if(|running| running == id)
            .is_some();
        let finished = self
            .0
            .storage
            .read_now(|connection| recordings::finish(connection, id, now_ms()).map(|_| ()));
        if !was_running {
            finished?;
        }
        self.0.stops.lock().unwrap().push(id.to_owned());
        Ok(())
    }
}

const FIVE_MINUTES: Duration = Duration::from_secs(300);

struct Fixture {
    calls: CallManager,
    record: Arc<Record>,
}

impl Fixture {
    /// On the current runtime: call it inside a `#[tokio::test]`.
    fn new() -> Self {
        let record = Arc::new(Record {
            storage: Storage::in_memory(),
            seen: Mutex::default(),
            settings: Mutex::new(CallSettings {
                compact_overlay: true,
                auto_end: Some(FIVE_MINUTES),
            }),
            denied: AtomicBool::new(false),
            start_delay: Mutex::new(Duration::ZERO),
            starts: Mutex::default(),
            stops: Mutex::default(),
            running: Mutex::default(),
            clock_start: (now_ms(), tokio::time::Instant::now()),
            slept: AtomicI64::new(0),
            summary: Mutex::default(),
        });
        let calls = CallManager::new(
            FakeHost(Arc::clone(&record)),
            FakeRecorder(Arc::clone(&record)),
            Handle::current(),
        );
        Self { calls, record }
    }

    /// The wall clock as the call reads it.
    fn now(&self) -> i64 {
        self.record.now()
    }

    fn read<T>(&self, read: impl FnOnce(&Connection) -> CommandResult<T>) -> T {
        self.record.storage.read_now(read).unwrap()
    }

    fn project(&self, name: &str) -> String {
        let input = ProjectCreate {
            name: name.to_owned(),
            ..ProjectCreate::default()
        };
        self.read(|connection| projects::create(connection, input))
            .0
            .id
    }

    fn person(&self, project_id: &str, name: &str) -> String {
        let input = PersonCreate {
            project_id: project_id.to_owned(),
            name: name.to_owned(),
            ..PersonCreate::default()
        };
        self.read(|connection| people::create(connection, input))
            .0
            .id
    }

    fn call(&self, id: &str) -> Call {
        self.read(|connection| calls::get(connection, id))
    }

    fn count(&self, table: &str) -> i64 {
        self.read(|connection| {
            Ok(
                connection.query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        })
    }

    fn recordings_of(&self, call_id: &str) -> Vec<String> {
        self.read(|connection| {
            let mut statement = connection
                .prepare("SELECT id FROM recordings WHERE call_id = ?1 ORDER BY started_at, id")?;
            let rows = statement.query_map([call_id], |row| row.get(0))?;
            Ok(rows.collect::<Result<_, _>>()?)
        })
    }

    async fn start(&self, project_id: Option<&str>, people: &[&str]) -> CallSession {
        self.calls
            .start(CallStart {
                project_id: project_id.map(str::to_owned),
                participant_ids: Some(people.iter().map(|id| (*id).to_owned()).collect()),
                ..CallStart::default()
            })
            .await
            .unwrap()
    }

    /// Waits (in real time, at most 5 s) until the call is in `status`.
    async fn until(&self, status: CallSessionStatus) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.calls.current().status != status {
            assert!(
                Instant::now() < deadline,
                "the call never became {status:?}"
            );
            tokio::task::yield_now().await;
            thread::sleep(Duration::from_millis(1));
        }
    }
}

fn id(session: &CallSession) -> String {
    session.call_id.clone().unwrap()
}

const OVERLAY_SHOWN: WindowStep = WindowStep::Show {
    label: OVERLAY,
    route: None,
};
const CALL_SHOWN: WindowStep = WindowStep::Show {
    label: MAIN,
    route: Some(windows::CALL_ROUTE),
};

/// "Начать звонок с проектом".
#[tokio::test]
async fn a_start_creates_the_call_and_records_it() {
    let fx = Fixture::new();
    let exchange = fx.project("Обменник");
    let igor = fx.person(&exchange, "Игорь");
    let olga = fx.person(&exchange, "Ольга");

    let session = fx.start(Some(&exchange), &[&igor, &olga]).await;

    assert_eq!(session.status, CallSessionStatus::Live);
    assert_eq!(session.project_id.as_deref(), Some(exchange.as_str()));
    assert_eq!(session.participant_ids, vec![igor.clone(), olga.clone()]);
    assert_eq!(session.participants, vec!["Игорь", "Ольга"]);
    assert_eq!(session.auto_end, None);
    let call = fx.call(&id(&session));
    assert_eq!(call.status, CallStatus::Live);
    assert_eq!(call.project_id.as_deref(), Some(exchange.as_str()));
    assert_eq!(call.participant_ids, vec![igor.clone(), olga.clone()]);
    assert_eq!(call.started_at, session.started_at);
    assert_eq!(call.ended_at, None);

    let recording_id = session.recording_id.clone().unwrap();
    let recording = fx.read(|connection| recordings::get(connection, &recording_id));
    assert_eq!(recording.call_id, session.call_id);
    assert_eq!(recording.project_id.as_deref(), Some(exchange.as_str()));
    assert_eq!(recording.participant_ids, vec![igor, olga]);
    assert_eq!(recording.status, RecordingState::Recording);

    // The call's row first, then the session: a window finds the call.
    assert_eq!(
        fx.record.seen(),
        vec![
            Seen::Data(DataChanged::new(
                Entity::Call,
                &id(&session),
                Some(&exchange),
                Change::Created
            )),
            Seen::Session(session.clone()),
            Seen::Tray(true),
            Seen::Window(WindowStep::Hide(WIDGET)),
            Seen::Window(OVERLAY_SHOWN),
        ]
    );
    assert_eq!(fx.calls.current(), session);
    assert!(fx.calls.is_active());
}

/// "Без проекта".
#[tokio::test]
async fn a_call_without_a_project() {
    let fx = Fixture::new();
    let session = fx.start(None, &[]).await;
    assert_eq!(session.status, CallSessionStatus::Live);
    assert_eq!(session.project_id, None);
    assert_eq!(fx.call(&id(&session)).project_id, None);
}

/// "Нет доступа к микрофону".
#[tokio::test]
async fn no_microphone_access_leaves_no_call() {
    let fx = Fixture::new();
    let exchange = fx.project("Обменник");
    fx.record.denied.store(true, Ordering::SeqCst);

    let error = fx
        .calls
        .start(CallStart {
            project_id: Some(exchange),
            participant_ids: None,
            ..CallStart::default()
        })
        .await
        .unwrap_err();

    assert!(
        matches!(
            error,
            CommandError::External {
                reason: Some(CaptureFailure::NoAccess),
                ..
            }
        ),
        "{error:?}"
    );
    assert_eq!(fx.count("calls"), 0, "no call is left live");
    assert_eq!(fx.calls.current(), CallSession::idle());
    assert!(fx.record.seen().is_empty(), "no window heard of it");
}

/// A start the storage refuses (a person of another project) creates
/// nothing and records nothing.
#[tokio::test]
async fn an_invalid_start_records_nothing() {
    let fx = Fixture::new();
    let exchange = fx.project("Обменник");
    let other = fx.project("Телемедиа");
    let marina = fx.person(&other, "Марина");
    let error = fx
        .calls
        .start(CallStart {
            project_id: Some(exchange),
            participant_ids: Some(vec![marina]),
            ..CallStart::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(fx.count("calls"), 0);
    assert!(fx.record.starts.lock().unwrap().is_empty());
}

/// "Два окна начинают звонок".
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_windows_starting_at_once_get_one_call() {
    let fx = Fixture::new();
    let exchange = fx.project("Обменник");
    *fx.record.start_delay.lock().unwrap() = Duration::from_millis(100);

    let (widget, main) = tokio::join!(
        fx.start(Some(&exchange), &[]),
        fx.start(Some(&exchange), &[])
    );

    assert_eq!(widget, main);
    assert_eq!(fx.count("calls"), 1);
    assert_eq!(fx.count("recordings"), 1);
    assert_eq!(fx.record.starts.lock().unwrap().len(), 1);
    let started = fx.record.windows();
    assert_eq!(started, windows::started(true), "the windows move once");
}

/// "Завершить" and the summary: `finishing`, then `finished` with its end.
/// `Окна при завершении звонка`, "Завершить из оверлея".
#[tokio::test]
async fn finish_stops_the_recording_and_close_ends_the_call() {
    let fx = Fixture::new();
    let exchange = fx.project("Обменник");
    let live = fx.start(Some(&exchange), &[]).await;
    let call_id = id(&live);
    let recording_id = live.recording_id.clone().unwrap();
    fx.record.clear();

    let finishing = fx.calls.finish(&call_id).await.unwrap();

    assert_eq!(finishing.status, CallSessionStatus::Finishing);
    assert_eq!(
        finishing.recording_id.as_deref(),
        Some(recording_id.as_str())
    );
    assert_eq!(*fx.record.stops.lock().unwrap(), vec![recording_id.clone()]);
    let recording = fx.read(|connection| recordings::get(connection, &recording_id));
    assert_eq!(recording.status, RecordingState::Finished);
    let call = fx.call(&call_id);
    assert_eq!(call.status, CallStatus::Finishing);
    assert!(call.ended_at >= call.started_at && call.ended_at.is_some());
    assert_eq!(
        fx.record.seen(),
        vec![
            Seen::Data(DataChanged::new(
                Entity::Call,
                &call_id,
                Some(&exchange),
                Change::Updated
            )),
            Seen::Session(finishing.clone()),
            Seen::Window(WindowStep::Hide(OVERLAY)),
            Seen::Window(CALL_SHOWN),
        ]
    );
    fx.record.clear();

    let idle = fx.calls.close(&call_id).await.unwrap();

    assert_eq!(idle, CallSession::idle());
    let closed = fx.call(&call_id);
    assert_eq!(closed.status, CallStatus::Finished);
    assert_eq!(closed.ended_at, call.ended_at);
    assert_eq!(
        fx.record.seen(),
        vec![
            Seen::Data(DataChanged::new(
                Entity::Call,
                &call_id,
                Some(&exchange),
                Change::Updated
            )),
            Seen::Session(CallSession::idle()),
            Seen::Tray(false),
        ],
        "the windows stay: the main window shows the summary"
    );
    assert!(!fx.calls.is_active());
}

/// Post-call decision 1: «Завершить» starts the summary build;
/// «Отменить завершение» and «Удалить все данные» stop it; a close (the
/// build's own, or a window's) does not.
#[tokio::test]
async fn finishing_starts_the_summary_and_going_back_stops_it() {
    let fx = Fixture::new();
    let summary = || fx.record.summary.lock().unwrap().clone();
    let first = id(&fx.start(None, &[]).await);
    assert!(summary().is_empty(), "no summary for a live call");

    fx.calls.finish(&first).await.unwrap();
    assert_eq!(summary(), vec![("start", first.clone())]);
    // A second «Завершить» starts nothing.
    fx.calls.finish(&first).await.unwrap();
    assert_eq!(summary().len(), 1);

    fx.calls.resume(&first).await.unwrap();
    fx.calls.finish(&first).await.unwrap();
    assert_eq!(
        summary(),
        vec![
            ("start", first.clone()),
            ("cancel", first.clone()),
            ("start", first.clone()),
        ]
    );
    fx.calls.close(&first).await.unwrap();
    assert_eq!(summary().len(), 3, "a close stops nothing");

    let second = id(&fx.start(None, &[]).await);
    fx.calls.finish(&second).await.unwrap();
    fx.calls.discard(&second).await.unwrap();
    assert_eq!(
        summary()[3..],
        [("start", second.clone()), ("cancel", second.clone())]
    );
}

/// Повторное «Завершить» ничего не меняет.
#[tokio::test]
async fn a_second_finish_changes_nothing() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    let first = fx.calls.finish(&call_id).await.unwrap();
    let seen = fx.record.seen().len();

    let second = fx.calls.finish(&call_id).await.unwrap();

    assert_eq!(second, first);
    assert_eq!(fx.record.seen().len(), seen, "nothing sent");
    assert_eq!(fx.record.stops.lock().unwrap().len(), 1);
    // A close of a live call or a resume of a live call do nothing either.
    let resumed = fx.calls.resume(&call_id).await.unwrap();
    assert_eq!(resumed.status, CallSessionStatus::Live);
    let still = fx.calls.close(&call_id).await.unwrap();
    assert_eq!(still, resumed);
    assert_eq!(fx.call(&call_id).status, CallStatus::Live);
}

/// "Отменить завершение": the same call again, two recordings, and the
/// new recording's questions and transcript know the call.
#[tokio::test]
async fn resume_records_the_same_call_again() {
    let fx = Fixture::new();
    let exchange = fx.project("Обменник");
    let igor = fx.person(&exchange, "Игорь");
    let live = fx.start(Some(&exchange), &[&igor]).await;
    let call_id = id(&live);
    let first = live.recording_id.clone().unwrap();
    fx.calls.finish(&call_id).await.unwrap();
    fx.record.clear();

    let resumed = fx.calls.resume(&call_id).await.unwrap();

    assert_eq!(resumed.status, CallSessionStatus::Live);
    assert_eq!(resumed.call_id, live.call_id);
    assert_eq!(resumed.started_at, live.started_at);
    let second = resumed.recording_id.clone().unwrap();
    assert_ne!(second, first);
    assert_eq!(fx.recordings_of(&call_id), vec![first, second.clone()]);
    let links = fx.record.starts.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        links,
        RecordingLinks {
            call_id: Some(call_id.clone()),
            project_id: Some(exchange.clone()),
            participant_ids: vec![igor],
        }
    );
    let call = fx.call(&call_id);
    assert_eq!(call.status, CallStatus::Live);
    assert_eq!(call.ended_at, None);
    assert!(
        fx.record.windows().is_empty(),
        "the windows stay as they are"
    );

    // The questions keep coming, on the call.
    let segment = SegmentInput {
        channel: TranscriptChannel::Others,
        start_ms: 0,
        end_ms: 100,
        text: "Звонки теряются".to_owned(),
    };
    let recording = second.clone();
    let (written, _) =
        fx.read(move |connection| transcript::append_live(connection, &recording, segment));
    assert_eq!(written.call_id.as_deref(), Some(call_id.as_str()));
    let evidence = vec![Evidence {
        source: EvidenceSource::Project,
        id: "P1".to_owned(),
        quote: "приём звонков".to_owned(),
    }];
    let patch = ValidatedPatch {
        ops: vec![
            ValidatedOp::CreateTopic {
                title: "Очередь".to_owned(),
            },
            ValidatedOp::AddQuestion(NewQuestion {
                text: "Сколько звонков теряется?".to_owned(),
                description: String::new(),
                card_field: CardLens::Goal,
                gap_type: GapType::Empty,
                priority: 1,
                evidence,
            }),
        ],
    };
    let recording = second.clone();
    fx.read(move |connection| call_state::apply_patch(connection, &recording, &patch));
    let state = fx.read(move |connection| call_state::get(connection, &second));
    assert_eq!(state.questions.len(), 1);
    assert_eq!(
        state.questions[0].call_id.as_deref(),
        Some(call_id.as_str())
    );
    assert_eq!(state.topics[0].call_id.as_deref(), Some(call_id.as_str()));
    assert_eq!(fx.call(&call_id).open_questions, 1);
}

/// "Отменить завершение" without microphone access: live without a
/// recording, and the error says why.
#[tokio::test]
async fn a_resume_that_cannot_record_stays_live() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.calls.finish(&call_id).await.unwrap();
    fx.record.denied.store(true, Ordering::SeqCst);

    let error = fx.calls.resume(&call_id).await.unwrap_err();

    assert!(matches!(error, CommandError::External { .. }), "{error:?}");
    let session = fx.calls.current();
    assert_eq!(session.status, CallSessionStatus::Live);
    assert_eq!(session.recording_id, None);
    assert_eq!(fx.call(&call_id).status, CallStatus::Live);
    // "Завершить" then has nothing to stop.
    let finishing = fx.calls.finish(&call_id).await.unwrap();
    assert_eq!(finishing.status, CallSessionStatus::Finishing);
    assert_eq!(fx.record.stops.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn unknown_calls_are_not_found_and_other_calls_invalid() {
    let fx = Fixture::new();
    let unknown = "0190d1a0-0000-7000-8000-00000000ffff";
    let other = fx
        .read(|connection| calls::create(connection, CallCreate::default()))
        .0
        .id;

    for call_id in [unknown, other.as_str()] {
        for result in [
            fx.calls.finish(call_id).await,
            fx.calls.resume(call_id).await,
            fx.calls.close(call_id).await,
            fx.calls.keep(call_id).await,
            fx.calls.discard(call_id).await,
        ] {
            let error = result.unwrap_err();
            if call_id == unknown {
                assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
            } else {
                assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
            }
        }
    }

    // During a call, another call is still not the current one.
    fx.start(None, &[]).await;
    let error = fx.calls.finish(&other).await.unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert_eq!(fx.calls.current().status, CallSessionStatus::Live);
}

/// "Окна при старте звонка" without "Компактный оверлей": the call window.
#[tokio::test]
async fn without_the_compact_overlay_a_start_opens_the_call_window() {
    let fx = Fixture::new();
    fx.record.set(CallSettings {
        compact_overlay: false,
        auto_end: None,
    });
    fx.start(None, &[]).await;
    assert_eq!(
        fx.record.windows(),
        vec![WindowStep::Hide(WIDGET), CALL_SHOWN]
    );
}

/// A call deleted while it runs (its project deleted, say) is gone on
/// "Завершить": its recording stops, no current call is left pointing at
/// nothing, and the overlay goes.
#[tokio::test]
async fn a_deleted_call_is_no_longer_current() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.read(|connection| calls::delete(connection, &call_id));
    fx.record.clear();

    let error = fx.calls.finish(&call_id).await.unwrap_err();

    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    assert_eq!(fx.calls.current(), CallSession::idle());
    assert_eq!(
        *fx.record.stops.lock().unwrap(),
        vec![live.recording_id.clone().unwrap()]
    );
    assert_eq!(
        fx.record.seen(),
        vec![
            Seen::Session(CallSession::idle()),
            Seen::Tray(false),
            Seen::Window(WindowStep::Hide(OVERLAY)),
        ]
    );
}

/// "Отменить завершение" of a call deleted while it finished: the call is
/// gone, not stuck finishing.
#[tokio::test]
async fn a_call_deleted_while_finishing_is_gone_on_resume() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.calls.finish(&call_id).await.unwrap();
    fx.read(|connection| calls::delete(connection, &call_id));
    fx.record.clear();

    let error = fx.calls.resume(&call_id).await.unwrap_err();

    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    assert_eq!(fx.calls.current(), CallSession::idle());
    assert_eq!(
        fx.record.starts.lock().unwrap().len(),
        1,
        "nothing recorded"
    );
    assert_eq!(
        fx.record.seen(),
        vec![
            Seen::Session(CallSession::idle()),
            Seen::Tray(false),
            Seen::Window(WindowStep::Hide(OVERLAY)),
        ]
    );
    // A new call can start.
    assert_eq!(fx.start(None, &[]).await.status, CallSessionStatus::Live);
}

/// "Продолжить" on a call deleted while it ran: gone, its recording stops.
#[tokio::test(start_paused = true)]
async fn a_call_deleted_while_live_is_gone_on_keep() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.calls.shared.on_mic(free(fx.now())).await;
    fx.read(|connection| calls::delete(connection, &call_id));
    fx.record.clear();

    let error = fx.calls.keep(&call_id).await.unwrap_err();

    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    assert_eq!(fx.calls.current(), CallSession::idle());
    assert_eq!(fx.record.stops.lock().unwrap().len(), 1);
    assert_eq!(
        fx.record.windows(),
        vec![WindowStep::Hide(OVERLAY)],
        "the overlay goes, the main window stays"
    );
    // The countdown went with it.
    tokio::time::sleep(FIVE_MINUTES * 2).await;
    assert_eq!(fx.calls.current(), CallSession::idle());
}

/// "Удалить все данные" during a call: discarded, no summary, the main
/// window stays; the row is the delete's.
#[tokio::test]
async fn discard_drops_the_call_without_a_summary() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.record.clear();

    let idle = fx.calls.discard(&call_id).await.unwrap();

    assert_eq!(idle, CallSession::idle());
    assert_eq!(fx.calls.current(), CallSession::idle());
    assert_eq!(
        *fx.record.stops.lock().unwrap(),
        vec![live.recording_id.clone().unwrap()]
    );
    assert_eq!(
        fx.record.seen(),
        vec![
            Seen::Session(CallSession::idle()),
            Seen::Tray(false),
            Seen::Window(WindowStep::Hide(OVERLAY)),
        ],
        "no `DataChanged`, no main window step"
    );
    assert_eq!(fx.call(&call_id).status, CallStatus::Live, "left as it is");

    // A finishing call: its recording has stopped already.
    let next = fx.start(None, &[]).await;
    fx.calls.finish(&id(&next)).await.unwrap();
    fx.record.clear();
    fx.calls.discard(&id(&next)).await.unwrap();
    assert_eq!(fx.calls.current(), CallSession::idle());
    assert_eq!(fx.record.stops.lock().unwrap().len(), 2);
    assert_eq!(fx.record.windows(), vec![WindowStep::Hide(OVERLAY)]);

    // Without a call: nothing, and an id that isn't current is `Invalid`.
    let error = fx.calls.discard(&call_id).await.unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
}

fn free(released_at: i64) -> MicEvent {
    MicEvent::Free {
        app: "zoom.us".to_owned(),
        released_at,
    }
}

/// "Менеджер не ответил": 5 minutes after Zoom let the microphone go the
/// call finishes by itself, every window counting to the same end, and the
/// main window opens its summary.
#[tokio::test(start_paused = true)]
async fn the_countdown_finishes_the_call() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.record.clear();
    let released_at = fx.now();

    fx.calls.shared.on_mic(free(released_at)).await;

    let counting = fx.calls.current();
    let expected = CallAutoEnd {
        app: "zoom.us".to_owned(),
        released_at,
        ends_at: Some(released_at + 300_000),
    };
    assert_eq!(counting.auto_end.as_ref(), Some(&expected));
    assert_eq!(fx.record.sessions(), vec![counting]);

    tokio::time::sleep(FIVE_MINUTES - Duration::from_secs(1)).await;
    assert_eq!(fx.calls.current().status, CallSessionStatus::Live);
    tokio::time::sleep(Duration::from_secs(2)).await;
    fx.until(CallSessionStatus::Finishing).await;

    let session = fx.calls.current();
    assert_eq!(session.auto_end, None);
    assert_eq!(fx.call(&call_id).status, CallStatus::Finishing);
    assert_eq!(fx.record.stops.lock().unwrap().len(), 1);
    assert_eq!(fx.record.windows(), windows::finishing());
}

/// "Звонилка вернулась": the countdown goes in every window, the call goes on.
#[tokio::test(start_paused = true)]
async fn a_busy_microphone_stops_the_countdown() {
    let fx = Fixture::new();
    fx.start(None, &[]).await;
    fx.record.clear();
    fx.calls.shared.on_mic(free(fx.now())).await;

    fx.calls.shared.on_mic(MicEvent::Busy).await;

    let sessions = fx.record.sessions();
    assert_eq!(sessions.len(), 2);
    assert!(sessions[0].auto_end.is_some());
    assert_eq!(sessions[1].auto_end, None);
    tokio::time::sleep(FIVE_MINUTES * 2).await;
    assert_eq!(fx.calls.current().status, CallSessionStatus::Live);
    assert!(fx.record.stops.lock().unwrap().is_empty());
}

/// "Продолжить": no countdown until the microphone is let go again.
#[tokio::test(start_paused = true)]
async fn keep_stops_the_countdown_until_the_next_release() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    let call_id = id(&live);
    fx.calls.shared.on_mic(free(fx.now())).await;

    let kept = fx.calls.keep(&call_id).await.unwrap();

    assert_eq!(kept.auto_end, None);
    tokio::time::sleep(FIVE_MINUTES * 2).await;
    assert_eq!(fx.calls.current().status, CallSessionStatus::Live);

    // Zoom takes the microphone and lets it go again: a new countdown.
    fx.calls.shared.on_mic(MicEvent::Busy).await;
    fx.calls.shared.on_mic(free(fx.now())).await;
    assert!(fx.calls.current().auto_end.is_some());
}

/// "Никогда": every window offers to end the call, without a countdown,
/// and the call doesn't end by itself; "Продолжить" withdraws the offer.
#[tokio::test(start_paused = true)]
async fn never_offers_to_end_without_a_countdown() {
    let fx = Fixture::new();
    fx.record.set(CallSettings {
        compact_overlay: true,
        auto_end: None,
    });
    let live = fx.start(None, &[]).await;
    fx.record.clear();
    let released_at = fx.now();

    fx.calls.shared.on_mic(free(released_at)).await;

    let offered = fx.calls.current();
    assert_eq!(
        offered.auto_end,
        Some(CallAutoEnd {
            app: "zoom.us".to_owned(),
            released_at,
            ends_at: None,
        })
    );
    assert_eq!(fx.record.sessions(), vec![offered]);
    tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
    assert_eq!(fx.calls.current().status, CallSessionStatus::Live);
    assert!(fx.record.stops.lock().unwrap().is_empty());

    let kept = fx.calls.keep(&id(&live)).await.unwrap();
    assert_eq!(kept.auto_end, None);
    assert_eq!(kept.status, CallSessionStatus::Live);
}

/// The countdown goes by the wall clock: after the machine slept past its
/// end, the call ends on the next look at the clock, not an uptime later.
#[tokio::test(start_paused = true)]
async fn the_countdown_follows_the_wall_clock() {
    let fx = Fixture::new();
    let live = fx.start(None, &[]).await;
    fx.calls.shared.on_mic(free(fx.now())).await;
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(fx.calls.current().status, CallSessionStatus::Live);

    // An hour of sleep: tokio's clock (the uptime) didn't move.
    fx.record.slept.store(60 * 60 * 1000, Ordering::SeqCst);
    tokio::time::sleep(CLOCK_CHECK).await;
    fx.until(CallSessionStatus::Finishing).await;

    assert_eq!(fx.call(&id(&live)).status, CallStatus::Finishing);
    assert_eq!(fx.record.stops.lock().unwrap().len(), 1);
}

/// The microphone let go without a call, or while one finishes: nothing.
#[tokio::test(start_paused = true)]
async fn a_release_outside_a_live_call_does_nothing() {
    let fx = Fixture::new();
    fx.calls.shared.on_mic(free(fx.now())).await;
    assert!(fx.record.seen().is_empty());
    assert_eq!(fx.calls.current(), CallSession::idle());

    let live = fx.start(None, &[]).await;
    fx.calls.finish(&id(&live)).await.unwrap();
    fx.record.clear();
    fx.calls.shared.on_mic(free(fx.now())).await;
    assert!(fx.record.seen().is_empty());
}

/// "Сразу записывать": the last call's project and its people, in the
/// overlay whatever "Компактный оверлей" says.
#[tokio::test]
async fn record_right_away_starts_the_last_calls_setup() {
    let fx = Fixture::new();
    fx.record.set(CallSettings {
        compact_overlay: false,
        auto_end: None,
    });
    let exchange = fx.project("Обменник");
    let igor = fx.person(&exchange, "Игорь");
    let first = fx.start(Some(&exchange), &[&igor]).await;
    fx.calls.finish(&id(&first)).await.unwrap();
    fx.calls.close(&id(&first)).await.unwrap();
    fx.record.clear();

    fx.calls.start_on_mic("zoom.us");
    fx.until(CallSessionStatus::Live).await;

    let session = fx.calls.current();
    assert_ne!(session.call_id, first.call_id);
    assert_eq!(session.project_id.as_deref(), Some(exchange.as_str()));
    assert_eq!(session.participant_ids, vec![igor]);
    assert_eq!(session.participants, vec!["Игорь"]);
    assert_eq!(
        fx.record.windows(),
        vec![WindowStep::Hide(WIDGET), OVERLAY_SHOWN]
    );

    // During the call another busy period starts nothing new.
    fx.calls.shared.on_mic(record_on("zoom.us")).await;
    assert_eq!(fx.calls.current(), session);
    assert_eq!(fx.count("calls"), 2);

    // The shortcut opens it where it started, the overlay, whatever the
    // setting says.
    assert_eq!(fx.calls.toggle_steps(), vec![OVERLAY_SHOWN]);
}

fn record_on(app: &str) -> MicEvent {
    MicEvent::Record {
        app: app.to_owned(),
    }
}

/// "Сразу записывать" without microphone access: no call, the start widget
/// instead, whose "Начать" says why.
#[tokio::test]
async fn record_right_away_that_cannot_record_shows_the_widget() {
    let fx = Fixture::new();
    fx.record.denied.store(true, Ordering::SeqCst);

    fx.calls.shared.on_mic(record_on("zoom.us")).await;

    assert_eq!(fx.calls.current(), CallSession::idle());
    assert_eq!(fx.count("calls"), 0);
    assert_eq!(fx.record.seen(), vec![Seen::Widget("zoom.us".to_owned())]);
}

/// `app-shell`, "Сочетание во время звонка": the call shows as at its
/// start, also after "Компактный оверлей" changed; the widget without one.
#[tokio::test]
async fn the_shortcut_opens_the_window_the_start_chose() {
    let fx = Fixture::new();
    let widget = WindowStep::Show {
        label: WIDGET,
        route: None,
    };
    assert_eq!(fx.calls.toggle_steps(), vec![widget]);

    let live = fx.start(None, &[]).await;
    fx.record.set(CallSettings {
        compact_overlay: false,
        auto_end: None,
    });
    assert_eq!(fx.calls.toggle_steps(), vec![OVERLAY_SHOWN]);
    fx.calls.finish(&id(&live)).await.unwrap();
    assert_eq!(fx.calls.toggle_steps(), vec![CALL_SHOWN]);
    fx.calls.close(&id(&live)).await.unwrap();
    assert_eq!(fx.calls.toggle_steps(), vec![widget]);

    fx.start(None, &[]).await;
    assert_eq!(fx.calls.toggle_steps(), vec![CALL_SHOWN]);
}

/// "Сразу записывать" before any call: a call without a project.
#[tokio::test]
async fn record_right_away_without_calls_has_no_project() {
    let fx = Fixture::new();
    fx.project("Обменник");
    fx.calls.shared.on_mic(record_on("zoom.us")).await;
    let session = fx.calls.current();
    assert_eq!(session.status, CallSessionStatus::Live);
    assert_eq!(session.project_id, None);
    assert!(session.participant_ids.is_empty());
}

/// The watcher's transitions reach the countdown through the queue.
#[tokio::test]
async fn the_watchers_transitions_drive_the_countdown() {
    let fx = Fixture::new();
    fx.start(None, &[]).await;
    fx.calls.mic_changed(&Transition::Free {
        app: "zoom.us".to_owned(),
        released_at: now_ms(),
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while fx.calls.current().auto_end.is_none() {
        assert!(Instant::now() < deadline, "no countdown");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    fx.calls.mic_changed(&Transition::AppChanged {
        app: "Google Chrome".to_owned(),
        since: 0,
    });
    fx.calls.mic_changed(&Transition::Busy {
        app: "zoom.us".to_owned(),
        since: now_ms(),
    });
    while fx.calls.current().auto_end.is_some() {
        assert!(Instant::now() < deadline, "the countdown stayed");
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

#[test]
fn the_session_serializes_in_camel_case() {
    let session = CallSession {
        status: CallSessionStatus::Live,
        call_id: Some("c1".to_owned()),
        project_id: None,
        participant_ids: vec!["p1".to_owned()],
        participants: vec!["Игорь".to_owned()],
        started_at: Some(1),
        recording_id: Some("r1".to_owned()),
        auto_end: Some(CallAutoEnd {
            app: "zoom.us".to_owned(),
            released_at: 2,
            ends_at: Some(3),
        }),
    };
    assert_eq!(
        serde_json::to_value(crate::events::CallSessionChanged { session }).unwrap(),
        serde_json::json!({
            "session": {
                "status": "live",
                "callId": "c1",
                "projectId": null,
                "participantIds": ["p1"],
                "participants": ["Игорь"],
                "startedAt": 1,
                "recordingId": "r1",
                "autoEnd": { "app": "zoom.us", "releasedAt": 2, "endsAt": 3 },
            }
        })
    );
}

/// «Удалить всё» with «Сразу записывать»: a busy microphone during the
/// wipe starts no call until the wipe lets go; a live call refuses it.
#[tokio::test]
async fn no_call_starts_while_the_data_is_deleted() {
    let fx = Fixture::new();
    let hold = fx.calls.hold_idle().await.unwrap();

    fx.calls.start_on_mic("zoom.us");
    for _ in 0..20 {
        tokio::task::yield_now().await;
        thread::sleep(Duration::from_millis(1));
    }
    assert!(!fx.calls.is_active());
    assert_eq!(fx.count("calls"), 0, "nothing written under the hold");

    drop(hold);
    fx.until(CallSessionStatus::Live).await;
    let error = fx.calls.hold_idle().await.err().unwrap();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
}
