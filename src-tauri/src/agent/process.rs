//! Child processes of the agent: the CLI, its installer, a login shell.
//! Each runs without a console window and with everything it starts in
//! one group (a process group on Unix, a Job Object on Windows), so a
//! timeout or a cancel kills the whole tree.

use std::{
    ffi::OsStr,
    io,
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use tokio::{
    io::{AsyncRead, AsyncReadExt as _},
    process::{Child, Command},
};

/// How long output may still come after a process exited (a child it
/// left behind may hold the pipes open).
pub const OUTPUT_TAIL: Duration = Duration::from_millis(500);

/// `CREATE_NO_WINDOW`: a GUI app's children would flash a console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// The agent CLI, run from `cwd` (the app's data folder, never a user's
/// project) with its own folder first on PATH: an npm install needs `node`
/// next to it, and a GUI app's PATH is short.
pub fn cli(cli: &Path, cwd: &Path) -> Command {
    let mut command = command(cli);
    command.current_dir(cwd);
    if let Some(folder) = cli.parent() {
        let mut paths = vec![folder.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&path));
        }
        if let Ok(path) = std::env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    command
}

/// A child and what it started. `kill` ends them all without blocking. On
/// Windows dropping it also ends whatever is still running (the job is
/// closed with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`).
pub struct Tree {
    #[cfg(unix)]
    group: Option<libc::pid_t>,
    #[cfg(windows)]
    job: Option<job::Job>,
}

impl Tree {
    #[cfg(unix)]
    fn of(child: &Child) -> Self {
        Self {
            group: child.id().and_then(|pid| libc::pid_t::try_from(pid).ok()),
        }
    }

    #[cfg(windows)]
    fn of(child: &Child) -> Self {
        Self {
            job: child.raw_handle().and_then(|process| {
                job::Job::with_process(process)
                    .map_err(|error| eprintln!("grill: no job object for a child: {error}"))
                    .ok()
            }),
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn of(_child: &Child) -> Self {
        Self {}
    }

    pub fn kill(&self) {
        #[cfg(unix)]
        if let Some(group) = self.group {
            // SAFETY: the child leads its own process group (`process_group(0)`).
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
        }
    }
}

/// Where the [`Tree`] of a running call can be reached from outside its
/// task, so the app's exit kills it at once: after `process::exit` no task
/// runs and no destructor (`kill_on_drop`) fires, and the CLI, in its own
/// process group, gets no signal when the app dies. Cheap to clone; all
/// clones are the same slot.
#[derive(Clone, Default)]
pub struct TreeSlot(Arc<Mutex<SlotState>>);

#[derive(Default)]
struct SlotState {
    tree: Option<Arc<Tree>>,
    killed: bool,
}

impl TreeSlot {
    fn state(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Keeps `tree` reachable until the guard is dropped (the process has
    /// ended). A slot killed already kills it at once.
    pub fn hold(&self, tree: Arc<Tree>) -> HeldTree<'_> {
        let mut state = self.state();
        if state.killed {
            tree.kill();
        }
        state.tree = Some(tree);
        HeldTree(self)
    }

    /// Kills the tree held now, and any tree held later. Doesn't block.
    pub fn kill(&self) {
        let mut state = self.state();
        state.killed = true;
        if let Some(tree) = &state.tree {
            tree.kill();
        }
    }
}

impl std::fmt::Debug for TreeSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let state = self.state();
        f.debug_struct("TreeSlot")
            .field("held", &state.tree.is_some())
            .field("killed", &state.killed)
            .finish()
    }
}

/// Clones are equal: the same slot.
impl PartialEq for TreeSlot {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for TreeSlot {}

/// [`TreeSlot::hold`] until dropped.
pub struct HeldTree<'a>(&'a TreeSlot);

impl Drop for HeldTree<'_> {
    fn drop(&mut self) {
        self.0.state().tree = None;
    }
}

/// Spawns a command from [`command`] with its [`Tree`].
pub fn spawn(command: &mut Command) -> io::Result<(Child, Tree)> {
    let child = command.spawn()?;
    let tree = Tree::of(&child);
    Ok((child, tree))
}

#[cfg(windows)]
mod job {
    use std::os::windows::io::RawHandle;

    use windows::{
        Win32::{
            Foundation::{CloseHandle, HANDLE},
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject, TerminateJobObject,
            },
        },
        core::PCWSTR,
    };

    /// A Job Object that kills its processes when closed.
    pub struct Job(isize);

    impl Job {
        pub fn with_process(process: RawHandle) -> windows::core::Result<Self> {
            // SAFETY: a fresh job, configured and closed by this type; the
            // process handle belongs to a live child.
            unsafe {
                let job = Self(CreateJobObjectW(None, PCWSTR::null())?.0 as isize);
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job.handle(),
                    JobObjectExtendedLimitInformation,
                    (&raw const limits).cast(),
                    u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(0),
                )?;
                AssignProcessToJobObject(job.handle(), HANDLE(process))?;
                Ok(job)
            }
        }

        fn handle(&self) -> HANDLE {
            HANDLE(self.0 as _)
        }

        pub fn terminate(&self) {
            // SAFETY: a valid job handle; ends every process in it.
            let _ = unsafe { TerminateJobObject(self.handle(), 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: owned here and closed once.
            let _ = unsafe { CloseHandle(self.handle()) };
        }
    }
}

/// A pipe read in the background into a buffer.
pub struct Collected {
    buffer: Arc<Mutex<Vec<u8>>>,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
}

impl Collected {
    pub fn start(stream: Option<impl AsyncRead + Unpin + Send + 'static>) -> Self {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let task = stream.map(|mut stream| {
            let buffer = Arc::clone(&buffer);
            tauri::async_runtime::spawn(async move {
                let mut chunk = [0u8; 4096];
                while let Ok(read) = stream.read(&mut chunk).await {
                    if read == 0 {
                        break;
                    }
                    buffer
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .extend_from_slice(&chunk[..read]);
                }
            })
        });
        Self { buffer, task }
    }

    /// What came, waiting at most `tail` for the end of the pipe.
    pub async fn finish(mut self, tail: Duration) -> String {
        if let Some(task) = self.task.as_mut() {
            let _ = tokio::time::timeout(tail, task).await;
        }
        let bytes = self.buffer.lock().unwrap_or_else(PoisonError::into_inner);
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

impl Drop for Collected {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

#[derive(Debug)]
pub struct Output {
    pub status: ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug)]
pub enum RunError {
    Spawn(io::Error),
    Timeout,
}

/// Runs until the process exits (not until its pipes close) or kills its
/// tree after `timeout`.
pub async fn run(mut command: Command, timeout: Duration) -> Result<Output, RunError> {
    let (mut child, tree) = spawn(&mut command).map_err(RunError::Spawn)?;
    let stdout = Collected::start(child.stdout.take());
    let stderr = Collected::start(child.stderr.take());
    let status = tokio::select! {
        status = child.wait() => status.map_err(RunError::Spawn)?,
        () = tokio::time::sleep(timeout) => {
            // The tree first: the child is still alive to find it by.
            tree.kill();
            let _ = child.kill().await;
            return Err(RunError::Timeout);
        }
    };
    Ok(Output {
        status,
        stdout: stdout.finish(OUTPUT_TAIL).await,
        stderr: stderr.finish(OUTPUT_TAIL).await,
    })
}

/// Drops terminal colors and links (`ESC [ … letter`, `ESC ] … BEL/ST`).
pub fn strip_ansi(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(char) = chars.next() {
        if char != '\u{1b}' {
            plain.push(char);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() || next == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    plain
}

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn strips_colors_and_links() {
        assert_eq!(strip_ansi("\u{1b}[31mошибка\u{1b}[0m"), "ошибка");
        assert_eq!(
            strip_ansi("\u{1b}]8;;https://a.b\u{1b}\\link\u{1b}]8;;\u{1b}\\ ok"),
            "link ok"
        );
        assert_eq!(strip_ansi("plain"), "plain");
    }
}
