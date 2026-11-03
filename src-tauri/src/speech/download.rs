//! Downloading a model (design.md, decision 2): a `reqwest` stream into
//! `<file>.part` with the SHA-256 computed on the fly, resumed with
//! `Range: bytes=<part>-`, checked and renamed at 100 %.
//!
//! The URL, size and sum come in a [`Source`] and the free space from
//! [`Config::free_space`], so tests run it against a local server.

use std::{
    io::{self, Read as _},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use reqwest::{StatusCode, header};
use sha2::{Digest as _, Sha256};
use tokio::{
    io::AsyncWriteExt as _,
    sync::{Notify, watch},
};

use super::models::{ErrorReason, ModelState, percent};

/// Where a model downloads from and what it must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
    pub url: String,
    pub size: u64,
    /// Lowercase hex.
    pub sha256: String,
}

/// Free bytes on the disk of a folder.
pub type FreeSpace = Arc<dyn Fn(&Path) -> io::Result<u64> + Send + Sync>;

#[derive(Clone)]
pub struct Config {
    pub client: reqwest::Client,
    /// Waits before the automatic retries after a broken connection; the
    /// last one repeats. Starts over once bytes arrive again.
    pub retry_delays: Vec<Duration>,
    /// Progress goes to the windows at most this often.
    pub progress_interval: Duration,
    pub free_space: FreeSpace,
}

/// A connection that stalls this long is broken.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How often the speed is measured.
const SPEED_WINDOW: Duration = Duration::from_millis(500);
/// Starts over in a row (a range the server got wrong) before giving up.
const MAX_RESTARTS: u32 = 2;

impl Config {
    /// Retries after 10 s, 20 s, then every 30 s; progress 4 times a second;
    /// the real disk.
    pub fn official() -> Self {
        let client = reqwest::Client::builder()
            .user_agent(concat!("Grill/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .build()
            .unwrap_or_else(|error| {
                eprintln!("grill: failed to build the download client: {error}");
                reqwest::Client::new()
            });
        Self {
            client,
            retry_delays: vec![
                Duration::from_secs(10),
                Duration::from_secs(20),
                Duration::from_secs(30),
            ],
            progress_interval: Duration::from_millis(250),
            free_space: Arc::new(disk_free_space),
        }
    }

    fn retry_delay(&self, failures: usize) -> Duration {
        self.retry_delays
            .get(failures)
            .or(self.retry_delays.last())
            .copied()
            .unwrap_or(Duration::from_secs(30))
    }
}

/// What the manager asks of a running download.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Run,
    /// Stop, keep the `.part`.
    Pause,
    /// Stop, delete the `.part`.
    Cancel,
}

/// `<file>.part`.
pub fn part_path(file: &Path) -> PathBuf {
    let mut name = file.as_os_str().to_owned();
    name.push(".part");
    PathBuf::from(name)
}

/// Downloads `source` to `file` until it is ready, fails, is paused or
/// cancelled, or the disk is too full; returns that state. Intermediate
/// states (`downloading`, `noNetwork`, `checking`) go to `report`. `retry`
/// ends the wait after a broken connection ("Повторить сейчас").
pub async fn run(
    source: &Source,
    file: &Path,
    config: &Config,
    mut control: watch::Receiver<Control>,
    retry: &Notify,
    mut report: impl FnMut(ModelState),
) -> ModelState {
    let part = part_path(file);
    let mut failures = 0;
    let mut restarts = 0;
    loop {
        match attempt(source, file, &part, config, &mut control, &mut report).await {
            Attempt::Finished(state) => return state,
            Attempt::Stopped(stop) => return stopped_state(stop, &part, source.size),
            Attempt::Again if restarts < MAX_RESTARTS => restarts += 1,
            Attempt::Again => {
                return ModelState::error(
                    ErrorReason::Http,
                    "Сервер отдаёт не тот файл, который запрошен",
                );
            }
            Attempt::Network { progressed, error } => {
                restarts = 0;
                eprintln!("grill: model download interrupted: {error}");
                if progressed {
                    failures = 0;
                }
                let delay = config.retry_delay(failures);
                failures += 1;
                report(ModelState::NoNetwork {
                    percent: percent(part_len(&part), source.size),
                    retry_in_sec: u32::try_from(delay.as_millis().div_ceil(1000))
                        .unwrap_or(u32::MAX),
                });
                tokio::select! {
                    () = tokio::time::sleep(delay) => {}
                    () = retry.notified() => {}
                    stop = stop_requested(&mut control) => {
                        return stopped_state(stop, &part, source.size);
                    }
                }
            }
        }
    }
}

enum Attempt {
    Finished(ModelState),
    Stopped(Control),
    /// Start over at once (the `.part` was dropped).
    Again,
    Network {
        /// Bytes arrived before it broke.
        progressed: bool,
        error: String,
    },
}

fn network(progressed: bool, error: impl ToString) -> Attempt {
    Attempt::Network {
        progressed,
        error: error.to_string(),
    }
}

fn io_failed(what: &str, error: &io::Error) -> Attempt {
    Attempt::Finished(ModelState::error(
        ErrorReason::Io,
        format!("{what}: {error}"),
    ))
}

/// One request: from the `.part` (or from 0) to the end, then the check.
async fn attempt(
    source: &Source,
    file: &Path,
    part: &Path,
    config: &Config,
    control: &mut watch::Receiver<Control>,
    report: &mut impl FnMut(ModelState),
) -> Attempt {
    let size = source.size;
    let mut have = part_len(part);
    if have > size {
        if let Err(error) = remove_part(part) {
            return io_failed("Не удалось удалить недокачанный файл", &error);
        }
        have = 0;
    }

    let need = size - have + size / 10;
    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    match (config.free_space)(dir) {
        Ok(free) if free < need => {
            return Attempt::Finished(ModelState::NoSpace {
                need_bytes: need,
                free_bytes: free,
            });
        }
        Ok(_) => {}
        // Not knowing is no reason to refuse; a full disk fails the write.
        Err(error) => eprintln!("grill: free space of {} unknown: {error}", dir.display()),
    }

    report(ModelState::Downloading {
        percent: percent(have, size),
        bytes_per_sec: 0,
    });
    let mut hasher = Sha256::new();
    if have > 0 {
        match hash_part(part.to_owned()).await {
            Ok((hashed, len)) => {
                hasher = hashed;
                have = len;
            }
            Err(error) => return io_failed("Не удалось прочитать недокачанный файл", &error),
        }
    }
    if have == size {
        return Attempt::Finished(check(hasher, source, part, file, report).await);
    }

    let mut request = config.client.get(&source.url);
    if have > 0 {
        request = request.header(header::RANGE, format!("bytes={have}-"));
    }
    let response = tokio::select! {
        response = request.send() => response,
        stop = stop_requested(control) => return Attempt::Stopped(stop),
    };
    let mut response = match response {
        Ok(response) => response,
        Err(error) => return network(false, error),
    };

    let status = response.status();
    let from_zero = match status {
        StatusCode::PARTIAL_CONTENT => {
            if content_range_start(&response).unwrap_or(0) != have {
                // Not the bytes we asked for: drop the part and start over.
                if let Err(error) = remove_part(part) {
                    return io_failed("Не удалось удалить недокачанный файл", &error);
                }
                return Attempt::Again;
            }
            false
        }
        // No Range support: the whole file again.
        StatusCode::OK => true,
        StatusCode::RANGE_NOT_SATISFIABLE => {
            if let Err(error) = remove_part(part) {
                return io_failed("Не удалось удалить недокачанный файл", &error);
            }
            return Attempt::Again;
        }
        status if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS => {
            return network(false, format!("server answered {status}"));
        }
        status => {
            return Attempt::Finished(ModelState::error(
                ErrorReason::Http,
                format!("Сервер ответил {status}"),
            ));
        }
    };
    if from_zero {
        have = 0;
        hasher = Sha256::new();
    }
    if let Some(length) = response.content_length()
        && have + length != size
    {
        return Attempt::Finished(ModelState::error(
            ErrorReason::Http,
            format!(
                "Размер файла на сервере не совпадает: {} байт вместо {size}",
                have + length
            ),
        ));
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true);
    if from_zero {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    let mut out = match options.open(part).await {
        Ok(out) => out,
        Err(error) => return io_failed("Не удалось записать файл модели", &error),
    };

    let mut progressed = false;
    let mut speed = Speed::new(have);
    loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk,
            stop = stop_requested(control) => {
                if let Err(error) = out.flush().await {
                    return io_failed("Не удалось записать файл модели", &error);
                }
                return Attempt::Stopped(stop);
            }
        };
        match chunk {
            Ok(Some(bytes)) => {
                let len = bytes.len() as u64;
                if have + len > size {
                    drop(out);
                    let _ = remove_part(part);
                    return Attempt::Finished(ModelState::error(
                        ErrorReason::Checksum,
                        "Файл модели больше ожидаемого",
                    ));
                }
                if let Err(error) = out.write_all(&bytes).await {
                    return io_failed("Не удалось записать файл модели", &error);
                }
                hasher.update(&bytes);
                have += len;
                progressed = true;
                let bytes_per_sec = speed.update(Instant::now(), have);
                if have < size {
                    report(ModelState::Downloading {
                        percent: percent(have, size),
                        bytes_per_sec,
                    });
                }
            }
            Ok(None) if have == size => break,
            Ok(None) => {
                if let Err(error) = out.flush().await {
                    return io_failed("Не удалось записать файл модели", &error);
                }
                return network(progressed, "the connection closed before the end");
            }
            Err(error) => {
                if let Err(error) = out.flush().await {
                    return io_failed("Не удалось записать файл модели", &error);
                }
                return network(progressed, error);
            }
        }
    }
    if let Err(error) = out.flush().await {
        return io_failed("Не удалось записать файл модели", &error);
    }
    drop(out);
    Attempt::Finished(check(hasher, source, part, file, report).await)
}

/// 100 %: compares the sum, then renames the `.part` to the model file.
async fn check(
    hasher: Sha256,
    source: &Source,
    part: &Path,
    file: &Path,
    report: &mut impl FnMut(ModelState),
) -> ModelState {
    report(ModelState::Checking);
    // The sum covers what was sent; the file must hold all of it too (a
    // `.part` deleted under a running download is started again empty).
    let written = part_len(part);
    if written != source.size {
        let _ = remove_part(part);
        return ModelState::error(
            ErrorReason::Io,
            format!(
                "Файл модели записан не полностью: {written} байт из {}. Скачайте его заново",
                source.size
            ),
        );
    }
    if hex(&hasher.finalize()) != source.sha256.to_ascii_lowercase() {
        let _ = remove_part(part);
        return ModelState::error(
            ErrorReason::Checksum,
            "Файл модели повреждён: контрольная сумма не совпала. Скачайте его заново",
        );
    }
    match tokio::fs::rename(part, file).await {
        Ok(()) => ModelState::Ready,
        Err(error) => ModelState::error(
            ErrorReason::Io,
            format!("Не удалось сохранить файл модели: {error}"),
        ),
    }
}

/// The state a stopped download ends in.
fn stopped_state(stop: Control, part: &Path, size: u64) -> ModelState {
    match stop {
        Control::Cancel => match remove_part(part) {
            Ok(()) => ModelState::NotDownloaded,
            Err(error) => ModelState::error(
                ErrorReason::Io,
                format!("Не удалось удалить недокачанный файл: {error}"),
            ),
        },
        Control::Pause | Control::Run => ModelState::Paused {
            percent: percent(part_len(part), size),
        },
    }
}

/// Resolves on a pause or cancel. A manager that went away is a pause: the
/// `.part` stays.
async fn stop_requested(control: &mut watch::Receiver<Control>) -> Control {
    loop {
        if control.changed().await.is_err() {
            return Control::Pause;
        }
        let requested = *control.borrow_and_update();
        if requested != Control::Run {
            return requested;
        }
    }
}

/// The SHA-256 state and length of the bytes already in the `.part`.
async fn hash_part(part: PathBuf) -> io::Result<(Sha256, u64)> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut input = std::fs::File::open(part)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; 1 << 20];
        let mut len = 0;
        loop {
            let read = input.read(&mut buffer)?;
            if read == 0 {
                return Ok((hasher, len));
            }
            hasher.update(&buffer[..read]);
            len += read as u64;
        }
    })
    .await
    .map_err(io::Error::other)?
}

fn part_len(part: &Path) -> u64 {
    std::fs::metadata(part).map_or(0, |metadata| metadata.len())
}

fn remove_part(part: &Path) -> io::Result<()> {
    match std::fs::remove_file(part) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

/// `bytes 100-999/1000` → 100.
fn content_range_start(response: &reqwest::Response) -> Option<u64> {
    let value = response
        .headers()
        .get(header::CONTENT_RANGE)?
        .to_str()
        .ok()?;
    let range = value.trim().strip_prefix("bytes ")?;
    range.split('-').next()?.trim().parse().ok()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}

/// Bytes per second, measured over windows of [`SPEED_WINDOW`].
struct Speed {
    at: Instant,
    bytes: u64,
    rate: u64,
}

impl Speed {
    fn new(bytes: u64) -> Self {
        Self {
            at: Instant::now(),
            bytes,
            rate: 0,
        }
    }

    fn update(&mut self, now: Instant, bytes: u64) -> u64 {
        let elapsed = now.duration_since(self.at);
        if elapsed >= SPEED_WINDOW {
            let rate = (bytes - self.bytes) as f64 / elapsed.as_secs_f64();
            // Finite and positive: elapsed is at least the window.
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let rate = rate as u64;
            self.rate = rate;
            self.at = now;
            self.bytes = bytes;
        }
        self.rate
    }
}

/// Free bytes for this user on the disk of `path` (`statvfs`).
#[cfg(unix)]
pub fn disk_free_space(path: &Path) -> io::Result<u64> {
    use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt as _};

    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidInput, error))?;
    let mut stat = MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is NUL-terminated and outlives the call; `stat` is
    // written by `statvfs` when it returns 0.
    if unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: initialized by the successful call above.
    let stat = unsafe { stat.assume_init() };
    // The field types differ between unix flavours (u32 blocks on macOS).
    #[allow(clippy::useless_conversion)]
    let free = u64::from(stat.f_bavail).saturating_mul(u64::from(stat.f_frsize));
    Ok(free)
}

/// Free bytes for this user on the disk of `path` (`GetDiskFreeSpaceExW`).
#[cfg(windows)]
pub fn disk_free_space(path: &Path) -> io::Result<u64> {
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let path = windows_core::HSTRING::from(path);
    let mut free = 0_u64;
    // SAFETY: `path` is a NUL-terminated wide string that outlives the
    // call; `free` is a valid place for the result.
    unsafe { GetDiskFreeSpaceExW(&path, Some(&raw mut free), None, None) }
        .map_err(io::Error::from)?;
    Ok(free)
}

#[cfg(not(any(unix, windows)))]
pub fn disk_free_space(_path: &Path) -> io::Result<u64> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

#[cfg(test)]
mod tests;
