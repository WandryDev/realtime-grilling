use std::{fs, io::BufWriter, path::PathBuf};

use super::*;
use crate::recording::{SAMPLE_RATE, ogg_opus::OggOpusWriter};

const ID: &str = "019a5c4e-7b9e-7d3c-9a43-2b1f0c6d8e11";

struct Fixture {
    _dir: tempfile::TempDir,
    files: Playable,
    cache: AudioCache,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let files = Playable {
        me: dir.path().join("me.opus"),
        others: dir.path().join("others.opus"),
    };
    for (path, amplitude) in [(&files.me, 0.3_f32), (&files.others, 0.0)] {
        let samples: Vec<f32> = (0..SAMPLE_RATE)
            .map(|n| amplitude * (n as f32 / 8.0).sin())
            .collect();
        let mut writer = OggOpusWriter::new(BufWriter::new(File::create(path).unwrap())).unwrap();
        writer.write(&samples).unwrap();
        writer.finish().unwrap();
    }
    let cache = AudioCache::new(dir.path().join("cache"));
    Fixture {
        _dir: dir,
        files,
        cache,
    }
}

fn request(path: &str, range: Option<&str>) -> Request<Vec<u8>> {
    let mut builder = Request::builder().uri(format!("grill-audio://localhost{path}"));
    if let Some(range) = range {
        builder = builder.header(header::RANGE, range);
    }
    builder.body(Vec::new()).unwrap()
}

impl Fixture {
    fn get(&self, webview: &str, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        respond(
            webview,
            &request(path, range),
            |id| (id == ID).then(|| self.files.clone()),
            &self.cache,
        )
    }

    fn main(&self, path: &str, range: Option<&str>) -> Response<Vec<u8>> {
        self.get(windows::MAIN, path, range)
    }
}

fn header_of(response: &Response<Vec<u8>>, name: header::HeaderName) -> &str {
    response.headers()[name].to_str().unwrap()
}

#[test]
fn without_a_range_the_whole_file_is_200() {
    let fx = fixture();
    let response = fx.main(&format!("/{ID}/me"), None);
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body(), &fs::read(&fx.files.me).unwrap());
    assert_eq!(header_of(&response, header::CONTENT_TYPE), "audio/ogg");
    assert_eq!(header_of(&response, header::ACCEPT_RANGES), "bytes");
    assert_eq!(
        header_of(&response, header::CONTENT_LENGTH),
        response.body().len().to_string()
    );
}

#[test]
fn a_range_is_206_with_exactly_that_slice() {
    let fx = fixture();
    let file = fs::read(&fx.files.others).unwrap();
    let len = file.len();

    let response = fx.main(&format!("/{ID}/others"), Some("bytes=10-19"));
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(response.body(), &file[10..20]);
    assert_eq!(
        header_of(&response, header::CONTENT_RANGE),
        format!("bytes 10-19/{len}")
    );
    assert_eq!(header_of(&response, header::CONTENT_LENGTH), "10");

    // WebKit's probes, the tail and an open range.
    let response = fx.main(&format!("/{ID}/others"), Some("bytes=0-1"));
    assert_eq!(response.body(), &file[..2]);
    let response = fx.main(&format!("/{ID}/others"), Some("bytes=-3"));
    assert_eq!(response.body(), &file[len - 3..]);
    let response = fx.main(&format!("/{ID}/others"), Some("bytes=100-"));
    assert_eq!(response.body(), &file[100..]);
    let response = fx.main(
        &format!("/{ID}/others"),
        Some(&format!("bytes=5-{}", len * 2)),
    );
    assert_eq!(response.body(), &file[5..]);
    assert_eq!(
        header_of(&response, header::CONTENT_RANGE),
        format!("bytes 5-{}/{len}", len - 1)
    );

    let response = fx.main(&format!("/{ID}/others"), Some(&format!("bytes={len}-")));
    assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(
        header_of(&response, header::CONTENT_RANGE),
        format!("bytes */{len}")
    );
    assert_eq!(header_of(&response, header::CACHE_CONTROL), "no-store");
    // A range this scheme doesn't read is ignored: the whole file.
    let response = fx.main(&format!("/{ID}/others"), Some("items=0-1"));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.body().len(), len);
}

#[test]
fn a_slice_is_never_larger_than_the_limit() {
    let len = 10 * MAX_SLICE;
    assert_eq!(
        wanted(Some("bytes=0-"), len),
        Wanted::Slice(0, MAX_SLICE - 1)
    );
    assert_eq!(
        wanted(Some(&format!("bytes={MAX_SLICE}-{len}")), len),
        Wanted::Slice(MAX_SLICE, 2 * MAX_SLICE - 1)
    );
    assert_eq!(
        wanted(Some("bytes=0-99, 200-299"), len),
        Wanted::Whole,
        "several ranges read as none"
    );
    assert_eq!(wanted(Some("bytes=20-10"), len), Wanted::Whole);
    assert_eq!(wanted(Some("bytes=-0"), len), Wanted::Unsatisfiable);
    assert_eq!(wanted(None, len), Wanted::Whole);
}

/// M5: without a range (or with one the scheme does not read) a file over
/// the limit is never read whole: its first slice, 206.
#[test]
fn a_large_file_without_a_range_gets_its_first_slice() {
    let fx = fixture();
    let len = usize::try_from(MAX_SLICE).unwrap() + 1_000;
    let big: Vec<u8> = (0..len).map(|n| (n % 251) as u8).collect();
    fs::write(&fx.files.me, &big).unwrap();
    for range in [
        None,
        Some("bytes=20-10"),
        Some("items=0-1"),
        Some("bytes=0-9,20-29"),
    ] {
        let response = fx.main(&format!("/{ID}/me"), range);
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range:?}");
        assert_eq!(response.body().len(), usize::try_from(MAX_SLICE).unwrap());
        assert_eq!(response.body()[..], big[..response.body().len()]);
        assert_eq!(
            header_of(&response, header::CONTENT_RANGE),
            format!("bytes 0-{}/{len}", MAX_SLICE - 1)
        );
    }
}

#[test]
fn wav_is_served_from_the_decoded_cache() {
    let fx = fixture();
    let whole = fx.main(&format!("/{ID}/me?format=wav"), None);
    assert_eq!(whole.status(), StatusCode::OK);
    assert_eq!(header_of(&whole, header::CONTENT_TYPE), "audio/wav");
    let body = whole.body();
    assert_eq!(&body[..4], b"RIFF");
    // One second of 16 kHz 16-bit mono.
    assert_eq!(body.len(), 44 + 2 * SAMPLE_RATE as usize);

    let header = fx.main(&format!("/{ID}/me?format=wav"), Some("bytes=0-43"));
    assert_eq!(header.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(header.body(), &body[..44]);
    let tail = fx.main(&format!("/{ID}/me?format=wav"), Some("bytes=30000-"));
    assert_eq!(tail.body(), &body[30_000..]);

    let error = fx.main(&format!("/{ID}/me?format=mp3"), None);
    assert_eq!(error.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn unknown_recordings_channels_and_deleted_audio_are_404() {
    let fx = fixture();
    for path in [
        "/019a5c4e-0000-7000-8000-000000000000/me".to_owned(),
        format!("/{ID}/both"),
        format!("/{ID}"),
        format!("/{ID}/me/more"),
        "/../me".to_owned(),
        "/".to_owned(),
    ] {
        let response = fx.main(&path, None);
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{path}");
        assert!(response.body().is_empty());
    }
    // Deleted (or being written): `playable` finds nothing.
    let response = respond(
        windows::MAIN,
        &request(&format!("/{ID}/me?format=wav"), None),
        |_| None,
        &fx.cache,
    );
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    // Files gone from under a row: 404 too.
    let gone = Playable {
        me: PathBuf::from("/nonexistent/me.opus"),
        others: PathBuf::from("/nonexistent/others.opus"),
    };
    for query in ["", "?format=wav"] {
        let response = respond(
            windows::MAIN,
            &request(&format!("/{ID}/me{query}"), None),
            |_| Some(gone.clone()),
            &fx.cache,
        );
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{query}");
    }
}

#[test]
fn only_the_main_window_plays_recordings() {
    let fx = fixture();
    for webview in ["overlay", "widget", "onboarding"] {
        let response = fx.get(webview, &format!("/{ID}/me"), None);
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{webview}");
        assert!(response.body().is_empty());
    }
    let post = respond(
        windows::MAIN,
        &Request::builder()
            .method(Method::POST)
            .uri(format!("grill-audio://localhost/{ID}/me"))
            .body(Vec::new())
            .unwrap(),
        |_| Some(fx.files.clone()),
        &fx.cache,
    );
    assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);
}
