//! Installing Claude Code with the official installer (decision 9). The
//! URLs are fixed here: the frontend can't pass its own script. Progress
//! is by stage, read from the installer's output; it prints no percentage.

use std::{ffi::OsString, path::Path, process::ExitStatus, time::Duration};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncRead, BufReader},
    sync::{mpsc, oneshot},
};

use super::process;

pub const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InstallStage {
    Downloading,
    Installing,
    /// The installer finished; the app checks the CLI.
    Verifying,
}

impl InstallStage {
    /// A nominal share of the work done when the stage starts.
    pub const fn progress(self) -> f32 {
        match self {
            Self::Downloading => 0.1,
            Self::Installing => 0.6,
            Self::Verifying => 0.9,
        }
    }
}

/// Sent to the window that started `agent_install`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallProgress {
    pub stage: InstallStage,
    /// 0–1, by stage.
    // Always finite, so a plain `number` rather than specta's `number | null`.
    #[specta(type = u32)]
    pub progress: f32,
}

impl From<InstallStage> for AgentInstallProgress {
    fn from(stage: InstallStage) -> Self {
        Self {
            stage,
            progress: stage.progress(),
        }
    }
}

/// The program that installs the CLI.
#[derive(Debug, Clone)]
pub struct Installer {
    pub program: OsString,
    pub args: Vec<OsString>,
}

impl Installer {
    /// `install.sh` (macOS) or `install.ps1` (Windows) from claude.ai.
    pub fn official() -> Self {
        if cfg!(windows) {
            let system_root =
                std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            Self {
                program: std::path::PathBuf::from(system_root)
                    .join("System32")
                    .join("WindowsPowerShell")
                    .join("v1.0")
                    .join("powershell.exe")
                    .into_os_string(),
                args: vec![
                    "-NoProfile".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-Command".into(),
                    "irm https://claude.ai/install.ps1 | iex".into(),
                ],
            }
        } else {
            Self {
                program: "/bin/bash".into(),
                args: vec![
                    "-c".into(),
                    // Without pipefail a failed download is a bash that ran
                    // an empty script and exited 0.
                    "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash".into(),
                ],
            }
        }
    }
}

/// The stage a line of the installer's output starts, if any.
pub fn stage_of(line: &str) -> Option<InstallStage> {
    let line = line.to_lowercase();
    if line.contains("installation complete") || line.contains("verif") {
        Some(InstallStage::Verifying)
    } else if line.contains("setting up") || line.contains("installing") {
        Some(InstallStage::Installing)
    } else if line.contains("download") {
        Some(InstallStage::Downloading)
    } else {
        None
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Exit code 0; the CLI still has to be found and checked.
    Installed {
        log: String,
    },
    /// The text for the screen and "Скопировать для поддержки": a summary
    /// line, then the installer's output.
    Failed {
        message: String,
    },
    Cancelled,
}

fn with_log(summary: &str, log: &[String]) -> String {
    if log.is_empty() {
        summary.to_owned()
    } else {
        format!("{summary}\n\n{}", log.join("\n"))
    }
}

fn read_lines(
    stream: Option<impl AsyncRead + Unpin + Send + 'static>,
    lines: mpsc::UnboundedSender<String>,
) -> Option<tauri::async_runtime::JoinHandle<()>> {
    let stream = stream?;
    Some(tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stream).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            if lines.send(process::strip_ansi(&line)).is_err() {
                break;
            }
        }
    }))
}

/// Runs the installer until it exits, `cancel` fires (or its sender is
/// dropped) or `timeout` passes; the last two kill it.
pub async fn run(
    installer: &Installer,
    cwd: &Path,
    timeout: Duration,
    mut cancel: oneshot::Receiver<()>,
    mut progress: impl FnMut(InstallStage),
) -> Outcome {
    let mut command = process::command(&installer.program);
    command.args(&installer.args).current_dir(cwd);
    let (mut child, tree) = match process::spawn(&mut command) {
        Ok(spawned) => spawned,
        Err(error) => {
            return Outcome::Failed {
                message: format!("Не удалось запустить установщик: {error}"),
            };
        }
    };
    let (sender, mut lines) = mpsc::unbounded_channel();
    let readers: Vec<_> = [
        read_lines(child.stdout.take(), sender.clone()),
        read_lines(child.stderr.take(), sender),
    ]
    .into_iter()
    .flatten()
    .collect();

    let mut stage = InstallStage::Downloading;
    progress(stage);
    let mut log = Vec::new();
    let mut take_line = |line: String, log: &mut Vec<String>| {
        if let Some(next) = stage_of(&line)
            && next > stage
        {
            stage = next;
            progress(next);
        }
        log.push(line);
    };

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let status: std::io::Result<ExitStatus> = loop {
        tokio::select! {
            Some(line) = lines.recv() => take_line(line, &mut log),
            status = child.wait() => break status,
            _ = &mut cancel => {
                tree.kill();
                let _ = child.kill().await;
                return Outcome::Cancelled;
            }
            () = &mut deadline => {
                tree.kill();
                let _ = child.kill().await;
                return Outcome::Failed {
                    message: with_log("Установка не завершилась за 10 минут", &log),
                };
            }
        }
    };
    for mut reader in readers {
        // A child the installer left behind may keep the pipe open.
        if tokio::time::timeout(process::OUTPUT_TAIL, &mut reader)
            .await
            .is_err()
        {
            reader.abort();
        }
    }
    while let Ok(line) = lines.try_recv() {
        take_line(line, &mut log);
    }
    match status {
        Ok(status) if status.success() => Outcome::Installed {
            log: log.join("\n"),
        },
        Ok(status) => Outcome::Failed {
            message: with_log(
                &status.code().map_or_else(
                    || "Установка прервана".to_owned(),
                    |code| format!("Установка не удалась (код {code})"),
                ),
                &log,
            ),
        },
        Err(error) => Outcome::Failed {
            message: with_log(&format!("Установщик не ответил: {error}"), &log),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_from_the_official_installer_output() {
        assert_eq!(
            stage_of("Setting up Claude Code..."),
            Some(InstallStage::Installing)
        );
        assert_eq!(
            stage_of("✅ Installation complete!"),
            Some(InstallStage::Verifying)
        );
        assert_eq!(
            stage_of("Downloading 2.1.316"),
            Some(InstallStage::Downloading)
        );
        assert_eq!(stage_of(""), None);
        assert!(InstallStage::Downloading < InstallStage::Installing);
        assert!(InstallStage::Installing < InstallStage::Verifying);
    }

    #[test]
    fn the_official_installer_is_fixed() {
        let installer = Installer::official();
        let script = installer
            .args
            .last()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(script.contains("https://claude.ai/install."), "{script}");
    }
}
