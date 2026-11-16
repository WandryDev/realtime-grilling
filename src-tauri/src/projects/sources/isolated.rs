//! PDF and DOCX are read in a child process (projects-people-brief
//! design.md, decision 2 and risks): the app binary itself in a hidden mode,
//! `--extract-text <path> <ext>`, which `main.rs` checks before Tauri
//! starts. A crafted file that inflates to gigabytes or sends a parser into
//! a loop ends that process, not the app: at its memory limit
//! ([`MEMORY_LIMIT_BYTES`]: `RLIMIT_AS` on Unix, a watchdog of the resident
//! size on macOS, which does not enforce `RLIMIT_AS`, a Job Object on
//! Windows), or at [`EXTRACT_TIMEOUT`], when the app kills its process
//! tree. The document is then `failed`.
//!
//! The child prints one line of JSON, [`Reply`], last on stdout (a parser
//! may print before it); the app reads at most [`MAX_OUTPUT_BYTES`].

use std::{
    ffi::OsString,
    io::{self, Read as _, Write as _},
    path::Path,
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt as _, process::Command};

use super::{
    MAX_FILE_BYTES,
    extract::{EXTRACT_TIMEOUT, Extraction, FileKind, extract as extract_here, too_slow},
};
use crate::{agent::process, storage::sources::SourceStatus};

/// The argument that makes the app binary read one document and exit.
pub const FLAG: &str = "--extract-text";
/// Memory the reading process may take.
pub const MEMORY_LIMIT_BYTES: u64 = 1024 * 1024 * 1024;
/// What the app reads of the child's output: the text at its cap as JSON
/// (up to 4 bytes a character, escapes), with room for a parser's noise.
#[cfg_attr(
    all(test, not(unix)),
    allow(dead_code, reason = "the app's path; its tests run a shell script")
)]
pub const MAX_OUTPUT_BYTES: u64 = 8 * 1024 * 1024;
/// The child's exit code when the arguments are wrong.
const EXIT_USAGE: i32 = 2;
/// The child's exit code when its watchdog saw it over the memory limit.
#[cfg(target_os = "macos")]
const EXIT_OUT_OF_MEMORY: i32 = 3;

#[cfg_attr(
    all(test, not(unix)),
    allow(dead_code, reason = "the app's path; its tests run a shell script")
)]
const BROKEN: &str = "Не удалось прочитать файл: он повреждён или слишком сложный";

/// What the child prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reply {
    pub status: SourceStatus,
    pub text: String,
    pub truncated: bool,
    pub error: Option<String>,
}

impl From<Extraction> for Reply {
    fn from(extraction: Extraction) -> Self {
        Self {
            status: extraction.status,
            text: extraction.text,
            truncated: extraction.truncated,
            error: extraction.error,
        }
    }
}

impl From<Reply> for Extraction {
    fn from(reply: Reply) -> Self {
        let text_chars = u32::try_from(reply.text.chars().count()).unwrap_or(u32::MAX);
        Self {
            status: reply.status,
            text: reply.text,
            text_chars,
            truncated: reply.truncated,
            error: reply.error,
        }
    }
}

/* The child */

/// The exit code when the process was started as the reader
/// (`--extract-text <path> <ext>`), after it printed its [`Reply`]; `None`
/// for a normal start.
pub fn child_main() -> Option<i32> {
    let mut args = std::env::args_os().skip(1);
    if args.next()? != FLAG {
        return None;
    }
    Some(child(args.next(), args.next()))
}

fn child(path: Option<OsString>, extension: Option<OsString>) -> i32 {
    let kind = extension
        .as_deref()
        .and_then(|extension| extension.to_str())
        .and_then(FileKind::from_extension);
    let (Some(path), Some(kind)) = (path, kind) else {
        eprintln!("usage: {FLAG} <path> <md|txt|pdf|docx>");
        return EXIT_USAGE;
    };
    limit_memory();
    let extraction = match read_document(Path::new(&path)) {
        Ok(bytes) => extract_here(kind, &bytes),
        Err(error) => Extraction::failed(format!("Не удалось прочитать файл: {error}")),
    };
    let Ok(line) = serde_json::to_string(&Reply::from(extraction)) else {
        return 1;
    };
    let mut out = io::stdout().lock();
    // On a line of its own, whatever a parser printed before.
    match writeln!(out, "\n{line}").and_then(|()| out.flush()) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// The copy's bytes, at most [`MAX_FILE_BYTES`].
fn read_document(path: &Path) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::other("файл больше 20 МБ"));
    }
    Ok(bytes)
}

/// Caps this process at [`MEMORY_LIMIT_BYTES`]: past it an allocation
/// fails and the process aborts, which the app reads as `failed`.
#[cfg(unix)]
fn limit_memory() {
    let bytes = libc::rlim_t::try_from(MEMORY_LIMIT_BYTES).unwrap_or(libc::RLIM_INFINITY);
    let limit = libc::rlimit {
        rlim_cur: bytes,
        rlim_max: bytes,
    };
    // SAFETY: a valid `rlimit` for this process; nothing else is touched.
    // macOS refuses it (it does not enforce `RLIMIT_AS`): the watchdog
    // below stands in.
    let _ = unsafe { libc::setrlimit(libc::RLIMIT_AS, &raw const limit) };
    #[cfg(target_os = "macos")]
    watch_memory();
}

/// Ends the process once its resident size has passed
/// [`MEMORY_LIMIT_BYTES`] (macOS reports `ru_maxrss` in bytes).
#[cfg(target_os = "macos")]
fn watch_memory() {
    std::thread::spawn(|| {
        loop {
            // SAFETY: `rusage` is plain data, filled in by `getrusage`.
            let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
            // SAFETY: a valid pointer to a `rusage` of this thread's stack.
            let read = unsafe { libc::getrusage(libc::RUSAGE_SELF, &raw mut usage) } == 0;
            if read && u64::try_from(usage.ru_maxrss).unwrap_or(0) > MEMORY_LIMIT_BYTES {
                std::process::exit(EXIT_OUT_OF_MEMORY);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    });
}

/// Puts this process into a Job Object of its own that caps its memory
/// (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`): past it an allocation fails. The
/// job's handle stays open until the process ends.
#[cfg(windows)]
fn limit_memory() {
    use windows::{
        Win32::System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::GetCurrentProcess,
        },
        core::PCWSTR,
    };

    // SAFETY: a fresh job configured here and assigned this process; its
    // handle is never closed (it lives as long as the process).
    unsafe {
        let Ok(job) = CreateJobObjectW(None, PCWSTR::null()) else {
            return;
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
        limits.ProcessMemoryLimit = usize::try_from(MEMORY_LIMIT_BYTES).unwrap_or(usize::MAX);
        let set = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>()).unwrap_or(0),
        );
        if set.is_ok() {
            let _ = AssignProcessToJobObject(job, GetCurrentProcess());
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn limit_memory() {}

/* The app */

/// Reads the document at `path` in a child process: this app's binary in
/// the [`FLAG`] mode. In unit tests the test binary has no such mode, so
/// the document is read here; `tests/extract_child.rs` runs the real one.
pub async fn extract(kind: FileKind, path: &Path) -> Extraction {
    #[cfg(not(test))]
    {
        match std::env::current_exe() {
            Ok(program) => run(command(&program, kind, path), EXTRACT_TIMEOUT).await,
            Err(error) => Extraction::failed(format!("Не удалось прочитать файл: {error}")),
        }
    }
    #[cfg(test)]
    {
        let path = path.to_owned();
        super::extract::run_limited(EXTRACT_TIMEOUT, move || match read_document(&path) {
            Ok(bytes) => extract_here(kind, &bytes),
            Err(error) => Extraction::failed(format!("Не удалось прочитать файл: {error}")),
        })
        .await
    }
}

/// `program --extract-text <path> <ext>`, without a window, in a process
/// group (Unix) or a Job Object (Windows) of its own so a kill ends it all.
#[cfg_attr(
    all(test, not(unix)),
    allow(dead_code, reason = "the app's path; its tests run a shell script")
)]
pub fn command(program: &Path, kind: FileKind, path: &Path) -> Command {
    let mut command = process::command(program);
    command
        .arg(FLAG)
        .arg(path)
        .arg(kind.extension())
        .stderr(Stdio::null());
    command
}

/// Runs the reader `command` for at most `limit` and reads its [`Reply`]:
/// `failed` when it is killed for taking longer, prints more than
/// [`MAX_OUTPUT_BYTES`], dies (its memory limit) or prints no reply.
#[cfg_attr(
    all(test, not(unix)),
    allow(dead_code, reason = "the app's path; its tests run a shell script")
)]
pub async fn run(mut command: Command, limit: Duration) -> Extraction {
    let (mut child, tree) = match process::spawn(&mut command) {
        Ok(spawned) => spawned,
        Err(error) => {
            return Extraction::failed(format!("Не удалось запустить чтение файла: {error}"));
        }
    };
    let stdout = child.stdout.take();
    let finished = tokio::time::timeout(limit, async {
        let mut output = Vec::new();
        if let Some(stdout) = stdout {
            stdout
                .take(MAX_OUTPUT_BYTES + 1)
                .read_to_end(&mut output)
                .await?;
        }
        if output.len() as u64 > MAX_OUTPUT_BYTES {
            return Ok((output, None));
        }
        child.wait().await.map(|status| (output, Some(status)))
    })
    .await;
    let outcome = match finished {
        Err(_) => Err(too_slow(limit)),
        Ok(Err(error)) => Err(Extraction::failed(format!(
            "Не удалось прочитать файл: {error}"
        ))),
        Ok(Ok((_, None))) => Err(Extraction::failed(
            "Не удалось прочитать файл: слишком много текста",
        )),
        Ok(Ok((output, Some(status)))) => Ok((output, status)),
    };
    let (output, status) = match outcome {
        Ok(done) => done,
        Err(extraction) => {
            // The tree first: the child is still alive to find it by.
            tree.kill();
            let _ = child.kill().await;
            return extraction;
        }
    };
    if !status.success() {
        // Its memory limit (an abort, a signal, the watchdog's code) or a
        // crash of a parser.
        return Extraction::failed(if status.code() == Some(EXIT_USAGE) {
            format!("Не удалось прочитать файл: {status}")
        } else {
            BROKEN.to_owned()
        });
    }
    let output = String::from_utf8_lossy(&output);
    let reply = output
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .and_then(|line| serde_json::from_str::<Reply>(line).ok());
    reply.map_or_else(
        || Extraction::failed("Не удалось прочитать файл: читатель не ответил"),
        Extraction::from,
    )
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Instant;

    use super::*;

    fn shell(script: &str) -> Command {
        let mut command = process::command("/bin/sh");
        command.arg("-c").arg(script).stderr(Stdio::null());
        command
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn the_reply_is_the_last_line_whatever_came_before() {
        let reply = serde_json::to_string(&Reply {
            status: SourceStatus::Ready,
            text: "Медэлемент\nвторая строка".to_owned(),
            truncated: true,
            error: None,
        })
        .unwrap();
        let script = format!("echo 'parser noise'; printf '%s\\n\\n' '{reply}'");
        let extraction = block_on(run(shell(&script), Duration::from_secs(10)));
        assert_eq!(extraction.status, SourceStatus::Ready, "{extraction:?}");
        assert_eq!(extraction.text, "Медэлемент\nвторая строка");
        assert_eq!(extraction.text_chars, 24);
        assert!(extraction.truncated);
    }

    #[test]
    fn the_reader_gets_the_flag_the_path_and_the_extension() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("reader");
        std::fs::write(
            &program,
            "#!/bin/sh\nprintf '{\"status\":\"ready\",\"text\":\"%s|%s|%s\",\"truncated\":false,\
             \"error\":null}\\n' \"$1\" \"$2\" \"$3\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let document = dir.path().join("ТЗ клиента.docx");
        let extraction = block_on(run(
            command(&program, FileKind::Docx, &document),
            Duration::from_secs(10),
        ));
        assert_eq!(
            extraction.text,
            format!("{FLAG}|{}|docx", document.display()),
            "{extraction:?}"
        );
    }

    #[test]
    fn a_hanging_reader_is_killed_at_the_limit() {
        let started = Instant::now();
        let extraction = block_on(run(shell("sleep 30"), Duration::from_millis(300)));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(extraction.status, SourceStatus::Failed);
        assert!(extraction.error.unwrap().contains("дольше"));
    }

    #[test]
    fn a_reader_that_prints_too_much_is_stopped() {
        let started = Instant::now();
        let extraction = block_on(run(shell("yes 'aaaaaaaa'"), Duration::from_secs(20)));
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(extraction.status, SourceStatus::Failed);
        assert!(extraction.error.unwrap().contains("слишком много"));
    }

    #[test]
    fn a_dying_or_silent_reader_fails() {
        // Killed by a signal (an allocation past the limit aborts).
        let killed = block_on(run(shell("kill -9 $$"), Duration::from_secs(10)));
        assert_eq!(killed.error.as_deref(), Some(BROKEN));
        // The watchdog's exit code.
        let watchdog = block_on(run(shell("exit 3"), Duration::from_secs(10)));
        assert_eq!(watchdog.error.as_deref(), Some(BROKEN));
        let silent = block_on(run(shell("echo not json"), Duration::from_secs(10)));
        assert_eq!(silent.status, SourceStatus::Failed);
        assert!(silent.error.unwrap().contains("не ответил"));
        let missing = block_on(run(
            process::command("/nonexistent/reader"),
            Duration::from_secs(10),
        ));
        assert!(missing.error.unwrap().contains("запустить"));
    }
}
