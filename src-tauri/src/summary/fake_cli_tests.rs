//! The build wired to the call's manager, against a fake `claude` script
//! (in the manner of `projects/brief/fake_cli_tests.rs`): what a call's end
//! looks like from «Завершить» to «завершён» (`call-lifecycle`,
//! `call-summary`, "Ошибка сборки").

use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::{
    CANCELLED, GRILL_LIMIT, SummaryStage, SummaryStageState,
    builds::{Stop, SummaryBuilds},
    run,
    run_tests::{ScriptedAgent, TestHost, block_on},
};
use crate::{
    agent::{
        claude_cli::{Agent, ClaudeCodeCli, WindowShare, WindowShares},
        limit::{LimitPolicy, MeasureSource, Metered},
    },
    call::{
        CallHost, CallManager, CallRecorder, CallSettings, CallStart, DbWork, windows::WindowStep,
    },
    error::CommandResult,
    events::{CallSession, CallSessionStatus, DataChanged},
    storage::{
        calls::{self, CallStatus},
        now_ms, projects,
        recordings::{self, RecordingFiles, RecordingLinks},
        summaries::{self, SummaryState, SummaryTranscriptPass},
        transcript::{TranscriptChannel, append_live},
    },
};

/// macOS scans a new script on its first run, one at a time, so with tests
/// in parallel a fake may take seconds to start.
const SLOW_START: Duration = Duration::from_secs(4);

const NOT_LOGGED_IN: &str = include_str!("../agent/claude_cli/fixtures/not_logged_in.jsonl");

/// Counts its runs, records its arguments, then plays `proposals.jsonl`
/// for call B and `events.jsonl` for call A; `hang` plays a line and waits
/// on a child; `crash` prints to stderr only.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
echo run >> "$STATE/runs"
for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args"
cat > "$STATE/stdin"
case '@MODE@' in
  hang)
    head -n 1 "$STATE/events.jsonl"
    sleep 300 & echo $! > "$STATE/child.pid"
    wait ;;
  crash)
    echo "Error: something broke" >&2
    exit 3 ;;
esac
case "$*" in
  *'"title":"Proposals"'*) cat "$STATE/proposals.jsonl" ;;
  *) cat "$STATE/events.jsonl" ;;
esac
exit '@EXIT@'
"#;

/// A call that writes `output` through `StructuredOutput`.
fn events(output: &Value) -> String {
    [
        json!({ "type": "system", "subtype": "init", "model": "claude-sonnet-5-5" }),
        json!({
            "type": "result", "subtype": "success", "is_error": false,
            "structured_output": output,
            "total_cost_usd": 0.4,
            "usage": { "input_tokens": 30_000, "output_tokens": 2_000 }
        }),
    ]
    .iter()
    .map(|line| format!("{line}\n"))
    .collect()
}

struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new(summary: &str, proposals: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("events.jsonl"), summary).unwrap();
        fs::write(dir.path().join("proposals.jsonl"), proposals).unwrap();
        Self { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn agent(&self, mode: &str, exit: u8) -> Arc<dyn Agent> {
        let body = FAKE_CLAUDE
            .replace("@STATE@", &self.path().display().to_string())
            .replace("@MODE@", mode)
            .replace("@EXIT@", &exit.to_string());
        let cli = self.path().join("bin/claude");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, body).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        Arc::new(ClaudeCodeCli::new(cli, self.path().join("app-data/agent")))
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path().join(name)).unwrap_or_default()
    }

    fn runs(&self) -> usize {
        self.read("runs").lines().count()
    }

    fn child_pid(&self) -> i32 {
        wait_until("the fake did not start its child", SLOW_START * 2, || {
            self.read("child.pid").trim().parse::<i32>().is_ok()
        });
        self.read("child.pid").trim().parse().unwrap()
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn wait_until(what: &str, within: Duration, done: impl Fn() -> bool) {
    let deadline = Instant::now() + within;
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/* The call's manager, wired to the builds as in the app */

/// `CallHost` of the app in small: the test host's database, the builds
/// started and stopped as `AppCallHost` does.
struct Wired {
    host: Arc<TestHost>,
    builds: SummaryBuilds,
}

impl CallHost for Wired {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        self.host.storage().read_now(|connection| work(connection))
    }

    fn data_changed(&self, event: DataChanged) {
        crate::events::EventSink::data_changed(self.host.as_ref(), event);
    }

    fn session_changed(&self, _session: &CallSession) {}

    fn settings(&self) -> CallSettings {
        CallSettings {
            compact_overlay: false,
            auto_end: None,
        }
    }

    fn window(&self, _step: WindowStep) {}

    fn show_widget(&self, _app: &str) {}

    fn tray(&self, _in_call: bool) {}

    fn summary_start(&self, call_id: &str) {
        run::start(&self.host, &self.builds, call_id, LimitPolicy::Respect);
    }

    fn summary_cancel(&self, call_id: &str) {
        self.builds.stop(call_id, Stop::Aborted);
    }
}

/// Writes a recording row with a phrase of the client, as the recorder and
/// the live pass would; no devices.
struct Recorder(Arc<TestHost>);

const SAID: &str = "Курс у нас обновляется раз в минуту, это важно";

impl CallRecorder for Recorder {
    fn start(&self, links: &RecordingLinks) -> CommandResult<String> {
        self.0.storage().read_now(|connection| {
            let id = recordings::create(connection, links, now_ms(), |id| RecordingFiles {
                me: format!("recordings/{id}/me.opus"),
                others: format!("recordings/{id}/others.opus"),
            })?;
            let segment = crate::storage::transcript::SegmentInput {
                channel: TranscriptChannel::Others,
                start_ms: 5_000,
                end_ms: 7_000,
                text: SAID.to_owned(),
            };
            append_live(connection, &id, segment)?;
            Ok(id)
        })
    }

    fn stop(&self, id: &str) -> CommandResult<()> {
        self.0
            .storage()
            .read_now(|connection| recordings::finish(connection, id, now_ms()).map(|_| ()))
    }
}

struct App {
    host: Arc<TestHost>,
    builds: SummaryBuilds,
    calls: CallManager,
}

impl App {
    fn new(agent: Option<Arc<dyn Agent>>) -> Self {
        let host = TestHost::new(agent);
        // No second pass runs here: the live transcript after a short wait.
        *host.silence.lock().unwrap() = Duration::from_millis(200);
        let builds = SummaryBuilds::default();
        let calls = CallManager::new(
            Wired {
                host: Arc::clone(&host),
                builds: builds.clone(),
            },
            Recorder(Arc::clone(&host)),
            tauri::async_runtime::handle().inner().clone(),
        );
        assert!(host.calls.set(calls.clone()).is_ok());
        Self {
            host,
            builds,
            calls,
        }
    }

    /// A live call of «Обменник».
    fn start(&self) -> String {
        let project = self
            .host
            .storage()
            .read_now(|connection| {
                projects::create(
                    connection,
                    projects::ProjectCreate {
                        name: "Обменник".to_owned(),
                        ..projects::ProjectCreate::default()
                    },
                )
            })
            .unwrap()
            .0
            .id;
        let session = block_on(self.calls.start(CallStart {
            project_id: Some(project),
            participant_ids: None,
            ..CallStart::default()
        }))
        .unwrap();
        session.call_id.unwrap()
    }

    fn finish(&self, call_id: &str) {
        block_on(self.calls.finish(call_id)).unwrap();
    }

    /// Until the build ended and the call is no longer finishing.
    fn settle(&self, call_id: &str) {
        wait_until("the build did not end", SLOW_START * 4, || {
            !self.builds.is_building(call_id)
                && self.calls.current().status != CallSessionStatus::Finishing
        });
    }

    fn status(&self, call_id: &str) -> CallStatus {
        self.host
            .storage()
            .read_now(|connection| calls::get(connection, call_id))
            .unwrap()
            .status
    }
}

fn reply() -> Value {
    json!({
        "title": "Курс для туристов",
        "tldr": "Обсудили курс.",
        "topics": [{
            "refs": [], "title": "Курс валют", "from": "S1", "to": "S1",
            "points": [{
                "text": "Курс обновляется раз в минуту", "status": "fact",
                "evidence": [{ "id": "S1", "quote": "курс у нас обновляется раз в минуту" }]
            }],
            "card": { "title": "", "fields": [] }
        }],
        "answered": [],
        "next": []
    })
}

/// «Завершить» → the build through the CLI, both calls → «завершён».
#[test]
fn finishing_builds_the_summary_and_closes_the_call() {
    let fake = Fake::new(&events(&reply()), &events(&json!({ "proposals": [] })));
    let app = App::new(Some(fake.agent("play", 0)));
    let call = app.start();

    app.finish(&call);
    app.settle(&call);

    assert_eq!(app.calls.current(), CallSession::idle());
    assert_eq!(app.status(&call), CallStatus::Finished);
    let summary = app.host.summary(&call);
    assert_eq!(summary.state, SummaryState::Ready, "{summary:?}");
    assert_eq!(summary.title, "Курс для туристов");
    assert_eq!(summary.transcript_pass, Some(SummaryTranscriptPass::Live));
    assert_eq!(fake.runs(), 2);
    let args = fake.read("args");
    let args: Vec<&str> = args.split('\0').collect();
    assert_eq!(
        &args[..5],
        ["-p", "--model", "claude-sonnet-5-5", "--effort", "medium"]
    );
    assert!(fake.read("stdin").contains("[S1] "));
    assert_eq!(app.host.last().state, SummaryStageState::Done);
}

/// «Агент не вошёл»: the call is «завершён», the summary failed with a
/// reason the page shows as «нужен вход в Claude Code».
#[test]
fn an_agent_not_logged_in_fails_the_summary_and_the_call_still_finishes() {
    let fake = Fake::new(NOT_LOGGED_IN, NOT_LOGGED_IN);
    let app = App::new(Some(fake.agent("play", 1)));
    let call = app.start();

    app.finish(&call);
    app.settle(&call);

    assert_eq!(app.status(&call), CallStatus::Finished);
    let summary = app.host.summary(&call);
    assert_eq!(summary.state, SummaryState::Failed);
    assert_eq!(summary.error.as_deref(), Some("Нужен вход в Claude Code"));
    let last = app.host.last();
    assert_eq!(last.stage, SummaryStage::Summary);
    assert_eq!(
        last.state,
        SummaryStageState::Failed {
            message: "Нужен вход в Claude Code".to_owned()
        }
    );
    assert_eq!(fake.runs(), 1);

    // Without the CLI at all (the status check fails): the same.
    let app = App::new(None);
    let call = app.start();
    app.finish(&call);
    app.settle(&call);
    assert_eq!(app.status(&call), CallStatus::Finished);
    assert_eq!(
        app.host.summary(&call).error.as_deref(),
        Some("Нужен вход в Claude Code")
    );
}

/// «Итоги не собрались»: the agent gave no answer; the call is «завершён»
/// and a new call can start.
#[test]
fn an_agent_that_does_not_answer_still_finishes_the_call() {
    let fake = Fake::new("", "");
    let app = App::new(Some(fake.agent("crash", 0)));
    let call = app.start();

    app.finish(&call);
    app.settle(&call);

    assert_eq!(app.status(&call), CallStatus::Finished);
    assert_eq!(app.host.summary(&call).state, SummaryState::Failed);
    let next = app.start();
    assert_ne!(next, call);
    assert_eq!(app.calls.current().status, CallSessionStatus::Live);
}

/// «Отменить завершение» kills the build: nothing is saved, the call is
/// live again and is not closed.
#[test]
fn resuming_kills_the_build() {
    let fake = Fake::new(&events(&reply()), &events(&json!({ "proposals": [] })));
    let app = App::new(Some(fake.agent("hang", 0)));
    let call = app.start();
    app.finish(&call);
    let child = fake.child_pid();

    let resumed = block_on(app.calls.resume(&call)).unwrap();
    assert_eq!(resumed.status, CallSessionStatus::Live);
    wait_until("the agent is still running", Duration::from_secs(3), || {
        !alive(child)
    });
    wait_until("the build did not end", SLOW_START, || {
        !app.builds.is_building(&call)
    });

    assert!(app.host.closed().is_empty(), "nothing closes the call");
    assert_eq!(app.calls.current().status, CallSessionStatus::Live);
    assert_eq!(app.status(&call), CallStatus::Live);
    // L7: nothing is saved, the row as it was before the build: none, so
    // the live call has no summary.
    let id = call.clone();
    let stored = app
        .host
        .storage()
        .read_now(move |db| summaries::get(db, &id))
        .unwrap();
    assert_eq!(stored, None);
    assert_eq!(app.host.last().state, SummaryStageState::Cancelled);
}

/// «Остановить» on the summary page: the agent is killed, the call is
/// «завершён» and the summary «не собраны».
#[test]
fn stopping_the_build_finishes_the_call_without_a_summary() {
    let fake = Fake::new(&events(&reply()), &events(&json!({ "proposals": [] })));
    let app = App::new(Some(fake.agent("hang", 0)));
    let call = app.start();
    app.finish(&call);
    let child = fake.child_pid();
    let started = Instant::now();

    block_on(run::stop(app.host.as_ref(), &app.builds, &call));
    app.settle(&call);

    assert!(started.elapsed() < SLOW_START, "{:?}", started.elapsed());
    wait_until("the agent is still running", Duration::from_secs(3), || {
        !alive(child)
    });
    assert_eq!(app.calls.current(), CallSession::idle());
    assert_eq!(app.status(&call), CallStatus::Finished);
    let summary = app.host.summary(&call);
    assert_eq!(
        (summary.state, summary.error.as_deref()),
        (SummaryState::Failed, Some(CANCELLED))
    );
    let last = app.host.last();
    assert_eq!(
        (last.stage, last.state),
        (SummaryStage::Summary, SummaryStageState::Cancelled)
    );

    // Without a build: a stop of a finished call changes nothing.
    block_on(run::stop(app.host.as_ref(), &app.builds, &call));
    assert_eq!(app.status(&call), CallStatus::Finished);
}

/// The window's own fake flow closes the call first (`call_close`, until
/// task 4.2): the build goes on, saves, and its close changes nothing.
#[test]
fn a_window_closing_the_call_first_does_not_stop_the_build() {
    let agent = ScriptedAgent::new(Ok(reply()), Ok(json!({ "proposals": [] })));
    let (release, released) = std::sync::mpsc::channel::<()>();
    let released = std::sync::Mutex::new(released);
    *agent.before.lock().unwrap() = Some(Box::new(move || {
        released.lock().unwrap().recv().ok();
    }));
    let app = App::new(Some(agent.clone()));
    let call = app.start();
    app.finish(&call);
    wait_until("call A did not start", SLOW_START, || agent.calls() == 1);

    let idle = block_on(app.calls.close(&call)).unwrap();
    assert_eq!(idle, CallSession::idle());
    assert_eq!(app.status(&call), CallStatus::Finished);
    assert!(app.builds.is_building(&call));

    release.send(()).unwrap();
    app.settle(&call);
    assert_eq!(app.host.summary(&call).state, SummaryState::Ready);
    assert_eq!(app.host.closed(), vec![call.clone()]);
    assert_eq!(app.status(&call), CallStatus::Finished);
    // The window can start a new call meanwhile and after.
    let _ = app.start();
    assert_eq!(app.calls.current().status, CallSessionStatus::Live);
}

/* Лимит Grill (agent-limit-guard design.md, decision 7) */

/// A call with the limit event of CLI 2.1.316: the session at 44 %.
fn events_with_limit(output: &Value) -> String {
    let limit = json!({
        "type": "rate_limit_event",
        "rate_limit_info": {
            "status": "allowed", "resetsAt": 4_102_444_800_u64, "rateLimitType": "five_hour",
            "unifiedWindows": {
                "five_hour": { "utilization": 0.44, "resetsAt": 4_102_444_800_u64, "status": "allowed" },
                "seven_day": { "utilization": 0.2, "resetsAt": 4_102_444_800_u64, "status": "allowed" }
            }
        }
    });
    format!("{limit}\n{}", events(output))
}

/// The session at `used` (0–1), resetting far ahead.
fn session_at(app: &App, used: f64) {
    app.host.limit.observe(
        MeasureSource::Usage,
        WindowShares {
            session: Some(WindowShare {
                used,
                resets_at: Some(4_102_444_800_000),
            }),
            week: None,
        },
        now_ms(),
    );
}

impl App {
    /// The fake's agent, measuring the host's limit as `Metered` does in
    /// the app.
    fn metered(fake: &Fake) -> Self {
        let app = Self::new(None);
        let agent: Arc<dyn Agent> = Arc::new(Metered {
            agent: fake.agent("play", 0),
            limit: app.host.limit.clone(),
        });
        *app.host.agent.lock().unwrap() = Some(agent);
        app
    }

    fn summary_state(&self, call_id: &str) -> (SummaryState, Option<String>) {
        let summary = self.host.summary(call_id);
        (summary.state, summary.error)
    }
}

/// «Звонок закончился за порогом», then «Окно сбросилось»: the call is
/// «завершён» without an agent call; once the threshold lets go the summary
/// is built by itself.
#[test]
fn at_the_threshold_the_summary_waits_and_builds_once_it_lets_go() {
    let fake = Fake::new(&events(&reply()), &events(&json!({ "proposals": [] })));
    let app = App::metered(&fake);
    session_at(&app, 0.93);
    let call = app.start();
    app.finish(&call);
    app.settle(&call);
    assert_eq!(app.status(&call), CallStatus::Finished);
    assert_eq!(
        app.summary_state(&call),
        (SummaryState::Failed, Some(GRILL_LIMIT.to_owned()))
    );
    assert_eq!(fake.runs(), 0, "no agent call");

    tauri::async_runtime::spawn(run::build_when_limit_lets_go(
        Arc::clone(&app.host),
        app.builds.clone(),
        app.host.limit.clone(),
    ));
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(fake.runs(), 0, "still at the threshold");
    // The session reset: the next poll says 3 %.
    session_at(&app, 0.03);
    wait_until("the summary was not built", SLOW_START * 4, || {
        app.summary_state(&call).0 == SummaryState::Ready
    });
    assert_eq!(fake.runs(), 2);
}

/// «Собрать сверх лимита»; a call that went past the threshold still waits.
#[test]
fn a_call_over_the_limit_still_waits_and_over_the_limit_builds_at_once() {
    let fake = Fake::new(
        &events_with_limit(&reply()),
        &events(&json!({ "proposals": [] })),
    );
    let app = App::metered(&fake);
    session_at(&app, 0.95);
    let call = app.start();
    let recording = app.calls.current().recording_id.unwrap();
    app.host.limit.allow_over(&recording);
    app.finish(&call);
    app.settle(&call);
    assert_eq!(
        app.summary_state(&call),
        (SummaryState::Failed, Some(GRILL_LIMIT.to_owned()))
    );

    let running = run::start(&app.host, &app.builds, &call, LimitPolicy::Over).unwrap();
    block_on(running).unwrap();
    assert_eq!(app.summary_state(&call).0, SummaryState::Ready);
    assert_eq!(fake.runs(), 2);
    // Its limit event measured the session (agent-limit-guard task 1.5).
    let session = app.host.limit.view().session.unwrap();
    assert_eq!((session.used, session.source), (44, MeasureSource::Call));
}
