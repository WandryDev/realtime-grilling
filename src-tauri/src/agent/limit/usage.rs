//! The free poll of the subscription limit (agent-limit-guard design.md,
//! decision 2): `claude -p "/usage"` is a local command of the CLI, no
//! model call, no tokens. Its text is not documented, so the parser is
//! strict: a text it doesn't know is an error, and the measures stay.
//!
//! The CLI writes its times in the zone of the process; the poll runs it
//! with `TZ=UTC`, so a line reads
//! `Current session: 42% used · resets Nov 24 at 5:10pm (UTC)`.

use std::{path::Path, process::Stdio, time::Duration};

use chrono::{DateTime, Datelike as _, Duration as Days, NaiveDate, NaiveDateTime, NaiveTime};
use serde_json::Value;

use crate::agent::{
    claude_cli::{WindowShare, WindowShares},
    process::{self, RunError, TreeSlot},
};

/// A poll that hasn't answered by then is killed.
pub const TIMEOUT: Duration = Duration::from_secs(15);

const SESSION: &str = "Current session:";
const WEEK: &str = "Current week (all models):";
const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
/// A reset this long before now is a date of next year (the text has no
/// year; a reset is always ahead, within a week).
const PAST_SLACK_MS: i64 = 24 * 60 * 60 * 1000;

/// The poll's arguments: no user settings, MCP or session history. Not
/// `--bare` (it has no subscription login) and not
/// `--disable-slash-commands` (`/usage` is one).
pub const ARGS: [&str; 8] = [
    "-p",
    "/usage",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--output-format",
    "json",
];

/// Runs the poll and reads both windows; `now_ms` places the dates the
/// text gives without a year. Its process tree is kept in `slot`.
pub async fn poll(
    cli: &Path,
    cwd: &Path,
    slot: &TreeSlot,
    timeout: Duration,
    now_ms: impl FnOnce() -> i64,
) -> Result<WindowShares, String> {
    let mut command = process::cli(cli, cwd);
    command.args(ARGS).env("TZ", "UTC").stdin(Stdio::null());
    let output = match process::run_in(command, timeout, slot).await {
        Ok(output) => output,
        Err(RunError::Timeout) => return Err("Claude Code не ответил на /usage".to_owned()),
        Err(RunError::Spawn(error)) => {
            return Err(format!("Не удалось запустить Claude Code: {error}"));
        }
    };
    if !output.status.success() {
        let detail = process::strip_ansi(output.stderr.trim());
        return Err(format!("/usage завершился с ошибкой: {detail}"));
    }
    parse_output(&output.stdout, now_ms())
}

/// The CLI's JSON `result` of `/usage`, read by [`parse`].
pub fn parse_output(stdout: &str, now_ms: i64) -> Result<WindowShares, String> {
    let start = stdout.find('{').ok_or("в ответе /usage нет JSON")?;
    let end = stdout.rfind('}').ok_or("в ответе /usage нет JSON")?;
    let reply: Value = stdout
        .get(start..=end)
        .and_then(|json| serde_json::from_str(json).ok())
        .ok_or("ответ /usage не JSON")?;
    if reply.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err("Claude Code ответил на /usage ошибкой".to_owned());
    }
    let text = reply
        .get("result")
        .and_then(Value::as_str)
        .ok_or("в ответе /usage нет текста")?;
    parse(text, now_ms)
}

/// Both windows from the text of `/usage`; an error when either line is
/// missing or reads otherwise than expected.
pub fn parse(text: &str, now_ms: i64) -> Result<WindowShares, String> {
    let line = |prefix: &str| {
        text.lines()
            .map(str::trim)
            .find_map(|line| line.strip_prefix(prefix))
            .ok_or_else(|| format!("в ответе /usage нет строки «{prefix}»"))
            .and_then(|rest| {
                window(rest, now_ms).ok_or_else(|| format!("не разобрана строка «{prefix}{rest}»"))
            })
    };
    Ok(WindowShares {
        session: Some(line(SESSION)?),
        week: Some(line(WEEK)?),
    })
}

/// `42% used · resets Nov 24 at 5:10pm (UTC)`; without `· resets …` the
/// reset is not known.
fn window(rest: &str, now_ms: i64) -> Option<WindowShare> {
    let (share, reset) = match rest.split_once('·') {
        Some((share, reset)) => (share, Some(reset)),
        None => (rest, None),
    };
    let percent: f64 = share
        .trim()
        .strip_suffix("used")?
        .trim()
        .strip_suffix('%')?
        .trim()
        .parse()
        .ok()?;
    if !(0.0..=100.0).contains(&percent) {
        return None;
    }
    let resets_at = match reset {
        Some(reset) => Some(reset_time(reset.trim(), now_ms)?),
        None => None,
    };
    Some(WindowShare {
        used: percent / 100.0,
        resets_at,
    })
}

/// `resets Nov 24 at 5:10pm (UTC)` or `resets 5pm (UTC)` → Unix ms: the
/// nearest such moment ahead of `now_ms`.
fn reset_time(text: &str, now_ms: i64) -> Option<i64> {
    let when = text
        .strip_prefix("resets")?
        .trim()
        .strip_suffix("(UTC)")?
        .trim();
    let now = DateTime::from_timestamp_millis(now_ms)?.naive_utc();
    let (date, time) = match when.split_once(" at ") {
        Some((date, time)) => (Some(date.trim()), time.trim()),
        None => (None, when),
    };
    let time = clock(time)?;
    let at = match date {
        Some(date) => {
            let (month, day) = month_day(date)?;
            let this_year = at(now.year(), month, day, time)?;
            if ms(this_year) < now_ms - PAST_SLACK_MS {
                at(now.year() + 1, month, day, time)?
            } else {
                this_year
            }
        }
        None => {
            let today = now.date().and_time(time);
            if today < now {
                today + Days::days(1)
            } else {
                today
            }
        }
    };
    Some(ms(at))
}

fn at(year: i32, month: u32, day: u32, time: NaiveTime) -> Option<NaiveDateTime> {
    Some(NaiveDate::from_ymd_opt(year, month, day)?.and_time(time))
}

fn ms(at: NaiveDateTime) -> i64 {
    at.and_utc().timestamp_millis()
}

/// `Nov 24` → (11, 24).
fn month_day(date: &str) -> Option<(u32, u32)> {
    let (month, day) = date.split_once(' ')?;
    let month = month.trim().to_lowercase();
    let index = MONTHS
        .iter()
        .position(|name| month.get(..3) == Some(*name))?;
    let day = day.trim().parse().ok()?;
    Some((u32::try_from(index).ok()? + 1, day))
}

/// `5:10pm`, `11pm`, `12am` → the time of day.
fn clock(text: &str) -> Option<NaiveTime> {
    let text = text.to_lowercase();
    let (time, afternoon) = if let Some(time) = text.strip_suffix("pm") {
        (time, true)
    } else {
        (text.strip_suffix("am")?, false)
    };
    let (hour, minute) = match time.trim().split_once(':') {
        Some((hour, minute)) => (hour.parse::<u32>().ok()?, minute.parse::<u32>().ok()?),
        None => (time.trim().parse::<u32>().ok()?, 0),
    };
    if !(1..=12).contains(&hour) {
        return None;
    }
    let hour = match (hour, afternoon) {
        (12, false) => 0,
        (12, true) => 12,
        (hour, true) => hour + 12,
        (hour, false) => hour,
    };
    NaiveTime::from_hms_opt(hour, minute, 0)
}
