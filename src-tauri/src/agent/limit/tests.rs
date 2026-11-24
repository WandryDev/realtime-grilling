//! The text of `/usage` and the share of the limit, on a paused clock.
//!
//! Fixtures (`agent/claude_cli/fixtures/`):
//! - `usage.json`: the reply of CLI 2.1.330 to `TZ=UTC claude -p "/usage"
//!   --output-format json` (2026-11-24), its usage tips shortened;
//! - `usage_high.json`: the same reply with the windows of the design's
//!   check (95 %, 16 %), in UTC.

use std::{sync::Arc, time::Duration};

use chrono::NaiveDate;

use super::{
    Clock, LimitHit, LimitOutlook, LimitThresholds, LimitWindow, MeasureSource, Metered,
    SubscriptionLimit, WindowMeasure,
    usage::{parse, parse_output},
};
use crate::agent::{
    claude_cli::{AgentReply, AgentRequest, Usage, WindowShare, WindowShares},
    fast_loop::testing::{FakeAgent, Step},
};

pub const USAGE: &str = include_str!("../claude_cli/fixtures/usage.json");
pub const USAGE_HIGH: &str = include_str!("../claude_cli/fixtures/usage_high.json");

/// Unix ms of a UTC wall clock.
pub fn utc(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    NaiveDate::from_ymd_opt(year, month, day)
        .unwrap()
        .and_hms_opt(hour, minute, 0)
        .unwrap()
        .and_utc()
        .timestamp_millis()
}

fn share(used: f64, resets_at: i64) -> Option<WindowShare> {
    Some(WindowShare {
        used,
        resets_at: Some(resets_at),
    })
}

#[test]
fn the_cli_reply_gives_both_windows() {
    let now = utc(2026, 11, 24, 16, 0);
    assert_eq!(
        parse_output(USAGE, now).unwrap(),
        WindowShares {
            session: share(0.01, utc(2026, 11, 24, 17, 10)),
            week: share(0.0, utc(2026, 11, 28, 18, 0)),
        }
    );
    let high = parse_output(USAGE_HIGH, utc(2026, 11, 24, 9, 0)).unwrap();
    assert_eq!(
        high,
        WindowShares {
            session: share(0.95, utc(2026, 11, 24, 12, 9)),
            week: share(0.16, utc(2026, 11, 30, 22, 59)),
        }
    );
}

#[test]
fn hours_without_minutes_noon_and_midnight() {
    let now = utc(2026, 11, 24, 8, 0);
    let text = |time: &str| {
        format!(
            "Current session: 5% used · resets Nov 24 at {time} (UTC)\n\
             Current week (all models): 7% used · resets Nov 25 at {time} (UTC)"
        )
    };
    let at = |time: &str| parse(&text(time), now).unwrap().session.unwrap().resets_at;
    assert_eq!(at("11pm"), Some(utc(2026, 11, 24, 23, 0)));
    assert_eq!(at("12pm"), Some(utc(2026, 11, 24, 12, 0)));
    assert_eq!(at("9:05am"), Some(utc(2026, 11, 24, 9, 5)));
    let midnight = parse(&text("12am"), now).unwrap();
    assert_eq!(
        midnight.week.unwrap().resets_at,
        Some(utc(2026, 11, 25, 0, 0))
    );
}

#[test]
fn a_reset_after_new_year_is_next_year() {
    let now = utc(2026, 12, 30, 20, 0);
    let text = "Current session: 40% used · resets Dec 30 at 11pm (UTC)\n\
                Current week (all models): 12% used · resets Jan 2 at 1am (UTC)";
    let shares = parse(text, now).unwrap();
    assert_eq!(
        shares.session.unwrap().resets_at,
        Some(utc(2026, 12, 30, 23, 0))
    );
    assert_eq!(shares.week.unwrap().resets_at, Some(utc(2027, 1, 2, 1, 0)));
}

#[test]
fn a_time_alone_is_the_next_such_time() {
    let now = utc(2026, 11, 24, 22, 0);
    let text = "Current session: 40% used · resets 3am (UTC)\n\
                Current week (all models): 12% used";
    let shares = parse(text, now).unwrap();
    assert_eq!(
        shares.session.unwrap().resets_at,
        Some(utc(2026, 11, 25, 3, 0))
    );
    assert_eq!(
        shares.week,
        Some(WindowShare {
            used: 0.12,
            resets_at: None
        }),
        "no reset said: not known"
    );
}

#[test]
fn a_text_it_does_not_know_is_an_error() {
    let now = utc(2026, 11, 24, 8, 0);
    for text in [
        "",
        "Usage is not available for API key accounts",
        // One window only.
        "Current session: 5% used · resets Nov 24 at 1pm (UTC)",
        // Another zone: the poll asked for UTC.
        "Current session: 5% used · resets Nov 24 at 1pm (Europe/Kiev)\n\
         Current week (all models): 7% used · resets Nov 25 at 1pm (Europe/Kiev)",
        // Another wording.
        "Current session: 5 percent · resets Nov 24 at 1pm (UTC)\n\
         Current week (all models): 7% used · resets Nov 25 at 1pm (UTC)",
        "Current session: 105% used · resets Nov 24 at 1pm (UTC)\n\
         Current week (all models): 7% used · resets Nov 25 at 1pm (UTC)",
        "Current session: 5% used · resets Nov 24 at 13pm (UTC)\n\
         Current week (all models): 7% used · resets Nov 25 at 1pm (UTC)",
    ] {
        assert!(parse(text, now).is_err(), "{text}");
    }
    assert!(parse_output("Not logged in", now).is_err());
    assert!(
        parse_output(
            r#"{"is_error":true,"result":"Current session: 1% used"}"#,
            now
        )
        .is_err()
    );
}

/* The share of the limit */

fn limit(start_ms: i64) -> SubscriptionLimit {
    SubscriptionLimit::new(Clock::paused(start_ms), LimitThresholds::default())
}

fn shares(session: Option<(f64, i64)>, week: Option<(f64, i64)>) -> WindowShares {
    WindowShares {
        session: session.and_then(|(used, at)| share(used, at)),
        week: week.and_then(|(used, at)| share(used, at)),
    }
}

const START: i64 = 1_795_000_000_000;
const HOUR: i64 = 60 * 60 * 1000;

#[tokio::test(start_paused = true)]
async fn no_data_never_stops_the_agent() {
    let limit = limit(START);
    let view = limit.view();
    assert_eq!((view.session, view.week), (None, None));
    assert_eq!(view.outlook, LimitOutlook::Ok);
    assert_eq!(limit.blocks("rec"), None);
}

#[tokio::test(start_paused = true)]
async fn a_call_fresher_than_the_poll_wins() {
    let limit = limit(START);
    limit.observe(
        MeasureSource::Usage,
        shares(
            Some((0.42, START + 2 * HOUR)),
            Some((0.16, START + 90 * HOUR)),
        ),
        START,
    );
    tokio::time::sleep(Duration::from_secs(60)).await;
    let minute_later = START + 60_000;
    limit.observe(
        MeasureSource::Call,
        shares(Some((0.44, START + 2 * HOUR)), None),
        minute_later,
    );
    let view = limit.view();
    assert_eq!(
        view.session,
        Some(WindowMeasure {
            used: 44,
            resets_at: Some(START + 2 * HOUR),
            measured_at: minute_later,
            source: MeasureSource::Call,
        })
    );
    assert_eq!(view.week.unwrap().used, 16, "the week keeps the poll's");

    // A poll that started before the call answers after it: older, ignored.
    limit.observe(
        MeasureSource::Usage,
        shares(Some((0.42, START + 2 * HOUR)), None),
        START + 30_000,
    );
    assert_eq!(limit.view().session.unwrap().used, 44);
}

#[tokio::test(start_paused = true)]
async fn a_reached_threshold_lets_go_at_the_reset() {
    let limit = limit(START);
    let reset = START + HOUR;
    let mut news = limit.subscribe();
    tokio::spawn(limit.clone().watch_resets());
    limit.observe(
        MeasureSource::Call,
        shares(Some((0.91, reset)), Some((0.3, START + 90 * HOUR))),
        START,
    );
    let hit = LimitHit {
        window: LimitWindow::Session,
        used: 91,
        threshold: 90,
        resets_at: Some(reset),
    };
    assert_eq!(limit.blocks("rec"), Some(hit.clone()));
    assert_eq!(limit.outlook(), LimitOutlook::Reached { hit });
    news.borrow_and_update();

    tokio::time::sleep(Duration::from_millis(u64::try_from(HOUR).unwrap())).await;
    tokio::task::yield_now().await;
    assert!(news.has_changed().unwrap(), "the reset is news");
    assert_eq!(limit.blocks("rec"), None);
    let session = limit.view().session.unwrap();
    assert_eq!((session.used, session.resets_at), (0, None));
}

#[tokio::test(start_paused = true)]
async fn a_higher_threshold_lets_go_and_off_never_stops() {
    let limit = limit(START);
    limit.observe(
        MeasureSource::Usage,
        shares(Some((0.91, START + HOUR)), None),
        START,
    );
    assert!(limit.reached().is_some());
    limit.set_thresholds(LimitThresholds {
        session: None,
        week: Some(80),
    });
    assert_eq!(limit.reached(), None);
    assert_eq!(limit.outlook(), LimitOutlook::Ok);
    // A lower threshold during a call stops it.
    limit.set_thresholds(LimitThresholds {
        session: Some(70),
        week: Some(80),
    });
    assert_eq!(limit.reached().unwrap().threshold, 70);
}

#[tokio::test(start_paused = true)]
async fn of_two_reached_windows_the_later_reset_and_of_two_near_the_closer() {
    let limit = limit(START);
    limit.observe(
        MeasureSource::Usage,
        shares(Some((0.93, START + HOUR)), Some((0.85, START + 50 * HOUR))),
        START,
    );
    assert_eq!(
        limit.reached(),
        Some(LimitHit {
            window: LimitWindow::Week,
            used: 85,
            threshold: 80,
            resets_at: Some(START + 50 * HOUR),
        })
    );

    limit.observe(
        MeasureSource::Usage,
        shares(Some((0.82, START + HOUR)), Some((0.75, START + 50 * HOUR))),
        START + 1,
    );
    assert_eq!(
        limit.outlook(),
        LimitOutlook::Near {
            hit: LimitHit {
                window: LimitWindow::Week,
                used: 75,
                threshold: 80,
                resets_at: Some(START + 50 * HOUR),
            }
        },
        "5 points to the week's, 8 to the session's"
    );

    limit.observe(
        MeasureSource::Usage,
        shares(Some((0.6, START + HOUR)), Some((0.3, START + 50 * HOUR))),
        START + 2,
    );
    assert_eq!(limit.outlook(), LimitOutlook::Ok);
}

#[tokio::test(start_paused = true)]
async fn going_over_is_one_recording_and_is_news() {
    let limit = limit(START);
    limit.observe(
        MeasureSource::Call,
        shares(Some((0.95, START + HOUR)), None),
        START,
    );
    let mut news = limit.subscribe();
    news.borrow_and_update();
    limit.allow_over("rec-1");
    assert!(news.has_changed().unwrap());
    assert_eq!(limit.blocks("rec-1"), None);
    assert!(
        limit.blocks("rec-2").is_some(),
        "another recording still stops"
    );
    limit.forget("rec-1");
    assert!(limit.blocks("rec-1").is_some(), "a new start has no flag");
}

#[tokio::test(start_paused = true)]
async fn the_listener_hears_every_change() {
    let limit = limit(START);
    let heard = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = Arc::clone(&heard);
    limit.on_change(Arc::new(move |view| {
        sink.lock().unwrap().push(view.outlook.clone());
    }));
    limit.observe(
        MeasureSource::Usage,
        shares(Some((0.85, START + HOUR)), None),
        START,
    );
    limit.set_thresholds(LimitThresholds {
        session: Some(80),
        week: Some(80),
    });
    let heard = heard.lock().unwrap();
    assert!(matches!(heard[0], LimitOutlook::Near { .. }));
    assert!(matches!(heard[1], LimitOutlook::Reached { .. }));
}

#[tokio::test(start_paused = true)]
async fn every_agent_reply_measures_the_limit() {
    let limit = limit(START);
    let mut step = Step::empty();
    step.usage = Usage {
        windows: shares(Some((0.82, START + HOUR)), Some((0.16, START + 90 * HOUR))),
        ..Usage::default()
    };
    let metered = Metered {
        agent: FakeAgent::new([step]),
        limit: limit.clone(),
    };
    let (_cancel, cancelled) = tokio::sync::oneshot::channel();
    let request = AgentRequest {
        system_prompt_file: std::path::PathBuf::from("/nonexistent/prompt"),
        user_message: String::new(),
        schema: String::new(),
        process: crate::agent::process::TreeSlot::default(),
        options: crate::agent::claude_cli::CallOptions::default(),
    };
    let reply: AgentReply = crate::agent::claude_cli::Agent::run(&metered, request, cancelled)
        .await
        .unwrap();
    assert_eq!(reply.usage.windows.session.unwrap().used, 0.82);
    let view = limit.view();
    let session = view.session.unwrap();
    assert_eq!((session.used, session.source), (82, MeasureSource::Call));
    assert_eq!(view.week.unwrap().used, 16);
}
