//! The sender of the analytics queue (call-analytics design.md, decision
//! 6; spec `analytics-delivery`). One task of the app: it wakes when an
//! event is queued (and every 2 s), posts the oldest events in batches to
//! `{url}/api/ingest`, and removes what the server accepted. Without the
//! server it waits 1, 2, 4… up to 60 s between tries; the queue keeps
//! everything (up to [`QUEUE_LIMIT`]) for when it is back. Nothing of this
//! reaches the windows: the failures go to the app's log only.
//!
//! It reads and deletes on its own SQLite connection, never through the
//! app's: a slow network never holds the database.

use std::{path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;

use crate::storage::{analytics::notifier, json::Json};

/// Older events go when the queue grows over this, in bytes.
pub const QUEUE_LIMIT: i64 = 500 * 1024 * 1024;
/// The most events in one post…
const BATCH_EVENTS: usize = 500;
/// … and the most bytes, unless a single event is larger.
const BATCH_BYTES: i64 = 1024 * 1024;
/// How long the sender waits after a wake-up, for the write to commit and
/// more events to come.
const SETTLE: Duration = Duration::from_millis(300);
/// The longest wait without a wake-up.
const TICK: Duration = Duration::from_secs(2);
/// The longest pause after failures.
const MAX_PAUSE: Duration = Duration::from_secs(60);

/// Why a post didn't get through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    /// The network, or the server failed (5xx): try again after a pause.
    Retry(String),
    /// The server refused the whole batch (4xx): a bug of one side; the
    /// events stay and the next try comes after the longest pause.
    Refused(String),
    /// The local database.
    Storage(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Retry(message) | Self::Refused(message) | Self::Storage(message) => {
                f.write_str(message)
            }
        }
    }
}

#[derive(Deserialize)]
struct Accepted {
    accepted: Vec<String>,
}

/// Posts the queue of one database to one server.
pub struct Sender {
    client: reqwest::Client,
    url: String,
    connection: Connection,
    limit: i64,
}

impl Sender {
    /// The sender of the queue in `database` (the app's `grill.db`) to the
    /// server at `url`.
    pub fn open(url: &str, database: &Path) -> Result<Self, String> {
        let connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .and_then(|connection| {
            connection.busy_timeout(Duration::from_secs(5))?;
            Ok(connection)
        })
        .map_err(|error| format!("could not open the queue: {error}"))?;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            client,
            url: format!("{}/api/ingest", url.trim_end_matches('/')),
            connection,
            limit: QUEUE_LIMIT,
        })
    }

    /// The limit of the queue in bytes (the tests).
    #[cfg(test)]
    pub fn with_limit(mut self, limit: i64) -> Self {
        self.limit = limit;
        self
    }

    /// Drops the oldest events while the queue is over its limit; how many.
    pub fn trim(&self) -> Result<usize, SendError> {
        let dropped = self
            .connection
            .execute(
                "DELETE FROM analytics_outbox WHERE seq IN (
                   SELECT seq FROM (
                     SELECT seq, sum(bytes) OVER (ORDER BY seq DESC) AS kept
                       FROM analytics_outbox)
                    WHERE kept > ?1)",
                [self.limit],
            )
            .map_err(|error| SendError::Storage(error.to_string()))?;
        if dropped > 0 {
            eprintln!(
                "grill: the analytics queue went over {} MB: {dropped} oldest event(s) dropped",
                self.limit / 1024 / 1024
            );
        }
        Ok(dropped)
    }

    /// The oldest events that make one post: their ids and the body.
    fn batch(&self) -> Result<(Vec<String>, String), SendError> {
        let storage = |error: rusqlite::Error| SendError::Storage(error.to_string());
        let mut statement = self
            .connection
            .prepare("SELECT id, body, bytes FROM analytics_outbox ORDER BY seq LIMIT ?1")
            .map_err(storage)?;
        let rows = statement
            .query_map([i64::try_from(BATCH_EVENTS).unwrap_or(i64::MAX)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(storage)?;
        let (mut ids, mut body, mut bytes) = (Vec::new(), String::from("{\"events\":["), 0);
        for row in rows {
            let (id, event, size) = row.map_err(storage)?;
            if !ids.is_empty() && bytes + size > BATCH_BYTES {
                break;
            }
            if !ids.is_empty() {
                body.push(',');
            }
            body.push_str(&event);
            bytes += size;
            ids.push(id);
        }
        body.push_str("]}");
        Ok((ids, body))
    }

    /// One post of the oldest events; how many the server accepted (0 when
    /// the queue is empty).
    pub async fn send_once(&mut self) -> Result<usize, SendError> {
        self.trim()?;
        let (ids, body) = self.batch()?;
        if ids.is_empty() {
            return Ok(0);
        }
        let response = self
            .client
            .post(&self.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|error| SendError::Retry(error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| SendError::Retry(error.to_string()))?;
        if status.is_server_error() {
            return Err(SendError::Retry(format!("{status}: {text}")));
        }
        if !status.is_success() {
            return Err(SendError::Refused(format!("{status}: {text}")));
        }
        let accepted: Accepted = serde_json::from_str(&text)
            .map_err(|error| SendError::Refused(format!("{error}: {text}")))?;
        let removed = self
            .connection
            .execute(
                "DELETE FROM analytics_outbox WHERE id IN (SELECT value FROM json_each(?1))",
                [Json(serde_json::Value::from(accepted.accepted))],
            )
            .map_err(|error| SendError::Storage(error.to_string()))?;
        Ok(removed)
    }

    /// Sends until the queue is empty or a post fails.
    async fn drain(&mut self) -> Result<(), SendError> {
        while self.send_once().await? > 0 {}
        Ok(())
    }

    /// Runs until the app exits (the task is aborted then; the queue stays).
    pub async fn run(mut self) {
        let wake = notifier();
        let mut failures: u32 = 0;
        loop {
            let pause = match failures {
                0 => None,
                n => Some(pause_after(n)),
            };
            match pause {
                Some(pause) => tokio::time::sleep(pause).await,
                None => {
                    tokio::select! {
                        () = wake.notified() => tokio::time::sleep(SETTLE).await,
                        () = tokio::time::sleep(TICK) => {}
                    }
                }
            }
            match self.drain().await {
                Ok(()) => failures = 0,
                Err(SendError::Refused(message)) => {
                    eprintln!("grill: the analytics server refused a batch: {message}");
                    failures = u32::MAX;
                }
                Err(error) => {
                    if failures == 0 {
                        eprintln!("grill: the analytics are not sent for now: {error}");
                    }
                    failures = failures.saturating_add(1);
                }
            }
        }
    }
}

/// The pause after `failures` failed tries in a row: 1, 2, 4… s up to a
/// minute, with up to a quarter more at random so many apps don't come back
/// at once.
pub fn pause_after(failures: u32) -> Duration {
    let base = Duration::from_secs(1u64 << failures.saturating_sub(1).min(6)).min(MAX_PAUSE);
    let random = uuid::Uuid::now_v7().as_bytes()[15];
    let extra = base.mul_f64(f64::from(random) / 255.0 / 4.0);
    (base + extra).min(MAX_PAUSE)
}

#[cfg(test)]
mod tests;
