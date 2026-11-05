//! The `grill-audio` scheme (post-call design.md, decision 9): the main
//! window's player reads a recording's channel by its id, never by a path.
//!
//! ```text
//! grill-audio://localhost/<recordingId>/<me|others>[?format=wav]
//! http://grill-audio.localhost/<recordingId>/<me|others>[?format=wav]   (Windows)
//! ```
//!
//! `?format=wav` serves the channel decoded to WAV (what the player takes,
//! `docs/spikes/audio-playback.md`); without it, the Ogg Opus file as it
//! is. `Range: bytes=…` gets 206 with exactly that slice, read from the
//! file (wry holds a whole body in memory, so a slice is at most
//! [`MAX_SLICE`]: an open or larger range gets its first [`MAX_SLICE`]
//! bytes, and `Content-Range` says so); no `Range` gets 200 with the whole
//! file. 404 for an unknown recording, one being written or whose audio
//! was deleted, and an unknown channel; 403 for any webview but the main
//! window's.

use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

use tauri::{
    Manager, Runtime, UriSchemeContext, UriSchemeResponder,
    http::{Method, Request, Response, StatusCode, header},
};

use super::audio::{AudioCache, Playable, playable_in};
use crate::{shell::windows, storage::Storage, storage::transcript::TranscriptChannel};

pub const SCHEME: &str = "grill-audio";
/// The most bytes one response carries.
pub const MAX_SLICE: u64 = 2 * 1024 * 1024;

/// What the request asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    /// The channel file as it is.
    Ogg,
    Wav,
}

impl Format {
    fn content_type(self) -> &'static str {
        match self {
            Self::Ogg => "audio/ogg",
            Self::Wav => "audio/wav",
        }
    }
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Vec::new())
        .unwrap_or_default()
}

/// `/<id>/<channel>` → the id and the channel.
fn target(path: &str) -> Option<(&str, TranscriptChannel)> {
    let mut parts = path.trim_start_matches('/').split('/');
    let (Some(id), Some(channel), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    uuid::Uuid::parse_str(id).ok()?;
    let channel = match channel {
        "me" => TranscriptChannel::Me,
        "others" => TranscriptChannel::Others,
        _ => return None,
    };
    Some((id, channel))
}

/// `format` of the query; `None` for one this scheme doesn't serve.
fn format(query: Option<&str>) -> Option<Format> {
    let wanted = query
        .unwrap_or_default()
        .split('&')
        .find_map(|pair| pair.strip_prefix("format="));
    match wanted {
        None => Some(Format::Ogg),
        Some("wav") => Some(Format::Wav),
        Some(_) => None,
    }
}

/// A `Range` header against a file of `len` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Wanted {
    /// No range, or one this scheme ignores (another unit, not a number).
    Whole,
    /// The first and last byte, inclusive.
    Slice(u64, u64),
    /// Starts past the end.
    Unsatisfiable,
}

/// The first range of `bytes=…`; at most [`MAX_SLICE`] bytes of it.
fn wanted(range: Option<&str>, len: u64) -> Wanted {
    let Some(spec) = range.and_then(|range| range.trim().strip_prefix("bytes=")) else {
        return Wanted::Whole;
    };
    let first = spec.split(',').next().unwrap_or_default().trim();
    let Some((start, end)) = first.split_once('-') else {
        return Wanted::Whole;
    };
    let (start, end) = match (start.trim(), end.trim()) {
        ("", "") => return Wanted::Whole,
        // The last `n` bytes.
        ("", suffix) => match suffix.parse::<u64>() {
            Ok(0) => return Wanted::Unsatisfiable,
            Ok(n) => (len.saturating_sub(n), len.saturating_sub(1)),
            Err(_) => return Wanted::Whole,
        },
        (start, "") => match start.parse::<u64>() {
            Ok(start) => (start, len.saturating_sub(1)),
            Err(_) => return Wanted::Whole,
        },
        (start, end) => match (start.parse::<u64>(), end.parse::<u64>()) {
            (Ok(start), Ok(end)) if start <= end => (start, end.min(len.saturating_sub(1))),
            _ => return Wanted::Whole,
        },
    };
    if start >= len {
        return Wanted::Unsatisfiable;
    }
    Wanted::Slice(start, end.min(start + MAX_SLICE - 1))
}

fn read_slice(path: &Path, start: u64, count: u64) -> io::Result<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut body = Vec::with_capacity(usize::try_from(count).unwrap_or(0));
    file.take(count).read_to_end(&mut body)?;
    Ok(body)
}

/// The response to a request of the webview `webview`. `playable` finds the
/// recording's files by its id.
pub fn respond(
    webview: &str,
    request: &Request<Vec<u8>>,
    playable: impl FnOnce(&str) -> Option<Playable>,
    cache: &AudioCache,
) -> Response<Vec<u8>> {
    if webview != windows::MAIN {
        return status(StatusCode::FORBIDDEN);
    }
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        return status(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some((id, channel)) = target(request.uri().path()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Some(format) = format(request.uri().query()) else {
        return status(StatusCode::BAD_REQUEST);
    };
    let Some(files) = playable(id) else {
        return status(StatusCode::NOT_FOUND);
    };
    let source = files.file(channel);
    let path = match format {
        Format::Ogg => source.to_owned(),
        Format::Wav => match cache.wav(id, channel, source) {
            Ok(path) => path,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return status(StatusCode::NOT_FOUND);
            }
            Err(error) => {
                eprintln!("grill: recording {id} not decoded for playback: {error}");
                return status(StatusCode::INTERNAL_SERVER_ERROR);
            }
        },
    };
    let len = match path.metadata() {
        Ok(meta) => meta.len(),
        Err(_) => return status(StatusCode::NOT_FOUND),
    };
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, format.content_type())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store");
    let (builder, start, count) = match wanted(range, len) {
        Wanted::Whole => (builder.status(StatusCode::OK), 0, len),
        Wanted::Slice(start, end) => (
            builder
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")),
            start,
            end - start + 1,
        ),
        Wanted::Unsatisfiable => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap_or_default();
        }
    };
    let body = if head {
        Vec::new()
    } else {
        match read_slice(&path, start, count) {
            Ok(body) => body,
            Err(_) => return status(StatusCode::NOT_FOUND),
        }
    };
    builder
        .header(header::CONTENT_LENGTH, count)
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

/// The handler `tauri::Builder::register_asynchronous_uri_scheme_protocol`
/// calls: answers off the main thread.
pub fn handle<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = context.app_handle().clone();
    let webview = context.webview_label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match (app.try_state::<Storage>(), app.try_state::<AudioCache>()) {
            (Some(storage), Some(cache)) => {
                respond(&webview, &request, |id| playable_in(&storage, id), &cache)
            }
            _ => status(StatusCode::SERVICE_UNAVAILABLE),
        };
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests;
