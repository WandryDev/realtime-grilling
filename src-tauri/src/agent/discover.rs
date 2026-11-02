//! Where `claude` is (decision 7). An app started from Finder or the
//! Start menu doesn't see the shell's PATH, so after the saved path and
//! the process PATH come the installers' folders and, on macOS, a login
//! shell.

use std::{
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use super::process;

pub const BINARY: &str = "claude";
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);

/// What the search looks at; tests build their own.
#[derive(Debug, Clone, Default)]
pub struct SearchEnv {
    pub path: Option<OsString>,
    pub home: Option<PathBuf>,
    /// `%APPDATA%` (npm's global folder on Windows).
    pub app_data: Option<PathBuf>,
    /// The user's shell, asked with `-ilc 'command -v claude'` (macOS).
    pub login_shell: Option<PathBuf>,
    /// Where helper processes run.
    pub cwd: PathBuf,
}

impl SearchEnv {
    pub fn from_process() -> Self {
        let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
        Self {
            path: env::var_os("PATH"),
            home: home.map(PathBuf::from),
            app_data: env::var_os("APPDATA").map(PathBuf::from),
            login_shell: cfg!(target_os = "macos").then(|| {
                env::var_os("SHELL").map_or_else(|| PathBuf::from("/bin/zsh"), PathBuf::from)
            }),
            cwd: env::temp_dir(),
        }
    }
}

/// File names the agent CLI may have.
pub const NAMES: [&str; 3] = ["claude", "claude.exe", "claude.cmd"];

/// Whether a path names the agent CLI (and nothing else we'd run).
pub fn has_cli_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| NAMES.contains(&name))
}

/// `v20.11.1` → `[20, 11, 1]`, so `v20` sorts above `v9`.
fn node_version(name: &str) -> Vec<u64> {
    name.trim_start_matches('v')
        .split('.')
        .map(|part| part.parse().unwrap_or(0))
        .collect()
}

/// `claude` of every nvm Node, newest first.
fn nvm_locations(home: &Path) -> Vec<PathBuf> {
    let Ok(versions) = fs::read_dir(home.join(".nvm").join("versions").join("node")) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u64>, PathBuf)> = versions
        .flatten()
        .map(|version| {
            (
                node_version(&version.file_name().to_string_lossy()),
                version.path().join("bin").join(BINARY),
            )
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, path)| path).collect()
}

/// Where the official installer, npm, Homebrew and the Node version
/// managers (nvm, asdf, Volta, Bun) put it.
pub fn known_locations(env: &SearchEnv) -> Vec<PathBuf> {
    let mut locations = Vec::new();
    if cfg!(windows) {
        if let Some(home) = &env.home {
            locations.push(home.join(".local").join("bin").join("claude.exe"));
        }
        if let Some(app_data) = &env.app_data {
            locations.push(app_data.join("npm").join("claude.cmd"));
        }
    } else {
        if let Some(home) = &env.home {
            locations.push(home.join(".local").join("bin").join(BINARY));
            locations.push(home.join(".claude").join("local").join(BINARY));
        }
        locations.push(PathBuf::from("/opt/homebrew/bin/claude"));
        locations.push(PathBuf::from("/usr/local/bin/claude"));
        if let Some(home) = &env.home {
            locations.extend(nvm_locations(home));
            locations.push(home.join(".asdf").join("shims").join(BINARY));
            locations.push(home.join(".volta").join("bin").join(BINARY));
            locations.push(home.join(".bun").join("bin").join(BINARY));
        }
    }
    locations
}

/// An existing file we may run (symlinks followed).
pub fn is_executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

/// The CLI by the chain of decision 7; `saved` is the `agentPath` setting.
pub async fn find(saved: Option<&Path>, env: &SearchEnv) -> Option<PathBuf> {
    if let Some(saved) = saved.filter(|saved| has_cli_name(saved) && is_executable(saved)) {
        return Some(saved.to_owned());
    }
    if let Some(path) = &env.path
        && let Ok(found) = which::which_in(BINARY, Some(path), &env.cwd)
        && is_executable(&found)
    {
        return Some(found);
    }
    if let Some(found) = known_locations(env)
        .into_iter()
        .find(|location| is_executable(location))
    {
        return Some(found);
    }
    from_login_shell(env.login_shell.as_deref()?, &env.cwd).await
}

/// `$SHELL -ilc 'command -v claude'` (stdin closed, 3 s): an interactive
/// login shell reads `.zshrc` too, where nvm and friends set PATH.
async fn from_login_shell(shell: &Path, cwd: &Path) -> Option<PathBuf> {
    let mut command = process::command(shell);
    command.args(["-ilc", "command -v claude"]).current_dir(cwd);
    let output = process::run(command, LOGIN_SHELL_TIMEOUT).await.ok()?;
    output
        .stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| Path::new(line).is_absolute())
        .map(PathBuf::from)
        .filter(|found| has_cli_name(found) && is_executable(found))
}
