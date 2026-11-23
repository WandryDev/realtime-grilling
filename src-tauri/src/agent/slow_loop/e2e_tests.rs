//! End to end with a fake `claude` script (never the real CLI) and the fake
//! Outline and ClickUp (agent-slow-loop task 3.4): a project synced from
//! both, a recording, a slow call of `ClaudeCodeCli` → a finding in what
//! `call_state_get` returns, and not one request to the services meanwhile.

use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use super::{
    app, assembly,
    scheduler::{SlowConfig, SlowLoop},
};
use crate::{
    agent::{
        claude_cli::ClaudeCodeCli,
        fast_loop::{
            events::AgentStatus,
            scheduler::{DbWork, FastLoop, LoopConfig, LoopHost},
            testing::{FakeAgent, Provider},
        },
        halt::AgentHalt,
    },
    connectors::{
        ConnectorKind, SelectionItem, SelectionItemKind,
        clickup::fake::{FakeClickUp, TOKEN},
        testing::{FakeOutline, Host, KEY, collection},
    },
    error::CommandResult,
    storage::{
        self,
        call_state::{self, AgentCallKind, AgentCallOutcome},
        context_findings::{ContextSearch, ContextSources, FindingSourceKind},
        recordings::{self, RecordingFiles, RecordingLinks},
        transcript::{self, SegmentInput, TranscriptChannel},
    },
};

/// A fresh script may take seconds to start on macOS.
const PATIENCE: Duration = Duration::from_secs(20);

/// Keeps its arguments, prompt and message; picks the first five words of
/// the first line of `[C1]` as the quote.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
printf '%s\n' "$@" > "$STATE/args"
previous=''
for arg in "$@"; do
  if [ "$previous" = '--system-prompt-file' ]; then cp "$arg" "$STATE/prompt"; fi
  previous="$arg"
done
cat > "$STATE/stdin"
quote=$(awk 'found == 1 { print; exit } /^\[C1\]/ { found = 1 }' "$STATE/stdin" | cut -d ' ' -f 1-5)
echo '{"type":"system","subtype":"init","tools":["StructuredOutput"]}'
printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"total_cost_usd\":0.01,\"usage\":{\"input_tokens\":3,\"output_tokens\":90,\"cache_read_input_tokens\":1200,\"cache_creation_input_tokens\":0},\"structured_output\":{\"findings\":[{\"candidate\":\"C1\",\"quote\":\"$quote\",\"note\":\"Противоречит: в регламенте три оператора\"}],\"queries\":[\"старший смены\"]}}"
"#;

/// A CLI whose request never ends, with a child.
const HANGING_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
cat > /dev/null
sleep 300 & echo $! > "$STATE/child.pid"
wait
"#;

const REGULATION: &str = "Оператор смены отвечает за распределение звонков между линиями. \
                          В смене три оператора, старший смены следит за очередью.";

/// 16 words of the client.
const CLIENT: &str = "У нас операторы смены сами распределяют звонки между линиями, \
                      старший смены иногда следит за очередью, вот так и работаем";

/// The connectors' host as the loops' host.
struct StorageHost {
    host: Arc<Host>,
    changes: AtomicUsize,
}

impl LoopHost for StorageHost {
    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        self.host.storage.read_now(|connection| work(connection))
    }

    fn call_state_changed(&self, _recording_id: &str) {
        self.changes.fetch_add(1, Ordering::SeqCst);
    }

    fn agent_status(&self, _status: &AgentStatus) {}

    fn now_ms(&self) -> i64 {
        storage::now_ms()
    }
}

struct Rig {
    dir: tempfile::TempDir,
    outline: FakeOutline,
    clickup: FakeClickUp,
    loop_host: Arc<StorageHost>,
    recording: String,
    work_dir: std::path::PathBuf,
    cli: std::path::PathBuf,
}

/// A project with an Outline document and a ClickUp task, synced; a
/// recording of it where the client spoke; the fake CLI `script`.
fn rig(script: &str) -> Rig {
    let outline = FakeOutline::start();
    {
        let mut state = outline.state();
        state.add_collection("tm", "Телемедиа", 1);
        state.edit("tm-1", REGULATION);
    }
    let clickup = FakeClickUp::start();
    {
        let mut state = clickup.state();
        state.add_space("s1", "Клиенты");
        state.add_list("s1", None, "l1", 1);
        state.edit("l1-1", "Интеграция с МИС до марта.");
    }
    let host = Host::clickup(&clickup);
    host.connect(&outline);
    host.connect_clickup(TOKEN, None);
    let project = host.project("Телемедиа");
    host.select(&project, vec![collection("tm")]).unwrap();
    host.select_in(
        ConnectorKind::ClickUp,
        &project,
        vec![SelectionItem {
            item_kind: SelectionItemKind::Container,
            external_id: "list:l1".to_owned(),
            title: "Список".to_owned(),
            url: None,
        }],
    )
    .unwrap();
    let recording = host
        .storage
        .read_now(|db| {
            let links = RecordingLinks {
                call_id: None,
                project_id: Some(project.clone()),
                participant_ids: Vec::new(),
            };
            let id = recordings::create(db, &links, 1_000, |id| RecordingFiles {
                me: format!("recordings/{id}/me.opus"),
                others: format!("recordings/{id}/others.opus"),
            })?;
            transcript::append_live(
                db,
                &id,
                SegmentInput {
                    channel: TranscriptChannel::Others,
                    start_ms: 0,
                    end_ms: 4_000,
                    text: CLIENT.to_owned(),
                },
            )?;
            Ok(id)
        })
        .unwrap();

    let dir = tempfile::tempdir().unwrap();
    let cli = dir.path().join("bin/claude");
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    let script = script.replace("@STATE@", &dir.path().display().to_string());
    fs::write(&cli, script).unwrap();
    fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
    let work_dir = dir.path().join("app-data/agent");
    Rig {
        dir,
        outline,
        clickup,
        loop_host: Arc::new(StorageHost {
            host,
            changes: AtomicUsize::new(0),
        }),
        recording,
        work_dir,
        cli,
    }
}

impl Rig {
    /// A slow loop on the current runtime with the fake CLI; a minute is
    /// 200 ms here.
    fn slow_loop(&self) -> SlowLoop {
        let agent = ClaudeCodeCli::new(&self.cli, &self.work_dir);
        SlowLoop::new(
            self.loop_host.clone(),
            Provider::ready(Arc::new(agent)),
            tokio::runtime::Handle::current(),
            SlowConfig {
                every: Duration::from_millis(200),
                ..SlowConfig::new(&self.work_dir)
            },
            AgentHalt::default(),
        )
    }

    fn requests(&self) -> (usize, usize) {
        (
            self.outline.state().log.len(),
            self.clickup.state().log.len(),
        )
    }

    async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + PATIENCE;
        while !done(self) {
            assert!(Instant::now() < deadline, "no {what} in {PATIENCE:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn slow_calls(&self) -> Vec<call_state::AgentCall> {
        self.loop_host
            .host
            .storage
            .read_now(|db| call_state::agent_calls(db, &self.recording))
            .unwrap()
            .into_iter()
            .filter(|call| call.kind == AgentCallKind::SlowLoop)
            .collect()
    }
}

/// Task 3.4: the finding reaches `call_state_get`; the services get no
/// request during the call; no key or token reaches the agent.
#[test]
fn a_recording_with_an_outline_source_gets_a_finding() {
    let rig = rig(FAKE_CLAUDE);
    let before = rig.requests();
    assert!(before.0 > 0 && before.1 > 0, "the sync reached both fakes");

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let slow_loop = rig.slow_loop();
        let fast_loop = FastLoop::new(
            rig.loop_host.clone(),
            Provider::ready(FakeAgent::new([])),
            tokio::runtime::Handle::current(),
            LoopConfig::new(rig.dir.path().join("fast")),
        );
        slow_loop.live_started(&rig.recording);
        // The index is built before the client's words count.
        rig.until("the search", |_| slow_loop.search(&rig.recording).is_some())
            .await;
        slow_loop.phrase(&rig.recording, TranscriptChannel::Others, CLIENT, None);
        rig.until("a recorded call", |rig| !rig.slow_calls().is_empty())
            .await;

        let view = rig
            .loop_host
            .host
            .storage
            .read_now(|db| app::view(db, &fast_loop, &slow_loop, &rig.recording))
            .unwrap();
        let findings = &view.state.findings;
        assert_eq!(findings.len(), 1, "{:?}", rig.slow_calls());
        let finding = &findings[0];
        assert_eq!(finding.source_kind, FindingSourceKind::Outline);
        assert_eq!(finding.quote, "Оператор смены отвечает за распределение");
        assert_eq!(finding.note, "Противоречит: в регламенте три оператора");
        assert!(finding.source_url.is_some());
        assert_eq!(
            view.state.context_sources,
            ContextSources {
                files: 0,
                outline: 1,
                clickup: 1
            }
        );
        assert_eq!(
            view.state.context_search,
            Some(ContextSearch {
                running: false,
                queries: vec!["старший смены".to_owned()]
            })
        );
        let call = &rig.slow_calls()[0];
        assert_eq!(call.outcome, AgentCallOutcome::Ok);
        assert_eq!(call.cache_read, Some(1_200));
        assert!(rig.loop_host.changes.load(Ordering::SeqCst) >= 3);
        slow_loop.live_finished(&rig.recording);
        rig.until("the end of the search", |_| {
            slow_loop.search(&rig.recording).is_none()
        })
        .await;
    });

    assert_eq!(rig.requests(), before, "no request to the services");
    let args = fs::read_to_string(rig.dir.path().join("args")).unwrap();
    for flag in [
        "--tools",
        "--strict-mcp-config",
        "--json-schema",
        "--effort",
    ] {
        assert!(args.lines().any(|line| line == flag), "no {flag}: {args}");
    }
    let prompt = fs::read_to_string(rig.dir.path().join("prompt")).unwrap();
    assert!(prompt.starts_with(assembly::RULES));
    let stdin = fs::read_to_string(rig.dir.path().join("stdin")).unwrap();
    assert!(stdin.contains("[C1] Outline «Документ tm-1»"), "{stdin}");
    for secret in [KEY, TOKEN] {
        for text in [&args, &prompt, &stdin] {
            assert!(!text.contains(secret), "a secret reached the agent");
        }
    }
    assert!(
        !assembly::prompt_path(&rig.work_dir, &rig.recording).exists(),
        "removed at the end of the live pass"
    );
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// «Выйти» while a slow call is in flight: the CLI and its child die at
/// once, the prompt file is gone, the call is recorded as cancelled.
#[test]
fn the_apps_exit_kills_the_slow_loops_cli() {
    let rig = rig(HANGING_CLAUDE);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let slow_loop = rig.slow_loop();
        slow_loop.live_started(&rig.recording);
        rig.until("the search", |_| slow_loop.search(&rig.recording).is_some())
            .await;
        slow_loop.phrase(&rig.recording, TranscriptChannel::Others, CLIENT, None);
        let pid_file = rig.dir.path().join("child.pid");
        rig.until("the CLI's child", |_| pid_file.exists()).await;
        let child: i32 = fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(alive(child));
        let prompt = assembly::prompt_path(&rig.work_dir, &rig.recording);
        assert!(prompt.exists());

        let started = Instant::now();
        slow_loop.shutdown();
        assert!(!prompt.exists(), "removed synchronously");
        while alive(child) {
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "the CLI's child {child} outlived the app"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        rig.until("the recorded call", |rig| !rig.slow_calls().is_empty())
            .await;
        assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::Cancelled);
    });
}
