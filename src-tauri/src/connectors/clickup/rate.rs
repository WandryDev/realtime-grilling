//! ClickUp's rate limit (connectors-clickup design.md, decision 4): 100
//! requests a minute per token on most plans. The [`RateGate`] of a
//! token keeps what the last answer said and lets every request wait
//! its turn:
//!
//! - the remaining requests at 0 with the reset ahead: wait until the reset
//!   plus a second;
//! - a 429: wait until `X-RateLimit-Reset` (60 s without it) and try again,
//!   up to [`RETRIES`] times, then `Unreachable` («ClickUp ограничил
//!   запросы»): never a revoked token;
//! - no rate headers in the last answer: at least 600 ms between requests;
//! - at most 4 requests at once.
//!
//! Every wait is a Tokio sleep inside the request's future: it ends when the
//! future is dropped, so cancelling a sync (its task aborted) cancels the
//! wait with it.

use std::{
    sync::{Mutex, PoisonError},
    time::{Duration, SystemTime},
};

use reqwest::header::HeaderMap;
use tokio::{sync::Semaphore, time::Instant};

use crate::connectors::ConnectorError;

/// What a request gets past the gate: the rate headers and the answer, or
/// a 429 to wait for and retry.
pub enum Reply<T> {
    Answered(Result<T, ConnectorError>),
    Throttled,
}

/// The rate headers of an answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Observed {
    pub remaining: Option<u32>,
    /// `X-RateLimit-Reset`, Unix time.
    pub reset: Option<SystemTime>,
}

impl Observed {
    /// Reads `X-RateLimit-Remaining` and `X-RateLimit-Reset` (whole or
    /// fractional seconds); anything unreadable is left out.
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let number = |name: &str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .and_then(|text| text.trim().parse::<f64>().ok())
                .filter(|value| value.is_finite() && *value >= 0.0)
        };
        Self {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a non-negative count, capped"
            )]
            remaining: number("x-ratelimit-remaining").map(|value| value.min(1e9) as u32),
            reset: number("x-ratelimit-reset")
                .map(|seconds| SystemTime::UNIX_EPOCH + Duration::from_secs_f64(seconds.min(1e12))),
        }
    }

    fn has_any(&self) -> bool {
        self.remaining.is_some() || self.reset.is_some()
    }
}

/// How many times a 429 is retried.
pub const RETRIES: u32 = 5;
/// The wait after a 429 without `X-RateLimit-Reset`.
pub const FALLBACK_WAIT: Duration = Duration::from_secs(60);
/// Past the reset before the next request when none remained.
pub const RESET_MARGIN: Duration = Duration::from_secs(1);
/// Between requests while ClickUp sends no rate headers: 100 a minute.
pub const SPACING: Duration = Duration::from_millis(600);
/// Requests at once per connection.
pub const CONCURRENCY: usize = 4;
/// ClickUp's window is a minute: a reset further away is a clock out of
/// step, not a reason to wait longer.
pub const MAX_WAIT: Duration = Duration::from_secs(61);

pub const THROTTLED: &str = "ClickUp ограничил запросы";

#[derive(Debug, Default)]
struct State {
    /// Requests left in the window, counting the ones sent since.
    remaining: Option<u32>,
    /// When the window resets (the margin included), on Tokio's clock.
    reset_at: Option<Instant>,
    /// The last answer had rate headers.
    headers: bool,
    /// The earliest time of the next request without headers.
    next_free: Option<Instant>,
}

/// The rate limit of one token, shared by all its requests.
#[derive(Debug)]
pub struct RateGate {
    permits: Semaphore,
    state: Mutex<State>,
    /// Requests sleeping for the limit now (the tests wait for it).
    #[cfg(test)]
    pub sleeping: std::sync::atomic::AtomicUsize,
}

impl Default for RateGate {
    fn default() -> Self {
        Self {
            permits: Semaphore::new(CONCURRENCY),
            state: Mutex::new(State::default()),
            #[cfg(test)]
            sleeping: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

/// How far `at` (Unix time) is from now, within `[0, MAX_WAIT]`.
fn until(at: SystemTime) -> Duration {
    at.duration_since(SystemTime::now())
        .unwrap_or(Duration::ZERO)
        .min(MAX_WAIT)
}

impl RateGate {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// As if the last answer said nothing remains until `reset_at`.
    #[cfg(test)]
    pub fn exhaust_until(&self, reset_at: Instant) {
        let mut state = self.state();
        state.headers = true;
        state.remaining = Some(0);
        state.reset_at = Some(reset_at);
    }

    async fn sleep_until(&self, at: Instant) {
        #[cfg(test)]
        let _sleeping = Sleeping::enter(&self.sleeping);
        tokio::time::sleep_until(at).await;
    }

    /// Sends one request through the gate: `attempt` sends it and reads the
    /// answer's rate headers; it runs again after a 429.
    pub async fn send<T, F, Fut>(&self, mut attempt: F) -> Result<T, ConnectorError>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = (Observed, Reply<T>)>,
    {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| ConnectorError::Other("Запросы к ClickUp остановлены".to_owned()))?;
        let mut retries = 0;
        loop {
            if let Some(at) = self.turn() {
                self.sleep_until(at).await;
            }
            let (observed, reply) = attempt().await;
            self.observe(observed);
            match reply {
                Reply::Answered(result) => return result,
                Reply::Throttled => {
                    if retries >= RETRIES {
                        return Err(ConnectorError::Unreachable(THROTTLED.to_owned()));
                    }
                    retries += 1;
                    let wait = observed
                        .reset
                        .map_or(FALLBACK_WAIT, until)
                        .max(Duration::from_secs(1));
                    let at = Instant::now() + wait;
                    {
                        // The other requests wait for it too.
                        let mut state = self.state();
                        state.remaining = Some(0);
                        state.reset_at = Some(state.reset_at.map_or(at, |known| known.max(at)));
                    }
                    self.sleep_until(at).await;
                }
            }
        }
    }

    /// Nothing remains of the window and its reset is still ahead.
    pub fn limited(&self) -> bool {
        let state = self.state();
        state.remaining == Some(0) && state.reset_at.is_some_and(|reset| reset > Instant::now())
    }

    /// When the next request may go (`None`: now); takes its place.
    fn turn(&self) -> Option<Instant> {
        let now = Instant::now();
        let mut state = self.state();
        let mut at = now;
        if state.remaining == Some(0) {
            match state.reset_at {
                Some(reset) if reset > now => at = reset,
                // The window is over: the next answer tells the new one.
                _ => {
                    state.remaining = None;
                    state.reset_at = None;
                }
            }
        }
        if let Some(remaining) = state.remaining.as_mut() {
            *remaining = remaining.saturating_sub(1);
        }
        if !state.headers {
            if let Some(next) = state.next_free {
                at = at.max(next);
            }
            state.next_free = Some(at + SPACING);
        }
        (at > now).then_some(at)
    }

    /// Keeps what an answer said of the window.
    fn observe(&self, observed: Observed) {
        let now = Instant::now();
        let mut state = self.state();
        if !observed.has_any() {
            state.headers = false;
            return;
        }
        state.headers = true;
        state.next_free = None;
        let reset_at = observed
            .reset
            .map(|reset| now + until(reset) + RESET_MARGIN);
        // Answers of one window may come out of order: the lower count of
        // the same window wins.
        let same_window = match (state.reset_at, reset_at) {
            (Some(known), Some(new)) => known.max(new) - known.min(new) < Duration::from_secs(2),
            _ => false,
        };
        state.remaining = match (state.remaining, observed.remaining) {
            (Some(known), Some(new)) if same_window => Some(known.min(new)),
            (_, new) => new,
        };
        state.reset_at = reset_at;
    }
}

/// Counts a sleeping request while it sleeps, cancelled or not.
#[cfg(test)]
struct Sleeping<'a>(&'a std::sync::atomic::AtomicUsize);

#[cfg(test)]
impl<'a> Sleeping<'a> {
    fn enter(count: &'a std::sync::atomic::AtomicUsize) -> Self {
        count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self(count)
    }
}

#[cfg(test)]
impl Drop for Sleeping<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
