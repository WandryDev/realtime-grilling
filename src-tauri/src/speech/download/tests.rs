//! The downloader and [`ModelManager`] against a tiny HTTP/1.1 server on
//! 127.0.0.1 serving a few hundred KB: never the real network or models.

use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use sha2::{Digest as _, Sha256};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
};

use super::{Config, Source, hex, part_path};
use crate::{
    error::CommandError,
    speech::models::{
        ErrorReason, ModelEvents, ModelId, ModelManager, ModelState, SpeechModel, model_file,
    },
};

const SIZE: usize = 300_000;
const WAIT: Duration = Duration::from_secs(10);

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

fn data() -> Arc<Vec<u8>> {
    let mut state = 0x2545_f491_u32;
    Arc::new(
        (0..SIZE)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state.to_le_bytes()[0]
            })
            .collect(),
    )
}

fn sha(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

/// What the server does wrong.
#[derive(Clone, Copy, Default)]
struct Behavior {
    /// Answers 200 with the whole file to a `Range` request.
    ignore_range: bool,
    /// The first response closes the connection after this byte.
    drop_at: Option<usize>,
    /// The first response stops sending after this byte and never ends.
    stall_at: Option<usize>,
}

struct Server {
    url: String,
    /// The `Range` start of each request (`None`: no `Range`).
    requests: Arc<Mutex<Vec<Option<usize>>>>,
}

impl Server {
    fn requests(&self) -> Vec<Option<usize>> {
        self.requests.lock().unwrap().clone()
    }
}

fn serve(data: Arc<Vec<u8>>, behavior: Behavior) -> Server {
    let listener = block_on(TcpListener::bind("127.0.0.1:0")).unwrap();
    let url = format!("http://{}/ggml-test.bin", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&requests);
    tauri::async_runtime::spawn(async move {
        let mut first = true;
        while let Ok((socket, _)) = listener.accept().await {
            let data = Arc::clone(&data);
            let log = Arc::clone(&log);
            tauri::async_runtime::spawn(respond(socket, data, behavior, first, log));
            first = false;
        }
    });
    Server { url, requests }
}

async fn respond(
    mut socket: TcpStream,
    data: Arc<Vec<u8>>,
    behavior: Behavior,
    first: bool,
    log: Arc<Mutex<Vec<Option<usize>>>>,
) {
    let mut head = Vec::new();
    let mut buffer = [0; 1024];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        match socket.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => head.extend_from_slice(&buffer[..read]),
        }
    }
    let head = String::from_utf8_lossy(&head).to_ascii_lowercase();
    let range = head.lines().find_map(|line| {
        line.strip_prefix("range: bytes=")
            .and_then(|range| range.trim().trim_end_matches('-').parse::<usize>().ok())
    });
    log.lock().unwrap().push(range);

    let len = data.len();
    let start = if behavior.ignore_range { None } else { range };
    let response = match start {
        Some(start) => format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{}/{len}\r\nConnection: close\r\n\r\n",
            len - start,
            len - 1
        ),
        None => format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n"),
    };
    if socket.write_all(response.as_bytes()).await.is_err() {
        return;
    }
    let from = start.unwrap_or(0);
    let cut = if first {
        behavior.drop_at.or(behavior.stall_at)
    } else {
        None
    };
    let to = cut.unwrap_or(len).max(from);
    for chunk in data[from..to].chunks(8 * 1024) {
        if socket.write_all(chunk).await.is_err() {
            return;
        }
        tokio::task::yield_now().await;
    }
    let _ = socket.flush().await;
    if first && behavior.stall_at.is_some() {
        // Holds the connection open until the client goes away.
        let _ = socket.read(&mut buffer).await;
        return;
    }
    let _ = socket.shutdown().await;
}

/// Keeps every change sent to the windows.
#[derive(Default)]
struct Events(Mutex<Vec<SpeechModel>>);

impl Events {
    fn states(&self, id: ModelId) -> Vec<ModelState> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|model| model.id == id)
            .map(|model| model.state.clone())
            .collect()
    }

    fn all(&self) -> Vec<SpeechModel> {
        self.0.lock().unwrap().clone()
    }
}

impl ModelEvents for Arc<Events> {
    fn changed(&self, model: &SpeechModel) {
        self.0.lock().unwrap().push(model.clone());
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    manager: ModelManager,
    events: Arc<Events>,
}

fn config(free: u64) -> Config {
    Config {
        client: reqwest::Client::builder()
            .no_proxy()
            .read_timeout(Duration::from_secs(5))
            .build()
            .unwrap(),
        retry_delays: vec![Duration::from_millis(20), Duration::from_millis(40)],
        progress_interval: Duration::from_millis(250),
        free_space: Arc::new(move |_| Ok(free)),
    }
}

fn fixture_with(url: &str, size: u64, sha256: String, config: Config) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let events = Arc::new(Events::default());
    let source = Source {
        url: url.to_owned(),
        size,
        sha256,
    };
    let manager = ModelManager::new(
        dir.path().to_owned(),
        Box::new(move |_| source.clone()),
        config,
        Arc::clone(&events),
        ModelId::Turbo,
    );
    Fixture {
        dir,
        manager,
        events,
    }
}

fn fixture(server: &Server, data: &[u8]) -> Fixture {
    fixture_with(&server.url, data.len() as u64, sha(data), config(u64::MAX))
}

impl Fixture {
    fn file(&self, id: ModelId) -> std::path::PathBuf {
        model_file(self.dir.path(), id)
    }

    fn state(&self, id: ModelId) -> ModelState {
        self.manager.get(id).state
    }

    /// Polls until `done` holds for the state, or fails after [`WAIT`].
    fn wait_for(&self, id: ModelId, done: impl Fn(&ModelState) -> bool) -> ModelState {
        let start = std::time::Instant::now();
        loop {
            let state = self.state(id);
            if done(&state) {
                return state;
            }
            assert!(start.elapsed() < WAIT, "still {state:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn wait_idle(&self, id: ModelId) -> ModelState {
        self.wait_for(id, |state| {
            !matches!(
                state,
                ModelState::Downloading { .. }
                    | ModelState::Checking
                    | ModelState::NoNetwork { .. }
            )
        })
    }
}

fn len(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|metadata| metadata.len())
}

fn wait_for_len(path: &Path, expected: u64) {
    let start = std::time::Instant::now();
    while len(path) != Some(expected) {
        assert!(
            start.elapsed() < WAIT,
            "{} is {:?}",
            path.display(),
            len(path)
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn downloads_checks_and_renames() {
    let data = data();
    let server = serve(Arc::clone(&data), Behavior::default());
    let fx = fixture(&server, &data);
    let id = ModelId::Small;
    assert_eq!(fx.state(id), ModelState::NotDownloaded);

    let started = fx.manager.download(id);
    assert!(matches!(
        started.state,
        ModelState::Downloading { percent: 0, .. }
    ));
    assert_eq!(fx.wait_idle(id), ModelState::Ready);

    assert_eq!(std::fs::read(fx.file(id)).unwrap(), *data);
    assert!(!part_path(&fx.file(id)).exists());
    assert_eq!(server.requests(), vec![None]);
    let states = fx.events.states(id);
    assert!(
        matches!(states.first(), Some(ModelState::Downloading { .. })),
        "{states:?}"
    );
    assert!(states.contains(&ModelState::Checking), "{states:?}");
    assert_eq!(states.last(), Some(&ModelState::Ready));
    assert_eq!(fx.manager.model_path(id), Some(fx.file(id)));
    assert_eq!(fx.manager.model_path(ModelId::Turbo), None);

    // Ready stays ready.
    assert_eq!(fx.manager.download(id).state, ModelState::Ready);
    assert_eq!(server.requests(), vec![None]);
}

#[test]
fn pause_keeps_the_part_and_resume_continues_from_the_same_byte() {
    let data = data();
    let cut = 100_000;
    let server = serve(
        Arc::clone(&data),
        Behavior {
            stall_at: Some(cut),
            ..Behavior::default()
        },
    );
    let fx = fixture(&server, &data);
    let id = ModelId::Turbo;
    let part = part_path(&fx.file(id));

    fx.manager.download(id);
    wait_for_len(&part, cut as u64);
    let paused = block_on(fx.manager.pause(id));
    assert_eq!(paused.state, ModelState::Paused { percent: 33 });
    assert_eq!(len(&part), Some(cut as u64), ".part kept");
    // A fresh manager reads the same state from the disk.
    assert_eq!(
        crate::speech::models::detect(fx.dir.path(), id, data.len() as u64),
        ModelState::Paused { percent: 33 }
    );

    fx.manager.download(id);
    assert_eq!(fx.wait_idle(id), ModelState::Ready);
    assert_eq!(server.requests(), vec![None, Some(cut)]);
    assert_eq!(std::fs::read(fx.file(id)).unwrap(), *data);
}

#[test]
fn a_dropped_connection_retries_by_itself_from_where_it_stopped() {
    let data = data();
    let cut = 120_000;
    let server = serve(
        Arc::clone(&data),
        Behavior {
            drop_at: Some(cut),
            ..Behavior::default()
        },
    );
    let fx = fixture(&server, &data);
    let id = ModelId::Small;

    fx.manager.download(id);
    assert_eq!(fx.wait_idle(id), ModelState::Ready);
    assert_eq!(server.requests(), vec![None, Some(cut)]);
    assert_eq!(std::fs::read(fx.file(id)).unwrap(), *data);
    assert!(
        fx.events.states(id).contains(&ModelState::NoNetwork {
            percent: 40,
            retry_in_sec: 1
        }),
        "{:?}",
        fx.events.states(id)
    );
}

#[test]
fn retry_now_ends_the_wait_after_a_broken_connection() {
    let data = data();
    let cut = 120_000;
    let server = serve(
        Arc::clone(&data),
        Behavior {
            drop_at: Some(cut),
            ..Behavior::default()
        },
    );
    // The automatic retry would come long after the test gave up.
    let mut slow = config(u64::MAX);
    slow.retry_delays = vec![Duration::from_secs(600)];
    let fx = fixture_with(&server.url, data.len() as u64, sha(&data), slow);
    let id = ModelId::Small;

    fx.manager.download(id);
    let waiting = fx.wait_for(id, |state| matches!(state, ModelState::NoNetwork { .. }));
    assert_eq!(
        waiting,
        ModelState::NoNetwork {
            percent: 40,
            retry_in_sec: 600
        }
    );
    // "Повторить сейчас": the reply already says it downloads.
    assert_eq!(
        fx.manager.download(id).state,
        ModelState::Downloading {
            percent: 40,
            bytes_per_sec: 0
        }
    );
    assert_eq!(fx.wait_idle(id), ModelState::Ready);
    assert_eq!(server.requests(), vec![None, Some(cut)]);
    assert_eq!(std::fs::read(fx.file(id)).unwrap(), *data);
}

#[test]
fn a_part_shorter_than_the_model_is_never_renamed() {
    let data = data();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ggml-test.bin");
    let part = part_path(&file);
    // The sum of every byte, the file with the end only: what a `.part`
    // deleted under a running download leaves.
    std::fs::write(&part, &data[200_000..]).unwrap();
    let source = Source {
        url: String::new(),
        size: data.len() as u64,
        sha256: sha(&data),
    };
    let mut hasher = Sha256::new();
    hasher.update(&*data);
    let state = block_on(super::check(hasher, &source, &part, &file, &mut |_| {}));
    assert!(
        matches!(
            state,
            ModelState::Error {
                reason: ErrorReason::Io,
                ..
            }
        ),
        "{state:?}"
    );
    assert!(!part.exists());
    assert!(!file.exists());
}

#[test]
fn a_server_without_range_starts_over() {
    let data = data();
    let server = serve(
        Arc::clone(&data),
        Behavior {
            ignore_range: true,
            ..Behavior::default()
        },
    );
    let fx = fixture(&server, &data);
    let id = ModelId::Turbo;
    // Bytes that are not the model's: they must not end up in the sum.
    std::fs::write(part_path(&fx.file(id)), vec![0xff; 50_000]).unwrap();
    assert_eq!(fx.state(id), ModelState::Paused { percent: 16 });

    fx.manager.download(id);
    assert_eq!(fx.wait_idle(id), ModelState::Ready);
    assert_eq!(server.requests(), vec![Some(50_000)]);
    assert_eq!(std::fs::read(fx.file(id)).unwrap(), *data);
}

#[test]
fn a_wrong_checksum_deletes_the_file() {
    let data = data();
    let server = serve(Arc::clone(&data), Behavior::default());
    let fx = fixture_with(
        &server.url,
        data.len() as u64,
        "00".repeat(32),
        config(u64::MAX),
    );
    let id = ModelId::Small;

    fx.manager.download(id);
    let state = fx.wait_idle(id);
    assert!(
        matches!(
            state,
            ModelState::Error {
                reason: ErrorReason::Checksum,
                ..
            }
        ),
        "{state:?}"
    );
    assert!(!fx.file(id).exists());
    assert!(!part_path(&fx.file(id)).exists());
    assert_eq!(fx.manager.model_path(id), None);
    // The error stays until the user acts; "Скачать заново" starts over.
    assert_eq!(fx.manager.list()[1].state, state);
}

#[test]
fn not_enough_space_does_not_start() {
    let data = data();
    let server = serve(Arc::clone(&data), Behavior::default());
    let size = data.len() as u64;
    let fx = fixture_with(&server.url, size, sha(&data), config(1_000));
    let id = ModelId::Turbo;

    fx.manager.download(id);
    assert_eq!(
        fx.wait_idle(id),
        ModelState::NoSpace {
            need_bytes: size + size / 10,
            free_bytes: 1_000
        }
    );
    assert!(server.requests().is_empty());
    assert!(!part_path(&fx.file(id)).exists());
}

#[test]
fn only_the_rest_of_the_file_needs_space() {
    let data = data();
    let server = serve(Arc::clone(&data), Behavior::default());
    let size = data.len() as u64;
    // Room for the last 100 000 bytes and 10 % of the model, no more.
    let fx = fixture_with(&server.url, size, sha(&data), config(100_000 + size / 10));
    let id = ModelId::Turbo;
    std::fs::write(part_path(&fx.file(id)), &data[..200_000]).unwrap();

    fx.manager.download(id);
    assert_eq!(fx.wait_idle(id), ModelState::Ready);
    assert_eq!(server.requests(), vec![Some(200_000)]);
    assert_eq!(std::fs::read(fx.file(id)).unwrap(), *data);
}

#[test]
fn offline_retries_until_cancelled_and_cancel_deletes_the_part() {
    let data = data();
    // A port nobody listens on.
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let fx = fixture_with(
        &format!("http://127.0.0.1:{port}/ggml-test.bin"),
        data.len() as u64,
        sha(&data),
        config(u64::MAX),
    );
    let id = ModelId::Small;
    let part = part_path(&fx.file(id));
    std::fs::write(&part, &data[..30_000]).unwrap();

    fx.manager.download(id);
    let state = fx.wait_for(id, |state| matches!(state, ModelState::NoNetwork { .. }));
    assert_eq!(
        state,
        ModelState::NoNetwork {
            percent: 10,
            retry_in_sec: 1
        }
    );
    // It keeps trying (10 s, 20 s, then every 30 s in the app).
    std::thread::sleep(Duration::from_millis(200));
    assert!(matches!(
        fx.state(id),
        ModelState::Downloading { .. } | ModelState::NoNetwork { .. }
    ));

    let cancelled = block_on(fx.manager.cancel(id)).unwrap();
    assert_eq!(cancelled.state, ModelState::NotDownloaded);
    assert!(!part.exists());
}

#[test]
fn cancel_of_a_paused_download_deletes_the_part() {
    let data = data();
    let server = serve(
        Arc::clone(&data),
        Behavior {
            stall_at: Some(60_000),
            ..Behavior::default()
        },
    );
    let fx = fixture(&server, &data);
    let id = ModelId::Turbo;
    let part = part_path(&fx.file(id));

    fx.manager.download(id);
    wait_for_len(&part, 60_000);
    assert_eq!(
        block_on(fx.manager.pause(id)).state,
        ModelState::Paused { percent: 20 }
    );
    assert_eq!(
        block_on(fx.manager.cancel(id)).unwrap().state,
        ModelState::NotDownloaded
    );
    assert!(!part.exists());
}

fn installed(fx: &Fixture, id: ModelId, size: usize) {
    std::fs::write(fx.file(id), vec![0; size]).unwrap();
}

/// Nothing here downloads: the files are put in place by hand.
fn offline_fixture() -> Fixture {
    fixture_with(
        "http://127.0.0.1:9/none",
        1_000,
        "00".repeat(32),
        config(u64::MAX),
    )
}

#[test]
fn the_selected_model_is_kept_while_recording() {
    let fx = offline_fixture();
    installed(&fx, ModelId::Turbo, 1_000);
    installed(&fx, ModelId::Small, 1_000);
    assert_eq!(fx.manager.selected(), ModelId::Turbo);

    let error = block_on(fx.manager.remove(ModelId::Turbo, true)).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert!(fx.file(ModelId::Turbo).exists());
    let error = fx.manager.check_select(ModelId::Small, true).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    assert!(
        fx.manager.check_select(ModelId::Turbo, true).is_ok(),
        "the same model"
    );

    // Another model can go while recording.
    let removed = block_on(fx.manager.remove(ModelId::Small, true)).unwrap();
    assert_eq!(removed.state, ModelState::NotDownloaded);
    assert!(!fx.file(ModelId::Small).exists());

    // Not recording: the selected model can be removed.
    let removed = block_on(fx.manager.remove(ModelId::Turbo, false)).unwrap();
    assert_eq!(removed.state, ModelState::NotDownloaded);
    assert!(removed.selected);
    assert_eq!(fx.manager.selected_path(), None);
}

#[test]
fn only_a_ready_model_can_be_selected() {
    let fx = offline_fixture();
    let error = fx.manager.check_select(ModelId::Small, false).unwrap_err();
    assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    installed(&fx, ModelId::Small, 999);
    assert!(
        fx.manager.check_select(ModelId::Small, false).is_err(),
        "wrong size"
    );
    installed(&fx, ModelId::Small, 1_000);
    fx.manager.check_select(ModelId::Small, false).unwrap();

    fx.manager.set_selected(ModelId::Small);
    assert_eq!(fx.manager.selected(), ModelId::Small);
    let selected: Vec<(ModelId, bool)> = fx
        .events
        .all()
        .iter()
        .map(|model| (model.id, model.selected))
        .collect();
    assert!(
        selected.ends_with(&[(ModelId::Turbo, false), (ModelId::Small, true)]),
        "{selected:?}"
    );
    let list = fx.manager.list();
    assert_eq!(
        list.iter()
            .map(|model| (model.id, model.selected))
            .collect::<Vec<_>>(),
        vec![(ModelId::Turbo, false), (ModelId::Small, true)]
    );
    assert_eq!(fx.manager.selected_path(), Some(fx.file(ModelId::Small)));
}

#[test]
fn a_model_deleted_by_hand_is_no_longer_installed() {
    let fx = offline_fixture();
    installed(&fx, ModelId::Turbo, 1_000);
    assert_eq!(fx.state(ModelId::Turbo), ModelState::Ready);
    assert!(fx.manager.model_path(ModelId::Turbo).is_some());

    std::fs::remove_file(fx.file(ModelId::Turbo)).unwrap();
    assert_eq!(fx.manager.model_path(ModelId::Turbo), None);
    assert_eq!(fx.state(ModelId::Turbo), ModelState::NotDownloaded);
    assert_eq!(
        fx.events.states(ModelId::Turbo).last(),
        Some(&ModelState::NotDownloaded)
    );
}

#[test]
fn the_list_shows_both_models_not_downloaded_with_their_size() {
    let dir = tempfile::tempdir().unwrap();
    let manager = ModelManager::new(
        dir.path().to_owned(),
        Box::new(|id| id.spec().source()),
        config(u64::MAX),
        Arc::new(Events::default()),
        ModelId::Turbo,
    );
    let list = manager.list();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, ModelId::Turbo);
    assert_eq!(list[0].name, "Whisper large-v3-turbo");
    assert_eq!(list[0].size_bytes, 574_041_195);
    assert!(list[0].selected);
    assert_eq!(list[1].id, ModelId::Small);
    assert_eq!(list[1].size_bytes, 487_601_967);
    assert!(
        list.iter()
            .all(|model| model.state == ModelState::NotDownloaded)
    );
}

#[test]
fn free_space_of_a_real_folder() {
    let dir = tempfile::tempdir().unwrap();
    let free = super::disk_free_space(dir.path()).unwrap();
    assert!(free > 0);
    assert!(super::disk_free_space(&dir.path().join("missing")).is_err());
}
