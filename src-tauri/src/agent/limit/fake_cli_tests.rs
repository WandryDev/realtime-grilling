//! The poll of `/usage` against a fake `claude` that prints the fixture, in
//! the manner of `agent/claude_cli/fake_cli_tests.rs`.

use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    time::Duration,
};

use super::{
    Clock, LimitThresholds, Refresh, SubscriptionLimit,
    tests::{USAGE, utc},
    usage::{self, ARGS},
};
use crate::agent::process::TreeSlot;

/// Counts its runs, records its arguments (NUL-separated) and `TZ`, then
/// prints `reply.json`; `slow` first waits a second, `hang` never answers.
const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
echo run >> "$STATE/runs"
for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args"
printf '%s' "$TZ" > "$STATE/tz"
case '@MODE@' in
  hang) sleep 300 ;;
  slow) sleep 1; cat "$STATE/reply.json" ;;
  *) cat "$STATE/reply.json" ;;
esac
"#;

struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new(mode: &str, reply: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("reply.json"), reply).unwrap();
        let body = FAKE_CLAUDE
            .replace("@STATE@", &dir.path().display().to_string())
            .replace("@MODE@", mode);
        let cli = dir.path().join("bin/claude");
        fs::create_dir_all(cli.parent().unwrap()).unwrap();
        fs::write(&cli, body).unwrap();
        fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
        Self { dir }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn cli(&self) -> PathBuf {
        self.path().join("bin/claude")
    }

    fn runs(&self) -> usize {
        fs::read_to_string(self.path().join("runs"))
            .unwrap_or_default()
            .lines()
            .count()
    }

    fn ready(&self) -> Option<(PathBuf, PathBuf)> {
        Some((self.cli(), self.path().to_path_buf()))
    }
}

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn limit() -> SubscriptionLimit {
    SubscriptionLimit::new(
        Clock(std::sync::Arc::new(|| utc(2026, 11, 24, 16, 0))),
        LimitThresholds::default(),
    )
}

#[test]
fn the_poll_runs_in_utc_with_no_history_and_measures_both_windows() {
    let fake = Fake::new("plain", USAGE);
    let limit = limit();
    let outcome = block_on(limit.refresh(|| async { fake.ready() }));
    assert_eq!(outcome, Refresh::Measured);
    let args = fs::read_to_string(fake.path().join("args")).unwrap();
    let args: Vec<&str> = args.split('\0').filter(|arg| !arg.is_empty()).collect();
    let expected: Vec<&str> = ARGS.into_iter().filter(|arg| !arg.is_empty()).collect();
    assert_eq!(args, expected);
    assert_eq!(fs::read_to_string(fake.path().join("tz")).unwrap(), "UTC");
    let view = limit.view();
    assert_eq!(view.session.unwrap().used, 1);
    assert_eq!(view.week.unwrap().used, 0);
    assert!(!view.checking);
}

#[test]
fn without_a_ready_agent_nothing_runs() {
    let fake = Fake::new("plain", USAGE);
    let limit = limit();
    let outcome = block_on(limit.refresh(|| async { None }));
    assert_eq!(outcome, Refresh::NotReady);
    assert_eq!(fake.runs(), 0);
    assert_eq!(limit.view().session, None);
}

#[test]
fn a_reply_it_does_not_know_keeps_the_measures() {
    let fake = Fake::new("plain", USAGE);
    let limit = limit();
    block_on(limit.refresh(|| async { fake.ready() }));
    let before = limit.view();
    fs::write(
        fake.path().join("reply.json"),
        r#"{"type":"result","is_error":false,"result":"Your plan: Max. Usage moved to the web."}"#,
    )
    .unwrap();
    let outcome = block_on(limit.refresh(|| async { fake.ready() }));
    assert!(matches!(outcome, Refresh::Failed(_)), "{outcome:?}");
    assert_eq!(limit.view(), before);

    let fresh = super::SubscriptionLimit::default();
    block_on(fresh.refresh(|| async { fake.ready() }));
    assert_eq!(fresh.view().session, None, "no measures: «нет данных»");
    assert_eq!(fresh.reached(), None);
}

#[test]
fn two_requests_at_once_run_one_poll() {
    let fake = Fake::new("slow", USAGE);
    let limit = limit();
    let (first, second) = block_on(async {
        tokio::join!(
            limit.refresh(|| async { fake.ready() }),
            limit.refresh(|| async { fake.ready() }),
        )
    });
    assert_eq!(fake.runs(), 1);
    assert_eq!(first, Refresh::Measured);
    assert_eq!(second, Refresh::Joined);
    // Once it ended, a new request polls again.
    block_on(limit.refresh(|| async { fake.ready() }));
    assert_eq!(fake.runs(), 2);
}

#[test]
fn a_poll_that_hangs_is_killed_at_its_timeout() {
    let fake = Fake::new("hang", USAGE);
    let started = std::time::Instant::now();
    let polled = block_on(usage::poll(
        &fake.cli(),
        fake.path(),
        &TreeSlot::default(),
        Duration::from_millis(500),
        || 0,
    ));
    assert!(polled.is_err());
    assert!(started.elapsed() < Duration::from_secs(10));
}
