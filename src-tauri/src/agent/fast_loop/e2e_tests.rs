//! End to end with a fake `claude` script (never the real CLI): a phrase →
//! a call of `ClaudeCodeCli` → its patch → `CallStateChanged` → what
//! `call_state_get` returns.

use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::json;

use super::{
    app,
    events::AgentLoopState,
    testing::{Provider, TestHost, database, recording, say},
};
use crate::{
    agent::claude_cli::ClaudeCodeCli,
    storage::{
        call_state::{self, AgentCallOutcome},
        transcript::TranscriptChannel,
    },
};

/// A fresh script may take seconds to start on macOS (see
/// `agent/fake_cli_tests.rs`).
const PATIENCE: Duration = Duration::from_secs(20);

/// Keeps the prefix file it got, reads the first segment id of the
/// message, and answers with a topic, a card field and a question quoting
/// `@QUOTE@` from that segment.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
previous=''
for arg in "$@"; do
  if [ "$previous" = '--system-prompt-file' ]; then cp "$arg" "$STATE/prompt"; fi
  previous="$arg"
done
cat > "$STATE/stdin"
segment=$(sed -n 's/^\[S:\([^]]*\)\].*/\1/p' "$STATE/stdin" | head -n 1)
evidence="[{\"source\":\"segment\",\"id\":\"S:$segment\",\"quote\":\"@QUOTE@\"}]"
echo '{"type":"system","subtype":"init","tools":["StructuredOutput"]}'
echo '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.82,"resetsAt":1793623200}}}}'
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.04,\"usage\":{\"input_tokens\":2,\"output_tokens\":300,\"cache_read_input_tokens\":5400,\"cache_creation_input_tokens\":0},\"structured_output\":{\"ops\":[{\"op\":\"topic\",\"action\":\"create\",\"title\":\"Очередь операторов\"},{\"op\":\"card\",\"field\":\"edgeCases\",\"value\":\"Все операторы заняты\",\"evidence\":$evidence},{\"op\":\"question\",\"title\":\"Что происходит со звонком, если все операторы заняты?\",\"description\":\"Сценарий не описан\",\"cardField\":\"edgeCases\",\"gapType\":\"empty\",\"priority\":3,\"evidence\":$evidence}]}}"
"#;

/// Starts a child that sleeps, notes its pid and waits on it: a CLI whose
/// request never ends.
const HANGING_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
cat > /dev/null
sleep 300 & echo $! > "$STATE/child.pid"
wait
"#;

struct Rig {
    dir: tempfile::TempDir,
    host: Arc<TestHost>,
    fast_loop: super::scheduler::FastLoop,
    recording: String,
}

impl Rig {
    fn new(quote: &str) -> Self {
        Self::with_script(&FAKE_CLAUDE.replace("@QUOTE@", quote))
    }

    fn with_script(script: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("bin/claude");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        let script = script.replace("@STATE@", &dir.path().display().to_string());
        fs::write(&cli, script).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        let work_dir = dir.path().join("app-data/agent");
        let agent = ClaudeCodeCli::new(cli, &work_dir);

        let db = database();
        let recording = recording(&db);
        let host = TestHost::new(db);
        let fast_loop =
            super::testing::fast_loop(host.clone(), Provider::ready(Arc::new(agent)), work_dir);
        Self {
            dir,
            host,
            fast_loop,
            recording,
        }
    }

    async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + PATIENCE;
        while !done(self) {
            assert!(Instant::now() < deadline, "no {what} in {PATIENCE:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// The phrase of the client that starts the call.
    async fn client_says(&self, text: &str) -> String {
        let segment = self.start_call(text);
        self.until("recorded call", Self::recorded).await;
        segment
    }

    fn start_call(&self, text: &str) -> String {
        self.fast_loop.live_started(&self.recording);
        let segment = self
            .host
            .db(|db| say(db, &self.recording, TranscriptChannel::Others, 0, text));
        self.fast_loop
            .phrase(&self.recording, TranscriptChannel::Others);
        segment.id
    }

    fn recorded(&self) -> bool {
        self.host
            .db(|db| call_state::agent_calls(db, &self.recording))
            .unwrap()
            .len()
            == 1
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// «Выйти» while a call is in flight: the CLI and what it started die at
/// once, the prefix file is gone before `shutdown` returns, the call is
/// recorded as cancelled.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_apps_exit_kills_the_cli_at_once() {
    let rig = Rig::with_script(HANGING_CLAUDE);
    rig.start_call("Если все заняты, тогда уже как получится");
    let pid_file = rig.dir.path().join("child.pid");
    rig.until("the CLI's child", |_| pid_file.exists()).await;
    let child: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(alive(child));
    let prompt =
        super::assembly::prompt_path(&rig.dir.path().join("app-data/agent"), &rig.recording);
    assert!(prompt.exists());

    let started = Instant::now();
    rig.fast_loop.shutdown();
    assert!(!prompt.exists(), "removed synchronously");
    // The group got SIGKILL inside `shutdown`; only the reaping is left.
    while alive(child) {
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "the CLI's child {child} outlived the app"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    rig.until("recorded call", Rig::recorded).await;
    let calls = rig
        .host
        .db(|db| call_state::agent_calls(db, &rig.recording))
        .unwrap();
    assert_eq!(calls[0].outcome, AgentCallOutcome::Cancelled);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_phrase_becomes_a_question_in_call_state_get() {
    let rig = Rig::new("если все заняты");
    let segment = rig
        .client_says("Если все заняты, тогда уже как получится")
        .await;
    rig.until("CallStateChanged", |rig| rig.host.changes() == 1)
        .await;

    let view = rig
        .host
        .db(|db| app::view(db, &rig.fast_loop, &rig.recording))
        .unwrap();
    let question = &view.state.questions[0];
    assert_eq!(
        question.text,
        "Что происходит со звонком, если все операторы заняты?"
    );
    assert!(question.visible);
    assert_eq!(question.rank, Some(0));
    assert_eq!(
        question.evidence[0].id, segment,
        "the S: prefix is stripped"
    );
    assert_eq!(view.state.topics[0].title, "Очередь операторов");
    assert_eq!(
        view.state.current_topic_id.as_ref(),
        Some(&view.state.topics[0].id)
    );
    rig.until("idle", |rig| {
        rig.fast_loop.status(&rig.recording).state == AgentLoopState::Idle
    })
    .await;
    let view = rig
        .host
        .db(|db| app::view(db, &rig.fast_loop, &rig.recording))
        .unwrap();
    assert_eq!(view.agent.utilization, Some(0.82));
    let json = serde_json::to_value(&view).unwrap();
    assert_eq!(json["agent"]["state"], json!({ "kind": "idle" }));
    assert_eq!(json["questions"][0]["visible"], json!(true));

    // The CLI got the prefix file and the volatile part on stdin.
    let prompt = fs::read_to_string(rig.dir.path().join("prompt")).unwrap();
    assert!(prompt.starts_with("# Правила"));
    assert!(prompt.contains("P1: Единая система приёма звонков"));
    let stdin = fs::read_to_string(rig.dir.path().join("stdin")).unwrap();
    assert!(stdin.contains(&format!("[S:{segment}] 00:00 Остальные: Если все заняты")));
    assert!(stdin.ends_with("StructuredOutput."));

    let calls = rig
        .host
        .db(|db| call_state::agent_calls(db, &rig.recording))
        .unwrap();
    assert_eq!(calls[0].outcome, AgentCallOutcome::Ok);
    assert_eq!(calls[0].output_tokens, Some(300));
    assert_eq!(calls[0].cost_usd, Some(0.04));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_quote_leaves_no_question_and_is_logged() {
    let rig = Rig::new("у нас двадцать операторов в смене");
    rig.client_says("Звонки идут на личные телефоны менеджеров")
        .await;

    let view = rig
        .host
        .db(|db| app::view(db, &rig.fast_loop, &rig.recording))
        .unwrap();
    assert!(view.state.questions.is_empty());
    let calls = rig
        .host
        .db(|db| call_state::agent_calls(db, &rig.recording))
        .unwrap();
    let rejected = calls[0].rejected.as_array().unwrap();
    let question = rejected
        .iter()
        .find(|rejection| rejection["op"] == "question")
        .unwrap();
    assert_eq!(
        question["subject"],
        "Что происходит со звонком, если все операторы заняты?"
    );
    let card = rejected
        .iter()
        .find(|rejection| rejection["op"] == "card")
        .unwrap();
    assert_eq!(card["reason"], "quoteNotFound");
    assert_eq!(card["quote"], "у нас двадцать операторов в смене");
}
