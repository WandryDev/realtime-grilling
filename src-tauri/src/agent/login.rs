//! Signing in by subscription with the code from the browser (decision 10,
//! checked on CLI 2.1.316): `claude auth login --claudeai` opens the
//! browser, prints the authorize link and waits for the code on stdin.
//! There is no local callback, so the login ends only with a code.
//!
//! The code goes to the CLI's stdin and nowhere else: it is never logged,
//! and the CLI's output kept for support has it masked.

use std::{
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex, PoisonError},
    time::{Duration, Instant},
};

use tokio::{
    io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _},
    process::{Child, ChildStdin},
};

use super::process;
use crate::error::{CommandError, CommandResult};

/// How long the CLI may take to print the link.
pub const URL_TIMEOUT: Duration = Duration::from_secs(15);
/// How long the CLI may take to accept a code and exit.
pub const SUBMIT_TIMEOUT: Duration = Duration::from_secs(60);
/// An unfinished login is stopped after this.
pub const SESSION_TIMEOUT: Duration = Duration::from_secs(10 * 60);

pub const WRONG_CODE: &str = "Код не подошёл";
const POLL: Duration = Duration::from_millis(50);

/// The authorize link in the CLI's output: a complete `https://` URL (one
/// followed by whitespace), the OAuth one if there are several.
pub fn find_url(output: &str) -> Option<String> {
    let text = process::strip_ansi(output);
    let mut urls = Vec::new();
    let mut rest = text.as_str();
    while let Some(start) = rest.find("https://") {
        rest = &rest[start..];
        let Some(end) =
            rest.find(|char: char| char.is_whitespace() || matches!(char, '"' | '\'' | '<' | '>'))
        else {
            break;
        };
        urls.push(rest[..end].trim_end_matches(['.', ',', ')']).to_owned());
        rest = &rest[end..];
    }
    let oauth = urls
        .iter()
        .position(|url| url.contains("oauth") || url.contains("authorize"));
    oauth
        .or((!urls.is_empty()).then_some(0))
        .map(|index| urls.swap_remove(index))
}

/// A running `claude auth login`. Dropping it kills the CLI.
pub struct Session {
    id: u64,
    child: Child,
    tree: process::Tree,
    stdin: Option<ChildStdin>,
    output: Arc<Mutex<String>>,
    url: String,
    exited: bool,
}

impl Session {
    pub const fn id(&self) -> u64 {
        self.id
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    /// The CLI's stdout and stderr so far, with `secret` masked.
    fn output(&self, secret: Option<&str>) -> String {
        let output =
            process::strip_ansi(&self.output.lock().unwrap_or_else(PoisonError::into_inner));
        match secret {
            Some(secret) if !secret.is_empty() => output.replace(secret, "•••"),
            _ => output,
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Neither blocks: safe in async code and in the expiry task.
        if !self.exited {
            self.tree.kill();
            let _ = self.child.start_kill();
        }
    }
}

fn collect(stream: Option<impl AsyncRead + Unpin + Send + 'static>, output: Arc<Mutex<String>>) {
    let Some(mut stream) = stream else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let mut buffer = [0u8; 4096];
        while let Ok(read) = stream.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            output
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push_str(&String::from_utf8_lossy(&buffer[..read]));
        }
    });
}

fn with_output(summary: &str, output: &str) -> String {
    let output = output.trim();
    if output.is_empty() {
        summary.to_owned()
    } else {
        format!("{summary}\n\n{output}")
    }
}

/// Starts the login and waits for the link (the CLI opens the browser
/// itself). `External` with the CLI's output if no link comes.
pub async fn start(
    cli: &Path,
    cwd: &Path,
    id: u64,
    url_timeout: Duration,
) -> CommandResult<Session> {
    let mut command = process::cli(cli, cwd);
    command
        .args(["auth", "login", "--claudeai"])
        .stdin(Stdio::piped());
    let (mut child, tree) = process::spawn(&mut command).map_err(|error| {
        CommandError::external(format!("Не удалось запустить Claude Code: {error}"))
    })?;
    let output = Arc::new(Mutex::new(String::new()));
    collect(child.stdout.take(), Arc::clone(&output));
    collect(child.stderr.take(), Arc::clone(&output));
    let mut session = Session {
        id,
        tree,
        stdin: child.stdin.take(),
        child,
        output,
        url: String::new(),
        exited: false,
    };
    let deadline = Instant::now() + url_timeout;
    loop {
        if let Some(url) = find_url(&session.output(None)) {
            session.url = url;
            return Ok(session);
        }
        if let Ok(Some(status)) = session.child.try_wait() {
            session.exited = true;
            let summary = status.code().map_or_else(
                || "Claude Code прервал вход".to_owned(),
                |code| format!("Claude Code завершился, не начав вход (код {code})"),
            );
            return Err(CommandError::external(with_output(
                &summary,
                &session.output(None),
            )));
        }
        if Instant::now() >= deadline {
            return Err(CommandError::external(with_output(
                "Claude Code не показал ссылку для входа",
                &session.output(None),
            )));
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Passes the code and waits for the CLI to exit: 0 is a login, anything
/// else a code it didn't accept (`Invalid`). The session ends either way.
pub async fn submit(mut session: Session, code: &str, timeout: Duration) -> CommandResult<()> {
    let Some(mut stdin) = session.stdin.take() else {
        return Err(CommandError::external("Claude Code не принимает код"));
    };
    let written = async {
        stdin.write_all(code.as_bytes()).await?;
        stdin.write_all(b"\n").await?;
        stdin.flush().await
    }
    .await;
    // EOF after the code: a CLI that asks again exits instead of waiting.
    drop(stdin);
    if let Err(error) = written {
        return Err(CommandError::external(with_output(
            &format!("Не удалось передать код Claude Code: {error}"),
            &session.output(Some(code)),
        )));
    }
    match tokio::time::timeout(timeout, session.child.wait()).await {
        Ok(Ok(status)) => {
            session.exited = true;
            if status.success() {
                Ok(())
            } else {
                Err(CommandError::invalid(WRONG_CODE))
            }
        }
        Ok(Err(error)) => Err(CommandError::external(format!(
            "Claude Code не ответил на код: {error}"
        ))),
        Err(_) => Err(CommandError::external(with_output(
            "Claude Code не ответил на код за минуту",
            &session.output(Some(code)),
        ))),
    }
}

/// The login in progress, if any; shared with its timeout task.
pub type Slot = Arc<tokio::sync::Mutex<Option<Session>>>;

/// Stops the session `id` after `after` if it's still waiting for a code.
pub fn expire_later(slot: &Slot, id: u64, after: Duration) {
    let slot = Arc::clone(slot);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(after).await;
        let mut session = slot.lock().await;
        if session.as_ref().is_some_and(|session| session.id() == id) {
            session.take();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::find_url;

    #[test]
    fn finds_the_authorize_link() {
        let output = "Opening browser to sign in…\nIf the browser didn't open, visit: \
                      https://claude.ai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback\n\
                      Paste code here if prompted > ";
        assert_eq!(
            find_url(output).as_deref(),
            Some(
                "https://claude.ai/oauth/authorize?code=true&client_id=x&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
            )
        );
    }

    #[test]
    fn prefers_the_oauth_link_and_waits_for_a_complete_one() {
        let output = "See https://docs.claude.com.\nhttps://claude.ai/oauth/authorize?x=1\n";
        assert_eq!(
            find_url(output).as_deref(),
            Some("https://claude.ai/oauth/authorize?x=1")
        );
        assert_eq!(find_url("https://claude.ai/oauth/auth"), None, "may be cut");
        assert_eq!(find_url("no link"), None);
        assert_eq!(
            find_url("go to https://example.com/login now").as_deref(),
            Some("https://example.com/login")
        );
    }
}
