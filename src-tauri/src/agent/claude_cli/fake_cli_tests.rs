//! `ClaudeCodeCli` against a fake `claude` that prints fixture lines, in the
//! manner of `agent/fake_cli_tests.rs`.

use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::json;
use tokio::sync::oneshot;

use super::{
    Agent, AgentError, AgentReply, AgentRequest, ClaudeCodeCli, MODEL, TIMEOUT,
    tests::{EMPTY_PATCH, NOT_A_PATCH, NOT_LOGGED_IN, RATE_LIMITED, SUCCESS},
};

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// macOS scans a new script on its first run, one at a time, so with tests
/// in parallel a fake may take seconds to start (see `agent/fake_cli_tests.rs`).
const SLOW_START: Duration = Duration::from_secs(4);

/// Records its cwd, arguments (NUL-separated), environment, stdin and the
/// prompt file it was given, then plays `events.jsonl`. `hang` prints the first line and waits on a child;
/// `crash` prints to stderr only.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
pwd -P > "$STATE/cwd"
for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args"
printf '%s' "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" > "$STATE/env"
cat > "$STATE/stdin"
previous=''
for arg in "$@"; do
  if [ "$previous" = '--system-prompt-file' ]; then cat "$arg" > "$STATE/prompt"; fi
  previous="$arg"
done
case '@MODE@' in
  hang)
    head -n 1 "$STATE/events.jsonl"
    sleep 300 & echo $! > "$STATE/child.pid"
    wait ;;
  crash)
    echo "Error: something broke" >&2
    exit 3 ;;
  *)
    cat "$STATE/events.jsonl"
    exit '@EXIT@' ;;
esac
"#;

struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new(events: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("events.jsonl"), events).unwrap();
        Self { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn agent(&self, mode: &str, exit: u8, timeout: Duration) -> ClaudeCodeCli {
        let body = FAKE_CLAUDE
            .replace("@STATE@", &self.path().display().to_string())
            .replace("@MODE@", mode)
            .replace("@EXIT@", &exit.to_string());
        let cli = self.path().join("bin/claude");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, body).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        ClaudeCodeCli {
            timeout,
            ..ClaudeCodeCli::new(cli, self.work_dir())
        }
    }

    fn work_dir(&self) -> PathBuf {
        self.path().join("app-data/agent")
    }

    fn read(&self, name: &str) -> String {
        fs::read_to_string(self.path().join(name)).unwrap()
    }

    fn child_pid(&self) -> Option<i32> {
        let deadline = Instant::now() + SLOW_START;
        while Instant::now() < deadline {
            if let Ok(pid) = fs::read_to_string(self.path().join("child.pid"))
                && let Ok(pid) = pid.trim().parse()
            {
                return Some(pid);
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }
}

const PROMPT: &str = "# Правила\nПротокол патча…\n\n# Проект\nP1 Единая система приёма звонков";

/// The prompt file goes in the fake's folder.
fn request_in(fake: &Fake) -> AgentRequest {
    let file = fake.path().join("prompt file.md");
    fs::write(&file, PROMPT).unwrap();
    AgentRequest {
        system_prompt_file: file,
        user_message: "Режим: обычный\n[S:0196f3a2-7c41-7d2e-9a10-3b5c8d4e6f70] 03:12 Остальные: если все заняты, тогда уже как получится\n\nПередай патч одним вызовом инструмента StructuredOutput."
            .into(),
        schema: r#"{"type":"object","required":["ops"]}"#.into(),
        process: crate::agent::process::TreeSlot::default(),
    }
}

fn run(fake: &Fake, agent: &ClaudeCodeCli) -> Result<AgentReply, AgentError> {
    let (_cancel, cancelled) = oneshot::channel();
    block_on(agent.run(request_in(fake), cancelled))
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

#[test]
fn defaults_follow_the_spike() {
    let agent = ClaudeCodeCli::new("claude", "agent");
    assert_eq!(agent.model, MODEL);
    assert_eq!(agent.model, "claude-sonnet-5-5");
    assert_eq!(agent.timeout, TIMEOUT);
    assert_eq!(TIMEOUT, Duration::from_secs(30));
}

#[test]
fn success_runs_the_minimal_mode_and_returns_the_patch_with_usage() {
    let fake = Fake::new(SUCCESS);
    let agent = fake.agent("play", 0, SLOW_START * 2);
    let reply = run(&fake, &agent).unwrap();

    assert_eq!(reply.patch["ops"][0]["op"], "question");
    assert_eq!(reply.usage.input_tokens, 2);
    assert_eq!(reply.usage.output_tokens, 1464);
    assert_eq!(reply.usage.cache_read, 1292);
    assert_eq!(reply.usage.cache_write, 10_049);
    assert_eq!(reply.usage.cost_usd, Some(0.054_969_2));
    assert_eq!(reply.usage.utilization, Some(0.24));
    assert_eq!(reply.usage.resets_at, Some(1_793_623_200_000));
    assert!(reply.usage.duration_ms > 0);

    let request = request_in(&fake);
    let prompt_file = request.system_prompt_file.display().to_string();
    let args = fake.read("args");
    let args: Vec<&str> = args.strip_suffix('\0').unwrap().split('\0').collect();
    assert_eq!(
        args,
        [
            "-p",
            "--model",
            "claude-sonnet-5-5",
            "--effort",
            "low",
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--tools",
            "",
            "--no-session-persistence",
            "--disable-slash-commands",
            "--system-prompt-file",
            &prompt_file,
            "--json-schema",
            &request.schema,
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]
    );
    assert_eq!(fake.read("stdin"), request.user_message);
    assert_eq!(fake.read("prompt"), PROMPT, "the CLI reads the prefix file");
    assert_eq!(fake.read("env"), "1");
    assert_eq!(
        fake.read("cwd").trim(),
        fake.work_dir()
            .canonicalize()
            .unwrap()
            .display()
            .to_string(),
        "runs from the work dir, created when missing"
    );
}

#[test]
fn an_empty_patch_is_a_reply() {
    let fake = Fake::new(EMPTY_PATCH);
    let reply = run(&fake, &fake.agent("play", 0, SLOW_START * 2)).unwrap();
    assert_eq!(reply.patch, json!({ "ops": [] }));
    assert_eq!(reply.usage.utilization, Some(0.82));
}

#[test]
fn output_that_is_not_a_patch_is_invalid() {
    let fake = Fake::new(NOT_A_PATCH);
    let outcome = run(&fake, &fake.agent("play", 0, SLOW_START * 2));
    assert!(
        matches!(outcome, Err(AgentError::InvalidOutput(_))),
        "{outcome:?}"
    );
}

#[test]
fn not_logged_in_is_recognized() {
    let fake = Fake::new(NOT_LOGGED_IN);
    assert_eq!(
        run(&fake, &fake.agent("play", 1, SLOW_START * 2)),
        Err(AgentError::NotLoggedIn)
    );
}

#[test]
fn rate_limited_is_recognized_with_the_reset() {
    let fake = Fake::new(RATE_LIMITED);
    assert_eq!(
        run(&fake, &fake.agent("play", 1, SLOW_START * 2)),
        Err(AgentError::RateLimited {
            resets_at: Some(1_793_641_200_000)
        })
    );
}

#[test]
fn a_crash_without_a_result_is_a_process_error() {
    let fake = Fake::new("");
    let Err(AgentError::Process(message)) = run(&fake, &fake.agent("crash", 0, SLOW_START * 2))
    else {
        panic!("not a process error");
    };
    assert!(message.contains("(код 3)"), "{message}");
    assert!(message.contains("something broke"), "{message}");
}

#[test]
fn a_hanging_cli_times_out_and_is_killed() {
    let fake = Fake::new(SUCCESS);
    let started = Instant::now();
    assert_eq!(
        run(&fake, &fake.agent("hang", 0, SLOW_START)),
        Err(AgentError::Timeout)
    );
    assert!(
        started.elapsed() < SLOW_START * 2,
        "{:?}",
        started.elapsed()
    );
    assert_killed(fake.child_pid().expect("the fake started its child"));
}

#[test]
fn a_cancel_kills_the_cli() {
    let fake = Fake::new(SUCCESS);
    let agent = fake.agent("hang", 0, TIMEOUT);
    let (cancel, cancelled) = oneshot::channel();
    let started = Instant::now();
    let outcome = block_on(async {
        let stop = async {
            while !fake.path().join("child.pid").exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let _ = cancel.send(());
        };
        tokio::join!(agent.run(request_in(&fake), cancelled), stop).0
    });
    assert_eq!(outcome, Err(AgentError::Cancelled));
    assert!(
        started.elapsed() < SLOW_START * 2,
        "{:?}",
        started.elapsed()
    );
    assert_killed(fake.child_pid().unwrap());
}

/// The app's exit (`FastLoop::shutdown`): the slot kills the running CLI
/// and its children from another thread, synchronously, without the call's
/// task doing anything; a slot killed before the spawn kills it at once.
#[test]
fn the_tree_slot_kills_the_cli_from_outside_its_task() {
    let fake = Fake::new(SUCCESS);
    let agent = fake.agent("hang", 0, TIMEOUT);
    let request = request_in(&fake);
    let slot = request.process.clone();
    let started = Instant::now();
    let call = std::thread::spawn(move || {
        let (_cancel, cancelled) = oneshot::channel();
        block_on(agent.run(request, cancelled))
    });
    let child = fake.child_pid().expect("the fake started its child");
    slot.kill();
    assert_killed(child);
    let outcome = call.join().unwrap();
    assert!(
        matches!(outcome, Err(AgentError::Process(_))),
        "{outcome:?}"
    );
    assert!(
        started.elapsed() < SLOW_START * 2,
        "{:?}",
        started.elapsed()
    );

    // Killed before it started: the CLI dies as soon as it is spawned.
    let fake = Fake::new(SUCCESS);
    let agent = fake.agent("hang", 0, TIMEOUT);
    let request = request_in(&fake);
    request.process.kill();
    let (_cancel, cancelled) = oneshot::channel();
    assert!(block_on(agent.run(request, cancelled)).is_err());
    assert!(
        started.elapsed() < SLOW_START * 4,
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn works_as_a_shared_trait_object() {
    let fake = Fake::new(EMPTY_PATCH);
    let agent: std::sync::Arc<dyn Agent> =
        std::sync::Arc::new(fake.agent("play", 0, SLOW_START * 2));
    let (_cancel, cancelled) = oneshot::channel();
    let request = request_in(&fake);
    let reply = block_on(tauri::async_runtime::spawn(async move {
        agent.run(request, cancelled).await
    }))
    .unwrap();
    assert_eq!(reply.unwrap().patch, json!({ "ops": [] }));
}
