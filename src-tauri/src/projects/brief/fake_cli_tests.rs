//! The build against a fake `claude` that records what it was given and
//! plays `stream-json` lines (in the manner of
//! `agent/claude_cli/fake_cli_tests.rs`).

use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use super::{
    BriefProgress, BriefStageState, PROMPT,
    run::{self, prepare},
    tests::{TestHost, block_on, reply},
};
use crate::{
    agent::{
        claude_cli::{Agent, ClaudeCodeCli},
        limit::LimitPolicy,
    },
    events::{Change, DataChanged, Entity},
    projects::builds::BriefBuilds,
    storage::{
        new_id,
        projects::{BriefState, ProjectUpdate},
        sources::{self, NewSource, SourceStatus},
    },
};

/// macOS scans a new script on its first run, one at a time, so with tests
/// in parallel a fake may take seconds to start.
const SLOW_START: Duration = Duration::from_secs(4);

/// Counts its runs, records its arguments, stdin and prompt file, then
/// plays `events.jsonl`; `hang` plays the first two lines and waits on a
/// child.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
echo run >> "$STATE/runs"
for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args"
cat > "$STATE/stdin"
previous=''
for arg in "$@"; do
  if [ "$previous" = '--system-prompt-file' ]; then cat "$arg" > "$STATE/prompt"; fi
  previous="$arg"
done
case '@MODE@' in
  hang)
    head -n 2 "$STATE/events.jsonl"
    sleep 300 & echo $! > "$STATE/child.pid"
    wait ;;
  *)
    cat "$STATE/events.jsonl" ;;
esac
"#;

/// A call that thinks, then writes `output` through `StructuredOutput`.
fn events(output: &Value) -> String {
    let stream = |event: Value| json!({ "type": "stream_event", "event": event });
    [
        json!({ "type": "system", "subtype": "init", "model": "claude-sonnet-5-5" }),
        stream(json!({
            "type": "content_block_delta", "index": 0,
            "delta": { "type": "thinking_delta", "thinking": "Читаю ТЗ" }
        })),
        stream(json!({
            "type": "content_block_start", "index": 1,
            "content_block": { "type": "tool_use", "name": "StructuredOutput", "input": {} }
        })),
        stream(json!({
            "type": "content_block_delta", "index": 1,
            "delta": { "type": "input_json_delta", "partial_json": "{\"product\"" }
        })),
        json!({
            "type": "result", "subtype": "success", "is_error": false,
            "structured_output": output,
            "total_cost_usd": 0.21,
            "usage": { "input_tokens": 12_000, "output_tokens": 900 }
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
    fn new(output: &Value) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("events.jsonl"), events(output)).unwrap();
        Self { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn agent(&self, mode: &str) -> Arc<dyn Agent> {
        let body = FAKE_CLAUDE
            .replace("@STATE@", &self.path().display().to_string())
            .replace("@MODE@", mode);
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
        let deadline = Instant::now() + SLOW_START * 2;
        while Instant::now() < deadline {
            if let Ok(pid) = self.read("child.pid").trim().parse() {
                return pid;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("the fake did not start its child");
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

fn assert_killed(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still running");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn progress(stage: u8, state: BriefStageState) -> (u8, BriefStageState) {
    (stage, state)
}

fn stages(host: &TestHost) -> Vec<(u8, BriefStageState)> {
    host.progress()
        .into_iter()
        .map(|BriefProgress { stage, state, .. }| (stage, state))
        .collect()
}

fn project_events(host: &TestHost, project_id: &str) -> usize {
    let changed = DataChanged::new(
        Entity::Project,
        project_id,
        Some(project_id),
        Change::Updated,
    );
    host.sink
        .events()
        .iter()
        .filter(|event| **event == changed)
        .count()
}

/// Runs a build to its end.
fn build(host: &Arc<TestHost>, builds: &BriefBuilds, project_id: &str, agent: Arc<dyn Agent>) {
    let running = run::start(host, builds, project_id, Some(agent), LimitPolicy::Respect)
        .expect("a build starts");
    block_on(running).unwrap();
}

#[test]
fn a_build_saves_a_fresh_brief_with_stages_in_order() {
    let fake = Fake::new(&reply());
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let events_before = project_events(&host, &project.id);

    build(&host, &builds, &project.id, fake.agent("play"));

    use BriefStageState::{Done, Running};
    let mut expected = Vec::new();
    for stage in 1..=5 {
        expected.push(progress(stage, Running));
        expected.push(progress(stage, Done));
    }
    assert_eq!(stages(&host), expected);
    assert!(
        host.progress()
            .iter()
            .all(|event| event.project_id == project.id)
    );
    // One event when it started, one when it ended.
    assert_eq!(project_events(&host, &project.id) - events_before, 2);

    let saved = host.get(&project.id);
    assert_eq!(saved.brief_state, BriefState::Fresh);
    assert!(!saved.brief_truncated);
    assert!(saved.brief_built_at.is_some());
    let brief = saved.brief.unwrap();
    assert_eq!(brief["glossary"][0]["term"], "Медэлемент");
    // F1 is the project's document.
    let source = host.source_ids(&project.id).remove(0);
    assert_eq!(brief["keyDocuments"][0]["sourceId"], json!(source));
    assert!(!builds.is_building(&project.id));

    // The call: its model, effort and rules; the materials on stdin.
    let args = fake.read("args");
    let args: Vec<&str> = args.split('\0').collect();
    assert_eq!(
        &args[..5],
        ["-p", "--model", "claude-sonnet-5-5", "--effort", "medium"]
    );
    assert!(args.contains(&super::schema_argument()));
    assert_eq!(fake.read("prompt"), PROMPT);
    let stdin = fake.read("stdin");
    assert!(stdin.contains("Единая система приёма звонков"), "{stdin}");
    assert!(stdin.contains("- Ольга Демченко — CEO."), "{stdin}");
    assert!(
        stdin.contains("name=\"ТЗ.md\" nonce=\"")
            && stdin.contains("\">\nОчередь звонков, перезвон через 5 минут\n</document nonce=\""),
        "{stdin}"
    );
    // The prompt file goes with the build.
    let prompts = fs::read_dir(host.data.path().join("agent/briefs")).unwrap();
    assert_eq!(prompts.count(), 0);
}

#[test]
fn a_reply_that_is_not_a_brief_keeps_the_old_one() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let old = json!({ "product": "Прежний бриф", "stack": [], "modules": [], "glossary": [], "keyDocuments": [] });
    host.save(&project.id, &old);
    host.update(
        &project.id,
        ProjectUpdate {
            notes: Some("Новое".to_owned()),
            ..ProjectUpdate::default()
        },
    );

    let fake = Fake::new(&json!({ "product": 1, "summary": "не бриф" }));
    build(&host, &builds, &project.id, fake.agent("play"));

    let last = host.progress().pop().unwrap();
    assert_eq!(last.stage, 5);
    let BriefStageState::Failed { message } = last.state else {
        panic!("{last:?}");
    };
    assert!(message.contains("не по схеме"), "{message}");
    let kept = host.get(&project.id);
    assert_eq!(kept.brief, Some(old));
    assert_eq!(kept.brief_state, BriefState::Outdated);
}

#[test]
fn a_cancel_kills_the_agent_and_keeps_the_old_brief() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let old = json!({ "product": "Прежний бриф", "stack": [], "modules": [], "glossary": [], "keyDocuments": [] });
    host.save(&project.id, &old);

    let fake = Fake::new(&reply());
    let running = run::start(
        &host,
        &builds,
        &project.id,
        Some(fake.agent("hang")),
        LimitPolicy::Respect,
    )
    .unwrap();
    let child = fake.child_pid();
    let started = Instant::now();
    assert!(builds.cancel(&project.id));
    block_on(running).unwrap();
    assert!(started.elapsed() < SLOW_START, "{:?}", started.elapsed());
    assert_killed(child);

    // It was reading (the first delta) when it stopped.
    let last = host.progress().pop().unwrap();
    assert_eq!((last.stage, last.state), (3, BriefStageState::Cancelled));
    assert_eq!(host.get(&project.id).brief, Some(old));
    assert!(!builds.is_building(&project.id));
}

#[test]
fn a_second_request_while_building_starts_nothing() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let fake = Fake::new(&reply());
    let running = run::start(
        &host,
        &builds,
        &project.id,
        Some(fake.agent("hang")),
        LimitPolicy::Respect,
    )
    .unwrap();
    let child = fake.child_pid();
    assert_eq!(host.get(&project.id).brief_state, BriefState::None);
    assert!(builds.is_building(&project.id));

    let second = Fake::new(&reply());
    assert!(
        run::start(
            &host,
            &builds,
            &project.id,
            Some(second.agent("play")),
            LimitPolicy::Respect
        )
        .is_none()
    );
    assert!(!block_on(prepare(&host, &builds, &project.id)).unwrap());
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(second.runs(), 0);
    assert_eq!(fake.runs(), 1);

    builds.cancel(&project.id);
    block_on(running).unwrap();
    assert_killed(child);
    assert_eq!(fake.runs(), 1);
}

#[test]
fn shortened_materials_mark_the_brief() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let id = project.id.clone();
    // Twice the budget.
    let text = format!("НАЧАЛО {}", "текст ".repeat(super::input::BUDGET_CHARS / 3));
    block_on(host.storage().write(&host.sink, move |db| {
        sources::insert(
            db,
            &NewSource {
                id: new_id(),
                project_id: id.clone(),
                name: "Переписка.txt".to_owned(),
                extension: "txt".to_owned(),
                size: 1,
                sha256: "2".repeat(64),
                stored_path: format!("projects/{id}/sources/y.txt"),
                status: SourceStatus::Ready,
                text_chars: 0,
                text,
                truncated: false,
                error: None,
            },
        )
    }))
    .unwrap();

    let fake = Fake::new(&reply());
    build(&host, &builds, &project.id, fake.agent("play"));

    let saved = host.get(&project.id);
    assert_eq!(saved.brief_state, BriefState::Fresh);
    assert!(saved.brief_truncated);
    let stdin = fake.read("stdin");
    assert!(stdin.contains("Материалы сокращены"));
    assert!(
        stdin.contains("<document id=\"F2\" name=\"Переписка.txt\" note=\"сокращён\" nonce=\"")
    );
    assert!(stdin.contains("\">\nНАЧАЛО"));
    assert!(stdin.chars().count() <= super::input::BUDGET_CHARS);
}

/// Without a ready agent the build fails at stage 2, the brief untouched.
#[test]
fn a_build_without_a_ready_agent_fails_at_the_start() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let running = run::start(&host, &builds, &project.id, None, LimitPolicy::Respect).unwrap();
    block_on(running).unwrap();
    let last = host.progress().pop().unwrap();
    assert_eq!(last.stage, 2);
    assert_eq!(
        last.state,
        BriefStageState::Failed {
            message: "Нужен вход в Claude Code".to_owned()
        }
    );
    assert_eq!(host.get(&project.id).brief_state, BriefState::None);
}

/// `brief_prepare` with a ready agent and an outdated brief starts one.
#[test]
fn prepare_refreshes_an_outdated_brief() {
    let fake = Fake::new(&reply());
    let host = TestHost::new(Some(fake.agent("play")));
    let builds = BriefBuilds::default();
    let project = host.project();
    host.save(&project.id, &reply());
    host.update(
        &project.id,
        ProjectUpdate {
            description: Some("Другое описание".to_owned()),
            ..ProjectUpdate::default()
        },
    );
    assert_eq!(host.get(&project.id).brief_state, BriefState::Outdated);
    assert!(block_on(prepare(&host, &builds, &project.id)).unwrap());
    let deadline = Instant::now() + SLOW_START * 2;
    while builds.is_building(&project.id) {
        assert!(Instant::now() < deadline, "the build did not end");
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(host.get(&project.id).brief_state, BriefState::Fresh);
    assert_eq!(fake.runs(), 1);
}

/// Deleting the project stops its build: the agent is killed and the build
/// ends `cancelled`, not with an error about a missing project.
#[test]
fn deleting_the_project_cancels_its_build() {
    let host = TestHost::new(None);
    let builds = BriefBuilds::default();
    let project = host.project();
    let fake = Fake::new(&reply());
    let running = run::start(
        &host,
        &builds,
        &project.id,
        Some(fake.agent("hang")),
        LimitPolicy::Respect,
    )
    .unwrap();
    let child = fake.child_pid();

    block_on(crate::projects::delete(
        host.storage(),
        &host.sink,
        &builds,
        &project.id,
    ))
    .unwrap();
    block_on(running).unwrap();
    assert_killed(child);
    let last = host.progress().pop().unwrap();
    assert_eq!(last.state, BriefStageState::Cancelled);
    assert!(
        host.progress()
            .iter()
            .all(|event| !matches!(event.state, BriefStageState::Failed { .. }))
    );
    assert!(!builds.is_building(&project.id));
}
