//! The sender against a local fake server (call-analytics task 4.2).

use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::Connection;
use serde_json::Value;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::*;
use crate::{
    agent::fast_loop::testing::{recording, say},
    storage::{
        DATABASE_FILE, MIGRATIONS, analytics::enable_on, open, transcript::TranscriptChannel,
    },
};

/// How the fake server answers a post.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Answer {
    /// Takes every event.
    Accept,
    /// Reads the post and closes the connection without an answer.
    Hang,
    /// 503.
    Fail,
    /// 400.
    Refuse,
}

/// A server on a local port: what it got, and how it answers next.
struct FakeServer {
    url: String,
    answers: Arc<Mutex<Vec<Answer>>>,
    received: Arc<Mutex<Vec<Vec<String>>>>,
}

impl FakeServer {
    /// Answers in the order of `answers`, then accepts.
    async fn start(answers: Vec<Answer>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let answers = Arc::new(Mutex::new(answers));
        let received = Arc::new(Mutex::new(Vec::new()));
        let (queue, seen) = (Arc::clone(&answers), Arc::clone(&received));
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let body = read_post(&mut socket).await;
                let events: Value = serde_json::from_str(&body).unwrap();
                let ids: Vec<String> = events["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|event| event["id"].as_str().unwrap().to_owned())
                    .collect();
                seen.lock().unwrap().push(ids.clone());
                let answer = {
                    let mut queue = queue.lock().unwrap();
                    if queue.is_empty() {
                        Answer::Accept
                    } else {
                        queue.remove(0)
                    }
                };
                let (status, text) = match answer {
                    Answer::Hang => {
                        drop(socket);
                        continue;
                    }
                    Answer::Accept => {
                        ("200 OK", serde_json::json!({ "accepted": ids }).to_string())
                    }
                    Answer::Fail => ("503 Service Unavailable", "down".to_owned()),
                    Answer::Refuse => ("400 Bad Request", "bad".to_owned()),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\
                     Connection: close\r\n\r\n{text}",
                    text.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        Self {
            url,
            answers,
            received,
        }
    }

    fn received(&self) -> Vec<Vec<String>> {
        self.received.lock().unwrap().clone()
    }
}

async fn read_post(socket: &mut tokio::net::TcpStream) -> String {
    let mut data = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = socket.read(&mut buffer).await.unwrap();
        data.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&data);
        if let Some(end) = text.find("\r\n\r\n") {
            let length: usize = text[..end]
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().ok())?
                })
                .unwrap_or(0);
            if data.len() >= end + 4 + length {
                return String::from_utf8(data[end + 4..end + 4 + length].to_vec()).unwrap();
            }
        }
        if read == 0 {
            return String::new();
        }
    }
}

/// A database file with the queue on and a call's events in it.
struct Queue {
    _dir: tempfile::TempDir,
    path: PathBuf,
    connection: Connection,
}

impl Queue {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(DATABASE_FILE);
        let connection = open(&path, &MIGRATIONS).unwrap();
        enable_on(&connection).unwrap();
        Self {
            _dir: dir,
            path,
            connection,
        }
    }

    /// A recording and `phrases` phrases of it, queued.
    fn call(&self, phrases: usize) -> String {
        let id = recording(&self.connection);
        for n in 0..phrases {
            say(
                &self.connection,
                &id,
                TranscriptChannel::Others,
                i64::try_from(n).unwrap() * 1_000,
                &format!("Фраза клиента номер {n}"),
            );
        }
        id
    }

    fn ids(&self) -> Vec<String> {
        self.connection
            .prepare("SELECT id FROM analytics_outbox ORDER BY seq")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn sender(&self, url: &str) -> Sender {
        Sender::open(url, &self.path).unwrap()
    }
}

/// The events go in the order they were written; what the server accepted
/// leaves the queue.
#[tokio::test]
async fn the_queue_goes_in_order_and_empties() {
    let queue = Queue::new();
    queue.call(3);
    let queued = queue.ids();
    let server = FakeServer::start(Vec::new()).await;
    let mut sender = queue.sender(&server.url);

    assert_eq!(sender.send_once().await, Ok(queued.len()));
    assert_eq!(server.received(), [queued]);
    assert!(queue.ids().is_empty());
    assert_eq!(sender.send_once().await, Ok(0), "nothing left to post");
}

/// Spec «Сеть пропала»: without the server the events stay; once it is
/// back they all go, in order.
#[tokio::test]
async fn the_events_wait_for_the_network() {
    let queue = Queue::new();
    queue.call(2);
    // A port nothing listens on.
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        format!("http://{}", listener.local_addr().unwrap())
    };
    let before = queue.ids();
    let mut offline = queue.sender(&closed);
    assert!(matches!(
        offline.send_once().await,
        Err(SendError::Retry(_))
    ));
    assert_eq!(queue.ids(), before);

    queue.call(1);
    let all = queue.ids();
    let server = FakeServer::start(Vec::new()).await;
    let mut online = queue.sender(&server.url);
    assert_eq!(online.send_once().await, Ok(all.len()));
    assert_eq!(server.received().concat(), all);
}

/// Spec «Повтор после обрыва»: the connection broke before the answer: the
/// same events go again.
#[tokio::test]
async fn a_broken_post_is_sent_again() {
    let queue = Queue::new();
    queue.call(1);
    let queued = queue.ids();
    let server = FakeServer::start(vec![Answer::Hang, Answer::Fail]).await;
    let mut sender = queue.sender(&server.url);

    assert!(matches!(sender.send_once().await, Err(SendError::Retry(_))));
    assert!(matches!(sender.send_once().await, Err(SendError::Retry(_))));
    assert_eq!(queue.ids(), queued, "nothing is lost");
    assert_eq!(sender.send_once().await, Ok(queued.len()));
    assert_eq!(
        server.received(),
        [queued.clone(), queued.clone(), queued],
        "the same events each time"
    );
    assert!(queue.ids().is_empty());
}

/// A refused batch stays in the queue.
#[tokio::test]
async fn a_refused_batch_stays() {
    let queue = Queue::new();
    queue.call(1);
    let queued = queue.ids();
    let server = FakeServer::start(vec![Answer::Refuse]).await;
    let mut sender = queue.sender(&server.url);
    assert!(matches!(
        sender.send_once().await,
        Err(SendError::Refused(_))
    ));
    assert_eq!(queue.ids(), queued);
    drop(server.answers);
}

/// A post takes at most 500 events: a long call goes in several.
#[tokio::test]
async fn a_long_queue_goes_in_batches() {
    let queue = Queue::new();
    queue.call(600);
    let queued = queue.ids();
    let server = FakeServer::start(Vec::new()).await;
    let mut sender = queue.sender(&server.url);
    sender.drain().await.unwrap();
    let posts = server.received();
    assert!(posts.len() >= 2);
    assert!(posts.iter().all(|post| post.len() <= 500));
    assert_eq!(posts.concat(), queued);
}

/// Spec «Месяц без сервера»: over the limit the oldest go; new events keep
/// coming in.
#[tokio::test]
async fn over_the_limit_the_oldest_go() {
    let queue = Queue::new();
    queue.call(40);
    let total: i64 = queue
        .connection
        .query_row("SELECT sum(bytes) FROM analytics_outbox", [], |row| {
            row.get(0)
        })
        .unwrap();
    let before = queue.ids();
    let sender = queue.sender("http://127.0.0.1:9").with_limit(total / 2);
    let dropped = sender.trim().unwrap();
    assert!(dropped > 0);
    let kept = queue.ids();
    assert_eq!(kept, before[dropped..], "the newest stay");
    let left: i64 = queue
        .connection
        .query_row("SELECT sum(bytes) FROM analytics_outbox", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(left <= total / 2);
    queue.call(1);
    assert!(queue.ids().len() > kept.len(), "new events still come in");
}

/// The pause grows 1, 2, 4… up to a minute.
#[test]
fn the_pause_grows_to_a_minute() {
    let pauses: Vec<u64> = (1..=10).map(|n| pause_after(n).as_secs()).collect();
    assert_eq!(pauses[0], 1);
    assert!((2..=2).contains(&pauses[1]));
    assert!(pauses.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(pause_after(10), Duration::from_secs(60));
}

/// Spec «Падение во время звонка»: the queue survives the app (a new
/// connection, as at the next start) and goes once the server is there.
#[tokio::test]
async fn the_queue_outlives_the_app() {
    let queue = Queue::new();
    queue.call(2);
    let queued = queue.ids();
    let Queue {
        _dir: dir,
        path,
        connection,
    } = queue;
    // The app died: its connection is gone without a goodbye.
    drop(connection);
    let server = FakeServer::start(Vec::new()).await;
    let mut sender = Sender::open(&server.url, &path).unwrap();
    assert_eq!(sender.send_once().await, Ok(queued.len()));
    assert_eq!(server.received().concat(), queued);
    drop(dir);
}
