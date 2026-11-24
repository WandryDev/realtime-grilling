//! The agent of the fast loop behind a trait (`specs/agent-fast-loop`,
//! design.md decision 1), and its only implementation for now: one
//! independent `claude -p` call per request, in the minimal mode the agent
//! spike measured (`docs/spikes/agent.md`, «Рекомендуемый вызов»).
//!
//! This is the only place that knows the CLI's flags and its `stream-json`
//! events. The parser reads line by line and skips what it doesn't know: the
//! patch comes from `result.structured_output`, tokens from `result.usage`,
//! the cost from `total_cost_usd`, the subscription limit from the last
//! `rate_limit_event`.
//!
//! The stable prefix goes in a file (`--system-prompt-file`), not on the
//! command line: Windows limits a command line to 32k characters, and a
//! multi-line argument does not survive the `claude.cmd` shim.

use std::{
    ffi::OsStr,
    path::PathBuf,
    pin::Pin,
    process::{ExitStatus, Stdio},
    time::{Duration, Instant},
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncRead, AsyncWriteExt as _, BufReader},
    sync::oneshot,
};

use super::process;

/// The full model name, not the `sonnet` alias: an alias may move to a new
/// model and reset the cache or the behavior (spike, «Рекомендуемый вызов»).
pub const MODEL: &str = "claude-sonnet-5-5";
/// A call that hasn't answered by then is killed (spec: «Вызов, не
/// завершившийся за 30 с»).
pub const TIMEOUT: Duration = Duration::from_secs(30);
/// How long the CLI may still write and run after its `result` line.
const AFTER_RESULT: Duration = process::OUTPUT_TAIL;
/// How much of the CLI's text goes into an error message.
const DETAIL_CHARS: usize = 500;

/// One call: the stable prefix, the volatile part and the patch schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequest {
    /// The file with the stable prefix: byte-stable for a recording, so the
    /// CLI's prompt cache holds.
    pub system_prompt_file: PathBuf,
    /// Goes to stdin.
    pub user_message: String,
    /// JSON Schema of the patch (`--json-schema`), minified: it stays on
    /// the command line.
    pub schema: String,
    /// Where the CLI's process tree is kept while it runs, for the app's
    /// exit to kill it.
    pub process: process::TreeSlot,
    /// What a call other than the fast loop's changes; the default is the
    /// fast loop's call.
    pub options: CallOptions,
}

/// Per-request overrides of the adapter's call (the brief build,
/// projects-people-brief design.md decisions 4 and 6). `None` keeps the
/// adapter's value.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CallOptions {
    /// Instead of [`ClaudeCodeCli::model`].
    pub model: Option<&'static str>,
    /// `--effort`; `low` when `None`.
    pub effort: Option<&'static str>,
    /// Instead of [`ClaudeCodeCli::timeout`].
    pub timeout: Option<Duration>,
    pub output: OutputKind,
    /// Told when the model starts reading and when it starts writing.
    pub on_output: Option<OutputHook>,
}

/// What `structured_output` must be for the reply to count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum OutputKind {
    /// The fast loop's patch: an object with an `ops` array.
    #[default]
    Patch,
    /// Any JSON object; the caller checks it.
    Object,
}

/// Where the model is in its answer, as the stream shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputPhase {
    /// The first `content_block_delta` (thinking or text).
    Reading,
    /// The first `input_json_delta`, or the `StructuredOutput` call.
    Writing,
}

/// Called once per phase, `Reading` always before `Writing`, from the task
/// that reads the CLI's output: it must not block.
#[derive(Clone)]
pub struct OutputHook(pub std::sync::Arc<dyn Fn(OutputPhase) + Send + Sync>);

impl OutputHook {
    pub fn new(hook: impl Fn(OutputPhase) + Send + Sync + 'static) -> Self {
        Self(std::sync::Arc::new(hook))
    }
}

impl std::fmt::Debug for OutputHook {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OutputHook")
    }
}

/// Clones are equal: the same hook.
impl PartialEq for OutputHook {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for OutputHook {}

/// What a call cost. Tokens are 0 when the CLI didn't report them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Usage {
    /// From the spawn to the end of the output.
    pub duration_ms: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// API equivalent (`total_cost_usd`), not the subscription's spending.
    pub cost_usd: Option<f64>,
    /// Share of the subscription limit used, 0–1 (the fullest window).
    pub utilization: Option<f64>,
    /// When the limit window resets, Unix ms.
    pub resets_at: Option<i64>,
    /// The session and the week window each, as the limit event said
    /// (agent-limit-guard design.md, decision 3).
    pub windows: WindowShares,
}

/// One window of the subscription limit as a source saw it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowShare {
    /// 0–1.
    pub used: f64,
    /// Unix ms, when known.
    pub resets_at: Option<i64>,
}

/// The two windows the thresholds watch: the 5-hour session and the week
/// (all models). `None`: the source didn't say.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WindowShares {
    pub session: Option<WindowShare>,
    pub week: Option<WindowShare>,
}

impl WindowShares {
    pub const fn is_empty(&self) -> bool {
        self.session.is_none() && self.week.is_none()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentReply {
    /// An object with `ops`, not checked against the schema yet.
    pub patch: Value,
    pub usage: Usage,
    /// The CLI's `result` event as it came, for the journal.
    pub raw: String,
}

impl AgentReply {
    /// A reply as the CLI's `result` event with `patch` as its structured
    /// output (the fakes of the tests).
    #[cfg(test)]
    pub fn new(patch: Value, usage: Usage) -> Self {
        let raw = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "structured_output": patch,
        })
        .to_string();
        Self { patch, usage, raw }
    }
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AgentError {
    #[error("Агент не ответил вовремя")]
    Timeout,
    #[error("Нужен вход в Claude Code")]
    NotLoggedIn,
    #[error("Лимит подписки Claude исчерпан")]
    RateLimited {
        /// Unix ms, when known.
        resets_at: Option<i64>,
    },
    #[error("Агент ответил не по схеме: {0}")]
    InvalidOutput(String),
    #[error("{0}")]
    Process(String),
    #[error("Вызов агента отменён")]
    Cancelled,
}

pub type AgentFuture<'a> =
    Pin<Box<dyn Future<Output = Result<AgentReply, AgentError>> + Send + 'a>>;

/// `async fn run(&self, request, cancel) -> Result<AgentReply, AgentError>`,
/// spelled with a boxed future so that `Arc<dyn Agent>` works. A `cancel`
/// that fires, or whose sender is dropped, stops the call (`Cancelled`).
pub trait Agent: Send + Sync {
    fn run(&self, request: AgentRequest, cancel: oneshot::Receiver<()>) -> AgentFuture<'_>;
}

/// Claude Code CLI with the user's subscription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCodeCli {
    pub cli: PathBuf,
    /// `app_data_dir()/agent`, never a user's project; created when missing.
    pub work_dir: PathBuf,
    pub model: &'static str,
    pub timeout: Duration,
}

impl ClaudeCodeCli {
    pub fn new(cli: impl Into<PathBuf>, work_dir: impl Into<PathBuf>) -> Self {
        Self {
            cli: cli.into(),
            work_dir: work_dir.into(),
            model: MODEL,
            timeout: TIMEOUT,
        }
    }

    /// The spike's minimal mode: no user settings, MCP, tools, sessions or
    /// slash commands; the schema leaves one tool, `StructuredOutput`.
    pub fn args<'a>(&'a self, request: &'a AgentRequest) -> [&'a OsStr; 20] {
        [
            OsStr::new("-p"),
            OsStr::new("--model"),
            OsStr::new(request.options.model.unwrap_or(self.model)),
            OsStr::new("--effort"),
            OsStr::new(request.options.effort.unwrap_or("low")),
            OsStr::new("--setting-sources"),
            OsStr::new(""),
            OsStr::new("--strict-mcp-config"),
            OsStr::new("--tools"),
            OsStr::new(""),
            OsStr::new("--no-session-persistence"),
            OsStr::new("--disable-slash-commands"),
            OsStr::new("--system-prompt-file"),
            request.system_prompt_file.as_os_str(),
            OsStr::new("--json-schema"),
            OsStr::new(&request.schema),
            OsStr::new("--output-format"),
            OsStr::new("stream-json"),
            OsStr::new("--verbose"),
            OsStr::new("--include-partial-messages"),
        ]
    }

    async fn call(
        &self,
        request: AgentRequest,
        cancel: oneshot::Receiver<()>,
    ) -> Result<AgentReply, AgentError> {
        tokio::fs::create_dir_all(&self.work_dir)
            .await
            .map_err(|error| {
                AgentError::Process(format!(
                    "Не удалось создать папку агента {}: {error}",
                    self.work_dir.display()
                ))
            })?;
        let mut command = process::cli(&self.cli, &self.work_dir);
        command
            .args(self.args(&request))
            .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
            .stdin(Stdio::piped());
        let started = Instant::now();
        let (mut child, tree) = process::spawn(&mut command).map_err(|error| {
            AgentError::Process(format!("Не удалось запустить Claude Code: {error}"))
        })?;
        let tree = std::sync::Arc::new(tree);
        let _held = request.process.hold(std::sync::Arc::clone(&tree));
        let stderr = process::Collected::start(child.stderr.take());
        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let message = request.user_message.into_bytes();
        let timeout = request.options.timeout.unwrap_or(self.timeout);
        let output = request.options.output;
        let hook = request.options.on_output;

        let work = async {
            // Written while the output is read: a full pipe can't block both.
            let write = async move {
                if let Some(mut stdin) = stdin {
                    // The CLI may exit without reading (not logged in).
                    let _ = stdin.write_all(&message).await;
                    let _ = stdin.shutdown().await;
                }
            };
            let read = async {
                let mut events = Events {
                    hook,
                    ..Events::default()
                };
                if let Some(stdout) = stdout {
                    events.read(stdout).await;
                }
                events
            };
            let ((), events) = tokio::join!(write, read);
            let status = tokio::time::timeout(AFTER_RESULT, child.wait())
                .await
                .ok()
                .and_then(Result::ok);
            (events, status)
        };
        let outcome = tokio::select! {
            done = work => Ok(done),
            () = tokio::time::sleep(timeout) => Err(AgentError::Timeout),
            _ = cancel => Err(AgentError::Cancelled),
        };
        let (events, status) = match outcome {
            Ok(done) => done,
            Err(error) => {
                // The tree first: the child is still alive to find it by.
                tree.kill();
                let _ = child.kill().await;
                return Err(error);
            }
        };
        if status.is_none() {
            // Still running after its output ended: nothing more to wait for.
            tree.kill();
            let _ = child.kill().await;
        }
        let duration = started.elapsed();
        let stderr = if events.result.is_none() {
            stderr.finish(process::OUTPUT_TAIL).await
        } else {
            String::new()
        };
        events.reply(duration, status, &stderr, output)
    }
}

impl Agent for ClaudeCodeCli {
    fn run(&self, request: AgentRequest, cancel: oneshot::Receiver<()>) -> AgentFuture<'_> {
        Box::pin(self.call(request, cancel))
    }
}

/// The last `rate_limit_event`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct RateLimit {
    rejected: bool,
    utilization: Option<f64>,
    resets_at: Option<i64>,
    windows: WindowShares,
}

impl RateLimit {
    /// `rate_limit_info` (CLI 2.1.316): `status` (`allowed`,
    /// `allowed_warning`, `rejected`), `resetsAt` in Unix seconds for the
    /// window in `rateLimitType`, and `unifiedWindows.{five_hour,seven_day}`
    /// each with `utilization`, `resetsAt`, `status`.
    fn of(info: &Value) -> Self {
        let windows = info
            .get("unifiedWindows")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|windows| windows.values());
        let fullest = windows
            .filter_map(|window| Some((window.get("utilization")?.as_f64()?, window)))
            .max_by(|(a, _), (b, _)| a.total_cmp(b));
        let utilization = fullest
            .map(|(utilization, _)| utilization)
            .or_else(|| info.get("utilization").and_then(Value::as_f64));
        let resets_at = info
            .get("resetsAt")
            .or_else(|| fullest.and_then(|(_, window)| window.get("resetsAt")))
            .and_then(Value::as_i64)
            .map(unix_ms);
        let window = |name: &str| {
            let window = info.pointer(&format!("/unifiedWindows/{name}"))?;
            Some(WindowShare {
                used: window.get("utilization")?.as_f64()?,
                resets_at: window.get("resetsAt").and_then(Value::as_i64).map(unix_ms),
            })
        };
        Self {
            rejected: info.get("status").and_then(Value::as_str) == Some("rejected"),
            utilization,
            resets_at,
            windows: WindowShares {
                session: window("five_hour"),
                week: window("seven_day"),
            },
        }
    }
}

/// Seconds (what the CLI sends) to ms; a value already in ms stays.
const fn unix_ms(value: i64) -> i64 {
    if value < 100_000_000_000 {
        value.saturating_mul(1000)
    } else {
        value
    }
}

/// What a call's `stream-json` said.
#[derive(Debug, Default)]
struct Events {
    result: Option<Value>,
    rate_limit: Option<RateLimit>,
    hook: Option<OutputHook>,
    /// The last phase told to the hook.
    phase: Option<OutputPhase>,
}

impl Events {
    /// Lines until EOF; after the `result` only for [`AFTER_RESULT`] more
    /// (a child left behind may keep the pipe open).
    async fn read(&mut self, stdout: impl AsyncRead + Unpin) {
        let mut reader = BufReader::new(stdout);
        let mut line = Vec::new();
        let mut deadline = None;
        loop {
            line.clear();
            let read = reader.read_until(b'\n', &mut line);
            let read = match deadline {
                Some(deadline) => match tokio::time::timeout_at(deadline, read).await {
                    Ok(read) => read,
                    Err(_) => break,
                },
                None => read.await,
            };
            if !matches!(read, Ok(1..)) {
                break;
            }
            self.line(&String::from_utf8_lossy(&line));
            if deadline.is_none() && self.result.is_some() {
                deadline = Some(tokio::time::Instant::now() + AFTER_RESULT);
            }
        }
    }

    /// One line; not JSON or not an event we use is skipped.
    fn line(&mut self, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else {
            return;
        };
        match event.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                if let Some(phase) = phase_of(event.get("event").unwrap_or(&Value::Null)) {
                    self.reached(phase);
                }
            }
            Some("assistant") if calls_structured_output(&event) => {
                self.reached(OutputPhase::Writing);
            }
            Some("result") if self.result.is_none() => self.result = Some(event),
            Some("rate_limit_event") => {
                if let Some(info) = event.get("rate_limit_info") {
                    self.rate_limit = Some(RateLimit::of(info));
                }
            }
            _ => {}
        }
    }

    /// Tells the hook about `phase` and the phases before it, once each.
    fn reached(&mut self, phase: OutputPhase) {
        let order = [OutputPhase::Reading, OutputPhase::Writing];
        let done = self
            .phase
            .and_then(|seen| order.iter().position(|item| *item == seen))
            .map_or(0, |index| index + 1);
        let Some(target) = order.iter().position(|item| *item == phase) else {
            return;
        };
        for next in order.iter().take(target + 1).skip(done) {
            self.phase = Some(*next);
            if let Some(hook) = &self.hook {
                (hook.0)(*next);
            }
        }
    }

    #[cfg(test)]
    fn parse(text: &str) -> Self {
        let mut events = Self::default();
        for line in text.lines() {
            events.line(line);
        }
        events
    }

    fn reply(
        self,
        duration: Duration,
        status: Option<ExitStatus>,
        stderr: &str,
        output: OutputKind,
    ) -> Result<AgentReply, AgentError> {
        let rate_limit = self.rate_limit.unwrap_or_default();
        let Some(result) = self.result else {
            return Err(without_result(status, stderr, rate_limit));
        };
        let failed = result.get("is_error").and_then(Value::as_bool) == Some(true)
            || result
                .get("subtype")
                .and_then(Value::as_str)
                .is_some_and(|subtype| subtype != "success");
        if failed {
            return Err(failure(&result, rate_limit));
        }
        let patch = match (result.get("structured_output"), output) {
            (Some(patch), OutputKind::Patch) if patch.get("ops").is_some_and(Value::is_array) => {
                patch.clone()
            }
            (Some(object), OutputKind::Object) if object.is_object() => object.clone(),
            (Some(other), OutputKind::Object) => {
                return Err(AgentError::InvalidOutput(format!(
                    "structured_output не объект: {}",
                    clip(&other.to_string())
                )));
            }
            (Some(other), OutputKind::Patch) => {
                return Err(AgentError::InvalidOutput(format!(
                    "structured_output без ops: {}",
                    clip(&other.to_string())
                )));
            }
            (None, _) => {
                return Err(AgentError::InvalidOutput(format!(
                    "нет structured_output: {}",
                    clip(&message(&result))
                )));
            }
        };
        Ok(AgentReply {
            patch,
            usage: usage(&result, duration, rate_limit),
            raw: result.to_string(),
        })
    }
}

/// The phase a `stream_event` starts: a delta of any block is reading, of
/// the `StructuredOutput` input (or that block's start) writing.
fn phase_of(event: &Value) -> Option<OutputPhase> {
    match event.get("type").and_then(Value::as_str)? {
        "content_block_delta" => {
            let delta = event.pointer("/delta/type").and_then(Value::as_str);
            Some(if delta == Some("input_json_delta") {
                OutputPhase::Writing
            } else {
                OutputPhase::Reading
            })
        }
        "content_block_start" => {
            let block = event.get("content_block")?;
            let structured = block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some("StructuredOutput");
            structured.then_some(OutputPhase::Writing)
        }
        _ => None,
    }
}

/// An `assistant` message with the `StructuredOutput` call.
fn calls_structured_output(event: &Value) -> bool {
    event
        .pointer("/message/content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|block| {
            block.get("type").and_then(Value::as_str) == Some("tool_use")
                && block.get("name").and_then(Value::as_str) == Some("StructuredOutput")
        })
}

/// `result.usage`, `total_cost_usd` and the limit.
fn usage(result: &Value, duration: Duration, rate_limit: RateLimit) -> Usage {
    let tokens = |name: &str| {
        result
            .pointer(&format!("/usage/{name}"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    Usage {
        duration_ms: u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        input_tokens: tokens("input_tokens"),
        output_tokens: tokens("output_tokens"),
        cache_read: tokens("cache_read_input_tokens"),
        cache_write: tokens("cache_creation_input_tokens"),
        cost_usd: result.get("total_cost_usd").and_then(Value::as_f64),
        utilization: rate_limit.utilization,
        resets_at: rate_limit.resets_at,
        windows: rate_limit.windows,
    }
}

/// The text of an error result: `result`, else `errors`, else `subtype`.
fn message(result: &Value) -> String {
    if let Some(text) = result.get("result").and_then(Value::as_str)
        && !text.trim().is_empty()
    {
        return text.trim().to_owned();
    }
    let errors: Vec<&str> = result
        .get("errors")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !errors.is_empty() {
        return errors.join("; ");
    }
    result
        .get("subtype")
        .and_then(Value::as_str)
        .unwrap_or("пустой ответ")
        .to_owned()
}

/// What the CLI says when it can't use the login (`Not logged in · Please
/// run /login`, an expired OAuth token, a bad key).
fn says_not_logged_in(text: &str) -> bool {
    let text = text.to_lowercase();
    [
        "not logged in",
        "please run /login",
        "invalid api key",
        "oauth token has expired",
        "authentication_error",
        "authentication_failed",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// `You've hit your limit · resets 7pm`, older `Claude AI usage limit
/// reached|<unix seconds>`, an API 429.
fn says_rate_limited(text: &str) -> bool {
    let text = text.to_lowercase();
    [
        "hit your limit",
        "usage limit",
        "rate limit",
        "rate_limit",
        "limit reached",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

/// `…limit reached|1793641200` → ms.
fn reset_in_text(text: &str) -> Option<i64> {
    let (_, tail) = text.trim().rsplit_once('|')?;
    tail.trim().parse().ok().map(unix_ms)
}

fn failure(result: &Value, rate_limit: RateLimit) -> AgentError {
    let text = message(result);
    let api_status = result.get("api_error_status").and_then(Value::as_u64);
    if api_status == Some(401) || says_not_logged_in(&text) {
        return AgentError::NotLoggedIn;
    }
    if rate_limit.rejected || api_status == Some(429) || says_rate_limited(&text) {
        return AgentError::RateLimited {
            resets_at: rate_limit.resets_at.or_else(|| reset_in_text(&text)),
        };
    }
    if let Some(status) = api_status {
        // The API failed (overloaded, 5xx): not the model's output.
        return AgentError::Process(format!("Ошибка API ({status}): {}", clip(&text)));
    }
    AgentError::InvalidOutput(clip(&text))
}

/// The CLI ended (or closed its output) without a `result` line.
fn without_result(status: Option<ExitStatus>, stderr: &str, rate_limit: RateLimit) -> AgentError {
    let detail = process::strip_ansi(stderr.trim());
    if says_not_logged_in(&detail) {
        return AgentError::NotLoggedIn;
    }
    if rate_limit.rejected || says_rate_limited(&detail) {
        return AgentError::RateLimited {
            resets_at: rate_limit.resets_at.or_else(|| reset_in_text(&detail)),
        };
    }
    let code = status
        .and_then(|status| status.code())
        .map_or_else(String::new, |code| format!(" (код {code})"));
    let mut message = format!("Claude Code завершился без результата{code}");
    if !detail.is_empty() {
        message.push_str(":\n");
        message.push_str(&clip(&detail));
    }
    AgentError::Process(message)
}

fn clip(text: &str) -> String {
    match text.char_indices().nth(DETAIL_CHARS) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests;

/// Against a fake `claude` script in a temp folder, never the real CLI.
#[cfg(all(test, unix))]
mod fake_cli_tests;
