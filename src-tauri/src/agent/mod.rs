//! The local agent CLI, Claude Code (`specs/agent-setup`, design.md
//! decisions 7–10): find it, check its version and login, install it, sign
//! in. The status never calls the model. The app keeps no codes, passwords
//! or tokens: the CLI owns them.

pub mod claude_cli;
pub mod discover;
pub mod fast_loop;
pub mod halt;
pub mod install;
pub mod login;
pub mod process;
pub mod slow_loop;

use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tokio::sync::oneshot;

use crate::{
    error::{CommandError, CommandResult},
    events::EventSink,
    storage::{
        Storage,
        settings::{self, SettingsMap},
    },
};
use discover::SearchEnv;
use process::RunError;

/// Each of `--version` and `auth status` gets this long.
pub const STATUS_TIMEOUT: Duration = Duration::from_secs(10);
pub const NOT_RESPONDING: &str = "Claude Code не отвечает";
pub const NO_LOGIN: &str = "Вход не начат или истёк";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AgentState {
    NotInstalled,
    NeedsLogin {
        version: String,
    },
    Ready {
        version: String,
        /// `pro`, `max`, `team`…; `null` when the CLI doesn't say.
        #[serde(rename = "subscriptionType")]
        subscription_type: Option<String>,
    },
    /// The text for "Скопировать для поддержки".
    Error {
        message: String,
    },
}

impl AgentState {
    fn error(message: impl Into<String>) -> Self {
        Self::Error {
            message: message.into(),
        }
    }
}

/// What we read from `claude auth status --json`; other fields (email,
/// organization…) are ignored and never leave this function.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    #[serde(default)]
    pub subscription_type: Option<String>,
}

/// `2.1.316 (Claude Code)` → `2.1.316`.
pub fn parse_version(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .next()
        .filter(|version| version.starts_with(|char: char| char.is_ascii_digit()))
        .map(str::to_owned)
}

/// The JSON object in the output, ignoring lines around it.
pub fn parse_auth_status(stdout: &str) -> Option<AuthStatus> {
    let start = stdout.find('{')?;
    let end = stdout.rfind('}')?;
    serde_json::from_str(stdout.get(start..=end)?).ok()
}

fn failure(what: &str, output: &process::Output) -> String {
    let detail = [output.stderr.trim(), output.stdout.trim()]
        .into_iter()
        .find(|text| !text.is_empty())
        .map(process::strip_ansi);
    let code = output
        .status
        .code()
        .map_or_else(String::new, |code| format!(" (код {code})"));
    match detail {
        Some(detail) => format!("{what}{code}:\n{detail}"),
        None => format!("{what}{code}"),
    }
}

/// `--version`, then `auth status --json` (not logged in exits 1 with a
/// valid answer, so the JSON decides, not the exit code).
pub async fn status(cli: &Path, cwd: &Path, timeout: Duration) -> AgentState {
    let mut command = process::cli(cli, cwd);
    command.arg("--version");
    let output = match process::run(command, timeout).await {
        Ok(output) => output,
        Err(RunError::Timeout) => return AgentState::error(NOT_RESPONDING),
        Err(RunError::Spawn(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return AgentState::NotInstalled;
        }
        Err(RunError::Spawn(error)) => {
            return AgentState::error(format!("Не удалось запустить Claude Code: {error}"));
        }
    };
    let version = output
        .status
        .success()
        .then(|| parse_version(&output.stdout))
        .flatten();
    let Some(version) = version else {
        return AgentState::error(failure("Claude Code не сообщил версию", &output));
    };

    let mut command = process::cli(cli, cwd);
    command.args(["auth", "status", "--json"]);
    let output = match process::run(command, timeout).await {
        Ok(output) => output,
        Err(RunError::Timeout) => return AgentState::error(NOT_RESPONDING),
        Err(RunError::Spawn(error)) => {
            return AgentState::error(format!("Не удалось запустить Claude Code: {error}"));
        }
    };
    match parse_auth_status(&output.stdout) {
        Some(AuthStatus {
            logged_in: true,
            subscription_type,
        }) => AgentState::Ready {
            version,
            subscription_type,
        },
        Some(_) => AgentState::NeedsLogin { version },
        None => AgentState::error(failure(
            "Не удалось прочитать статус входа Claude Code",
            &output,
        )),
    }
}

/// «Указать другой» (settings-real design.md, decision 7): the status of
/// the CLI at `path`, without saving it. A path that is not a file named as
/// the CLI (`claude`, `claude.exe`, `claude.cmd`) is `notInstalled` and is
/// never run.
pub async fn check_path(path: &Path, cwd: &Path) -> AgentState {
    if !discover::has_cli_name(path) || !path.is_file() {
        return AgentState::NotInstalled;
    }
    status(path, cwd, STATUS_TIMEOUT).await
}

async fn saved_path(storage: &Storage) -> Option<PathBuf> {
    let stored = storage.read(settings::get).await.ok()?;
    stored
        .get(settings::AGENT_PATH)
        .and_then(Value::as_str)
        .map(PathBuf::from)
}

/// Writes `agentPath` (with `DataChanged`) when it changed.
async fn remember(
    storage: &Storage,
    sink: &impl EventSink,
    saved: Option<&PathBuf>,
    found: Option<&PathBuf>,
) {
    if found == saved {
        return;
    }
    let value = found.map_or(Value::Null, |path| {
        Value::String(path.to_string_lossy().into_owned())
    });
    let patch = SettingsMap::from([(settings::AGENT_PATH.to_owned(), value)]);
    let written = storage
        .write(sink, move |db| Ok(((), settings::put(db, &patch)?)))
        .await;
    if let Err(error) = written {
        eprintln!("grill: failed to save agentPath: {error}");
    }
}

/// Finds the CLI and remembers it in `agentPath`; a saved path that is
/// gone is searched again and replaced.
pub async fn locate(storage: &Storage, sink: &impl EventSink, env: &SearchEnv) -> Option<PathBuf> {
    let saved = saved_path(storage).await;
    let found = discover::find(saved.as_deref(), env).await;
    remember(storage, sink, saved.as_ref(), found.as_ref()).await;
    found
}

/// The status of the CLI wherever it is. A saved path that still exists
/// but no longer works (no version, exit 127…) is dropped and the search
/// runs again without it.
pub async fn locate_and_check(
    storage: &Storage,
    sink: &impl EventSink,
    env: &SearchEnv,
    cwd: &Path,
) -> AgentState {
    let saved = saved_path(storage).await;
    let mut found = discover::find(saved.as_deref(), env).await;
    let mut state = match &found {
        Some(cli) => status(cli, cwd, STATUS_TIMEOUT).await,
        None => AgentState::NotInstalled,
    };
    let broken = matches!(state, AgentState::Error { .. } | AgentState::NotInstalled);
    if broken && found.is_some() && found == saved {
        let again = discover::find(None, env).await;
        if again != found {
            state = match &again {
                Some(cli) => status(cli, cwd, STATUS_TIMEOUT).await,
                None => AgentState::NotInstalled,
            };
            found = again;
        }
    }
    remember(storage, sink, saved.as_ref(), found.as_ref()).await;
    state
}

/// The CLI to call when its status is `ready`; otherwise that status.
pub async fn ready_cli(
    storage: &Storage,
    sink: &impl EventSink,
    env: &SearchEnv,
    cwd: &Path,
) -> Result<PathBuf, AgentState> {
    match locate_and_check(storage, sink, env, cwd).await {
        AgentState::Ready { .. } => saved_path(storage)
            .await
            .ok_or_else(|| AgentState::error("Claude Code не найден")),
        state => Err(state),
    }
}

/// Install and login in progress. Managed as Tauri state.
#[derive(Default)]
pub struct AgentSessions {
    install: Mutex<Option<oneshot::Sender<()>>>,
    pub login: login::Slot,
    next_login: AtomicU64,
    /// The login the user is waiting for; 0 after a cancel.
    current_login: AtomicU64,
}

impl AgentSessions {
    /// A cancel handle for a new install; `Invalid` while one runs.
    pub fn begin_install(&self) -> CommandResult<oneshot::Receiver<()>> {
        let mut install = self
            .install
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if install.as_ref().is_some_and(|cancel| !cancel.is_closed()) {
            return Err(CommandError::invalid("Установка уже идёт"));
        }
        let (cancel, cancelled) = oneshot::channel();
        *install = Some(cancel);
        Ok(cancelled)
    }

    pub fn cancel_install(&self) {
        let cancel = self
            .install
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(cancel) = cancel {
            let _ = cancel.send(());
        }
    }

    /// A new login replaces any other: one that is still starting won't
    /// be kept (see [`Self::keep_login`]).
    pub fn begin_login(&self) -> u64 {
        let id = self.next_login.fetch_add(1, Ordering::SeqCst) + 1;
        self.current_login.store(id, Ordering::SeqCst);
        id
    }

    /// Keeps a started login unless it was cancelled or replaced while the
    /// CLI was starting; then the CLI is killed and the call is `NotFound`.
    pub async fn keep_login(&self, session: login::Session) -> CommandResult<()> {
        let mut slot = self.login.lock().await;
        if self.current_login.load(Ordering::SeqCst) != session.id() {
            drop(slot);
            drop(session);
            return Err(CommandError::not_found("Вход отменён"));
        }
        let replaced = slot.replace(session);
        drop(slot);
        drop(replaced);
        Ok(())
    }

    /// "Отменить": stops the login in progress or still starting.
    pub async fn cancel_login(&self) {
        self.current_login.store(0, Ordering::SeqCst);
        let session = self.login.lock().await.take();
        drop(session);
    }

    /// The login waiting for a code; `NotFound` when there is none (never
    /// started, cancelled, expired, or ended by a wrong code).
    pub async fn take_login(&self) -> CommandResult<login::Session> {
        self.login
            .lock()
            .await
            .take()
            .ok_or_else(|| CommandError::not_found(NO_LOGIN))
    }
}

/// Passes the code; a code the CLI refused, or a login that didn't take,
/// is `Invalid` ("Код не подошёл").
pub async fn finish_login(
    session: login::Session,
    code: &str,
    cli: &Path,
    cwd: &Path,
) -> CommandResult<AgentState> {
    login::submit(session, code, login::SUBMIT_TIMEOUT).await?;
    match status(cli, cwd, STATUS_TIMEOUT).await {
        AgentState::NeedsLogin { .. } => Err(CommandError::invalid(login::WRONG_CODE)),
        state => Ok(state),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version_and_auth_status() {
        assert_eq!(
            parse_version("2.1.316 (Claude Code)\n").as_deref(),
            Some("2.1.316")
        );
        assert_eq!(parse_version("error: boom"), None);
        assert_eq!(parse_version(""), None);

        let ready = parse_auth_status(
            r#"{"loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "subscriptionType": "max"}"#,
        )
        .unwrap();
        assert!(ready.logged_in);
        assert_eq!(ready.subscription_type.as_deref(), Some("max"));
        let out = parse_auth_status(
            "warning: x\n{\n  \"loggedIn\": false,\n  \"authMethod\": \"none\"\n}\n",
        )
        .unwrap();
        assert!(!out.logged_in);
        assert_eq!(out.subscription_type, None);
        assert!(parse_auth_status("Not logged in").is_none());
        assert!(parse_auth_status(r#"{"loggedIn": "yes"}"#).is_none());
    }

    #[test]
    fn agent_state_serializes_with_a_status_tag() {
        let json = |state: AgentState| serde_json::to_value(state).unwrap();
        assert_eq!(
            json(AgentState::NotInstalled),
            serde_json::json!({ "status": "notInstalled" })
        );
        assert_eq!(
            json(AgentState::NeedsLogin {
                version: "2.1.316".into()
            }),
            serde_json::json!({ "status": "needsLogin", "version": "2.1.316" })
        );
        assert_eq!(
            json(AgentState::Ready {
                version: "2.1.316".into(),
                subscription_type: Some("max".into())
            }),
            serde_json::json!({ "status": "ready", "version": "2.1.316", "subscriptionType": "max" })
        );
        assert_eq!(
            json(AgentState::error("x")),
            serde_json::json!({ "status": "error", "message": "x" })
        );
    }

    #[test]
    fn one_install_at_a_time() {
        let sessions = AgentSessions::default();
        let mut first = sessions.begin_install().unwrap();
        assert!(sessions.begin_install().is_err());
        sessions.cancel_install();
        assert!(first.try_recv().is_ok(), "cancel reached the install");
        drop(first);
        let _second = sessions.begin_install().unwrap();
    }

    #[test]
    fn a_code_without_a_login_is_not_found() {
        let sessions = AgentSessions::default();
        let error = tauri::async_runtime::block_on(sessions.take_login())
            .err()
            .unwrap();
        assert_eq!(error, CommandError::not_found(NO_LOGIN));
    }
}

/// Against fake `claude` scripts in temp folders: never the real CLI, its
/// config or the real installer.
#[cfg(all(test, unix))]
mod fake_cli_tests;
