use std::{
    fs,
    os::unix::fs::PermissionsExt as _,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

use serde_json::json;
use tokio::sync::oneshot;

use super::{
    AgentSessions, AgentState, NO_LOGIN, NOT_RESPONDING, check_path,
    discover::{self, SearchEnv},
    finish_login, install, locate, locate_and_check, login, process, status,
};
use crate::{
    error::CommandError,
    events::{Change, DataChanged, Entity, testing::RecordingSink},
    storage::{
        Storage,
        settings::{self, SettingsMap},
    },
};

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

/// macOS scans a new script on its first run, one at a time (~0.15 s
/// each), so with tests in parallel a fake may take seconds to start.
/// Timeouts that must outlast that start use this.
const SLOW_START: Duration = Duration::from_secs(4);

const FAKE_CLAUDE: &str = r#"#!/bin/sh
STATE='@STATE@'
MODE='@MODE@'
watch() { sleep 300 & echo $! > "$STATE/child.pid"; }
case "$1" in
  --version)
    if [ "$MODE" = hang ]; then watch; wait; fi
    echo "2.1.316 (Claude Code)"
    exit 0 ;;
  auth)
    case "$2" in
      status)
        if [ "$MODE" = garbage ]; then echo "not json at all"; exit 0; fi
        if [ -f "$STATE/logged-in" ]; then
          echo '{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "subscriptionType": "max"}'
          exit 0
        fi
        echo '{"loggedIn": false, "authMethod": "none"}'
        exit 1 ;;
      login)
        if [ "$MODE" = linger ]; then watch; fi
        echo "Opening browser to sign in…"
        echo "https://claude.ai/oauth/authorize?code=true&state=abc"
        printf "Paste code here if prompted > "
        read code
        if [ "$code" = "good-code" ]; then touch "$STATE/logged-in"; echo "Login successful."; exit 0; fi
        echo "OAuth error: invalid code" >&2
        exit 1 ;;
    esac ;;
esac
echo "unknown arguments: $*" >&2
exit 2
"#;

/// A temp folder with a fake CLI and its state.
struct Fake {
    dir: tempfile::TempDir,
}

impl Fake {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().unwrap(),
        }
    }

    fn path(&self) -> &Path {
        self.dir.path()
    }

    fn script(&self, relative: &str, body: &str) -> PathBuf {
        let path = self.path().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn claude(&self, mode: &str) -> PathBuf {
        let body = FAKE_CLAUDE
            .replace("@STATE@", &self.path().display().to_string())
            .replace("@MODE@", mode);
        self.script(&format!("bin-{mode}/claude"), &body)
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

    fn env(&self) -> SearchEnv {
        SearchEnv {
            path: Some(self.path().join("empty-path").into_os_string()),
            home: Some(self.path().join("home")),
            app_data: None,
            login_shell: None,
            cwd: self.path().to_owned(),
        }
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

/// The process ends within a few seconds (killed and reaped by launchd).
fn assert_killed(pid: i32) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while alive(pid) {
        assert!(Instant::now() < deadline, "process {pid} is still running");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn agent_path(storage: &Storage) -> serde_json::Value {
    block_on(storage.read(settings::get))
        .unwrap()
        .get(settings::AGENT_PATH)
        .cloned()
        .unwrap_or_default()
}

/// «Указать другой»: a working CLI answers its status; a path without one
/// is `notInstalled` and is never run. Nothing is saved either way.
#[test]
fn check_path_tells_the_status_of_a_path_without_saving_it() {
    let fake = Fake::new();
    let cli = fake.claude("ok");
    let state = block_on(check_path(&cli, fake.path()));
    assert_eq!(
        state,
        AgentState::NeedsLogin {
            version: "2.1.316".to_owned()
        }
    );

    let missing = fake.path().join("nowhere/claude");
    assert_eq!(
        block_on(check_path(&missing, fake.path())),
        AgentState::NotInstalled
    );
    // A program of another name is not run, even if it would answer.
    let other = fake.script(
        "bin/not-claude",
        "#!/bin/sh\ntouch \"$0.ran\"\necho 2.0.0\n",
    );
    assert_eq!(
        block_on(check_path(&other, fake.path())),
        AgentState::NotInstalled
    );
    assert!(
        !fake.path().join("bin/not-claude.ran").exists(),
        "never run"
    );
    assert_eq!(
        block_on(check_path(fake.path(), fake.path())),
        AgentState::NotInstalled,
        "a folder"
    );
}

#[test]
fn finds_the_cli_in_a_known_place_and_replaces_a_stale_agent_path() {
    let fake = Fake::new();
    let installed = fake.script("home/.local/bin/claude", "#!/bin/sh\n");
    let storage = Storage::in_memory();
    let sink = RecordingSink::default();
    let stale = SettingsMap::from([(settings::AGENT_PATH.to_owned(), json!("/gone/claude"))]);
    block_on(storage.write(&sink, move |db| Ok(((), settings::put(db, &stale)?)))).unwrap();
    let before = sink.events().len();

    let found = block_on(locate(&storage, &sink, &fake.env()));
    assert_eq!(found.as_deref(), Some(installed.as_path()));
    assert_eq!(agent_path(&storage), json!(installed.display().to_string()));
    assert_eq!(
        sink.events()[before..],
        [DataChanged::new(
            Entity::Settings,
            settings::SETTINGS_ID,
            None,
            Change::Updated
        )]
    );

    let again = block_on(locate(&storage, &sink, &fake.env()));
    assert_eq!(again, found);
    assert_eq!(sink.events().len(), before + 1, "nothing new to save");
}

#[test]
fn the_saved_path_and_path_come_before_known_places() {
    let fake = Fake::new();
    fake.script("home/.local/bin/claude", "#!/bin/sh\n");
    let on_path = fake.script("on-path/claude", "#!/bin/sh\n");
    let saved = fake.script("saved/claude", "#!/bin/sh\n");
    let not_executable = fake.path().join("plain/claude");
    fs::create_dir_all(not_executable.parent().unwrap()).unwrap();
    fs::write(&not_executable, "").unwrap();

    let mut env = fake.env();
    env.path = Some(on_path.parent().unwrap().as_os_str().to_owned());
    assert_eq!(
        block_on(discover::find(Some(&saved), &env)).as_deref(),
        Some(saved.as_path())
    );
    assert_eq!(
        block_on(discover::find(Some(&not_executable), &env)).as_deref(),
        Some(on_path.as_path())
    );
}

#[test]
fn a_login_shell_finds_what_the_gui_path_misses() {
    let fake = Fake::new();
    let cli = fake.script("nvm/bin/claude", "#!/bin/sh\n");
    let shell = fake.script(
        "shell",
        &format!(
            "#!/bin/sh\n[ \"$1\" = -ilc ] && echo 'motd' && echo '{}'\n",
            cli.display()
        ),
    );
    let mut env = fake.env();
    env.home = None;
    env.login_shell = Some(shell);
    // Known places outside the temp folder may exist on a dev machine.
    if discover::known_locations(&env)
        .iter()
        .any(|location| discover::is_executable(location))
    {
        return;
    }
    assert_eq!(
        block_on(discover::find(None, &env)).as_deref(),
        Some(cli.as_path())
    );
}

#[test]
fn status_follows_the_cli() {
    let fake = Fake::new();
    let cli = fake.claude("normal");
    let cwd = fake.path();
    assert_eq!(
        block_on(status(&cli, cwd, Duration::from_secs(10))),
        AgentState::NeedsLogin {
            version: "2.1.316".into()
        }
    );
    fs::write(fake.path().join("logged-in"), "").unwrap();
    assert_eq!(
        block_on(status(&cli, cwd, Duration::from_secs(10))),
        AgentState::Ready {
            version: "2.1.316".into(),
            subscription_type: Some("max".into()),
            email: Some("a@b.c".into())
        }
    );
    assert_eq!(
        block_on(status(
            &fake.path().join("missing/claude"),
            cwd,
            Duration::from_secs(10)
        )),
        AgentState::NotInstalled
    );
}

#[test]
fn garbage_from_the_cli_is_an_error() {
    let fake = Fake::new();
    let state = block_on(status(
        &fake.claude("garbage"),
        fake.path(),
        Duration::from_secs(10),
    ));
    let AgentState::Error { message } = state else {
        panic!("{state:?}");
    };
    assert!(message.contains("not json at all"), "{message}");
}

#[test]
fn a_hanging_cli_is_killed_and_reported() {
    let fake = Fake::new();
    let started = Instant::now();
    let state = block_on(status(&fake.claude("hang"), fake.path(), SLOW_START));
    assert_eq!(
        state,
        AgentState::Error {
            message: NOT_RESPONDING.into()
        }
    );
    assert!(started.elapsed() < SLOW_START * 2);
    assert_killed(fake.child_pid().expect("the fake started its child"));
}

#[test]
fn login_with_the_right_code_is_ready() {
    let fake = Fake::new();
    let cli = fake.claude("normal");
    let session = block_on(login::start(&cli, fake.path(), 1, login::URL_TIMEOUT)).unwrap();
    assert_eq!(
        session.url(),
        "https://claude.ai/oauth/authorize?code=true&state=abc"
    );
    let state = block_on(finish_login(session, "good-code", &cli, fake.path())).unwrap();
    assert_eq!(
        state,
        AgentState::Ready {
            version: "2.1.316".into(),
            subscription_type: Some("max".into()),
            email: Some("a@b.c".into())
        }
    );
}

#[test]
fn a_wrong_code_is_invalid_and_ends_the_session() {
    let fake = Fake::new();
    let cli = fake.claude("normal");
    let session = block_on(login::start(&cli, fake.path(), 1, login::URL_TIMEOUT)).unwrap();
    let error = block_on(finish_login(session, "bad-code", &cli, fake.path())).unwrap_err();
    assert_eq!(error, CommandError::invalid(login::WRONG_CODE));
    assert!(matches!(
        block_on(status(&cli, fake.path(), Duration::from_secs(10))),
        AgentState::NeedsLogin { .. }
    ));
}

#[test]
fn a_cancelled_or_expired_login_kills_the_cli() {
    let fake = Fake::new();
    let cli = fake.claude("linger");
    let session = block_on(login::start(&cli, fake.path(), 1, login::URL_TIMEOUT)).unwrap();
    let child = fake.child_pid().unwrap();
    drop(session);
    assert_killed(child);

    fs::remove_file(fake.path().join("child.pid")).unwrap();
    let slot = login::Slot::default();
    let session = block_on(login::start(&cli, fake.path(), 7, login::URL_TIMEOUT)).unwrap();
    let child = fake.child_pid().unwrap();
    block_on(async {
        *slot.lock().await = Some(session);
        login::expire_later(&slot, 7, Duration::from_millis(100));
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(slot.lock().await.is_none(), "expired");
    });
    assert_killed(child);
}

#[test]
fn a_cli_without_a_link_is_external() {
    let fake = Fake::new();
    let mute = fake.script(
        "mute/claude",
        "#!/bin/sh\necho 'Something else'\nsleep 30\n",
    );
    let error = block_on(login::start(&mute, fake.path(), 1, SLOW_START))
        .err()
        .unwrap();
    let CommandError::External { message, .. } = error else {
        panic!("{error:?}");
    };
    assert!(message.contains("Something else"), "{message}");
}

#[test]
fn the_code_never_shows_in_errors() {
    let fake = Fake::new();
    // Echoes what it reads, then hangs: the timeout error carries the output.
    let echo = fake.script(
        "echo/claude",
        "#!/bin/sh\necho 'https://claude.ai/oauth/authorize?x=1'\nread code\necho \"got $code\"\nsleep 5\n",
    );
    let session = block_on(login::start(&echo, fake.path(), 1, login::URL_TIMEOUT)).unwrap();
    let error = block_on(login::submit(
        session,
        "secret-code",
        Duration::from_millis(500),
    ))
    .unwrap_err();
    let CommandError::External { message, .. } = error else {
        panic!("{error:?}");
    };
    assert!(message.contains("got •••"), "{message}");
    assert!(!message.contains("secret-code"), "{message}");
}

fn installer(fake: &Fake, body: &str) -> install::Installer {
    let script = fake.script("installer.sh", body);
    install::Installer {
        program: "/bin/sh".into(),
        args: vec![script.into_os_string()],
    }
}

#[test]
fn installer_success_reports_the_stages() {
    let fake = Fake::new();
    let installer = installer(
        &fake,
        "#!/bin/sh\necho 'Setting up Claude Code...'\necho '\u{1b}[32m✅ Installation complete!\u{1b}[0m'\n",
    );
    let (_cancel, cancelled) = oneshot::channel();
    let mut stages = Vec::new();
    let outcome = block_on(install::run(
        &installer,
        fake.path(),
        Duration::from_secs(10),
        cancelled,
        |stage| stages.push(stage),
    ));
    let install::Outcome::Installed { log } = outcome else {
        panic!("{outcome:?}");
    };
    assert!(log.contains("✅ Installation complete!"), "{log}");
    assert!(!log.contains('\u{1b}'), "colors stripped: {log}");
    assert_eq!(
        stages,
        [
            install::InstallStage::Downloading,
            install::InstallStage::Installing,
            install::InstallStage::Verifying
        ]
    );
}

#[test]
fn installer_failure_keeps_its_output() {
    let fake = Fake::new();
    let installer = installer(&fake, "#!/bin/sh\necho 'Download failed' >&2\nexit 3\n");
    let (_cancel, cancelled) = oneshot::channel();
    let outcome = block_on(install::run(
        &installer,
        fake.path(),
        Duration::from_secs(10),
        cancelled,
        |_| {},
    ));
    let install::Outcome::Failed { message } = outcome else {
        panic!("{outcome:?}");
    };
    assert!(
        message.starts_with("Установка не удалась (код 3)"),
        "{message}"
    );
    assert!(message.contains("Download failed"), "{message}");
}

#[test]
fn a_cancelled_install_is_killed() {
    let fake = Fake::new();
    let state = fake.path().display().to_string();
    let installer = installer(
        &fake,
        &format!("#!/bin/sh\necho Downloading\nsleep 300 & echo $! > '{state}/child.pid'\nwait\n"),
    );
    let (cancel, cancelled) = oneshot::channel();
    let started = Instant::now();
    let outcome = block_on(async {
        let run = install::run(
            &installer,
            fake.path(),
            Duration::from_secs(30),
            cancelled,
            |_| {},
        );
        let stop = async {
            while !fake.path().join("child.pid").exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let _ = cancel.send(());
        };
        tokio::join!(run, stop).0
    });
    assert_eq!(outcome, install::Outcome::Cancelled);
    assert!(started.elapsed() < SLOW_START * 2);
    assert_killed(fake.child_pid().unwrap());
}

#[test]
fn version_managers_are_known_places() {
    let fake = Fake::new();
    let env = fake.env();
    let older = fake.script("home/.nvm/versions/node/v9.11.2/bin/claude", "#!/bin/sh\n");
    let newer = fake.script("home/.nvm/versions/node/v20.11.1/bin/claude", "#!/bin/sh\n");
    let locations = discover::known_locations(&env);
    let position = |path: &Path| locations.iter().position(|location| location == path);
    assert!(position(&newer) < position(&older), "newest Node first");
    let home = fake.path().join("home");
    for manager in [".asdf/shims", ".volta/bin", ".bun/bin"] {
        assert!(
            locations.contains(&home.join(manager).join("claude")),
            "{manager}"
        );
    }
    // Known places outside the temp folder may exist on a dev machine.
    if ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
        .iter()
        .any(|location| discover::is_executable(Path::new(location)))
    {
        return;
    }
    assert_eq!(
        block_on(discover::find(None, &env)).as_deref(),
        Some(newer.as_path())
    );
    fs::remove_dir_all(home.join(".nvm")).unwrap();
    let bun = fake.script("home/.bun/bin/claude", "#!/bin/sh\n");
    assert_eq!(
        block_on(discover::find(None, &env)).as_deref(),
        Some(bun.as_path())
    );
}

#[test]
fn a_saved_cli_that_stopped_working_is_searched_again() {
    let fake = Fake::new();
    let broken = fake.script("old/claude", "#!/bin/sh\nexit 127\n");
    let working = fake.claude("normal");
    let home_cli = fake.path().join("home/.local/bin/claude");
    fs::create_dir_all(home_cli.parent().unwrap()).unwrap();
    fs::copy(&working, &home_cli).unwrap();
    let storage = Storage::in_memory();
    let sink = RecordingSink::default();
    let saved = SettingsMap::from([(
        settings::AGENT_PATH.to_owned(),
        json!(broken.display().to_string()),
    )]);
    block_on(storage.write(&sink, move |db| Ok(((), settings::put(db, &saved)?)))).unwrap();

    let state = block_on(locate_and_check(&storage, &sink, &fake.env(), fake.path()));
    assert_eq!(
        state,
        AgentState::NeedsLogin {
            version: "2.1.316".into()
        }
    );
    assert_eq!(agent_path(&storage), json!(home_cli.display().to_string()));
}

#[test]
fn a_login_cancelled_while_starting_is_not_kept() {
    let fake = Fake::new();
    let cli = fake.claude("linger");
    let sessions = AgentSessions::default();
    let id = sessions.begin_login();
    let session = block_on(login::start(&cli, fake.path(), id, login::URL_TIMEOUT)).unwrap();
    let child = fake.child_pid().unwrap();
    block_on(sessions.cancel_login());
    let error = block_on(sessions.keep_login(session)).unwrap_err();
    assert_eq!(error, CommandError::not_found("Вход отменён"));
    assert_killed(child);
    assert_eq!(
        block_on(sessions.take_login()).err(),
        Some(CommandError::not_found(NO_LOGIN))
    );

    // A newer "Войти" replaces a start still waiting for its link.
    let first = sessions.begin_login();
    let second = sessions.begin_login();
    fs::remove_file(fake.path().join("child.pid")).unwrap();
    let session = block_on(login::start(&cli, fake.path(), first, login::URL_TIMEOUT)).unwrap();
    assert!(block_on(sessions.keep_login(session)).is_err());
    assert_killed(fake.child_pid().unwrap());
    let session = block_on(login::start(
        &fake.claude("normal"),
        fake.path(),
        second,
        login::URL_TIMEOUT,
    ))
    .unwrap();
    block_on(sessions.keep_login(session)).unwrap();
    assert!(block_on(sessions.take_login()).is_ok());
}

#[test]
fn run_returns_at_exit_even_if_a_child_keeps_the_pipe() {
    let fake = Fake::new();
    let state = fake.path().display().to_string();
    let script = fake.script(
        "keeps-pipe",
        &format!("#!/bin/sh\nsleep 30 & echo $! > '{state}/child.pid'\necho done\n"),
    );
    let started = Instant::now();
    let output = block_on(process::run(process::command(&script), SLOW_START)).unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout.trim(), "done");
    assert!(started.elapsed() < SLOW_START, "{:?}", started.elapsed());
    let child = fake.child_pid().unwrap();
    // SAFETY: ends the fake's leftover `sleep`.
    unsafe {
        libc::kill(child, libc::SIGKILL);
    }
}
