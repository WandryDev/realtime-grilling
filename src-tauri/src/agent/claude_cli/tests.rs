//! The `stream-json` parser on fixture lines, without a process.
//!
//! Fixtures (`fixtures/*.jsonl`), one event per line:
//! - `success.jsonl`: a call captured by the agent spike (run
//!   `H-sonnet-min-schema-rec`, k4, Claude Code 2.1.316, Sonnet, minimal
//!   mode with `--json-schema`). Kept: every event type in order, ids,
//!   usage, cost, `rate_limit_event`. Trimmed: init fields, thinking
//!   signatures; the patch is redone in this change's protocol.
//! - `empty_patch.jsonl`, `not_a_patch.jsonl`: the same envelope; the
//!   second is a text answer without the `StructuredOutput` call (the case
//!   the spike's closing phrase prevents).
//! - `not_logged_in.jsonl`, `rate_limited.jsonl`: reconstructed, the spike
//!   never got these. The CLI answers both with a synthetic assistant
//!   message (`model: "<synthetic>"`) and a `result` with `is_error: true`;
//!   "Not logged in" is what the spike's `--bare` probe printed. Replace
//!   them with real captures when a logged-out or limited CLI is at hand.

use std::time::Duration;

use serde_json::json;

use super::{
    AgentError, Events, OutputKind, RateLimit, Usage, WindowShare, WindowShares, reset_in_text,
};

pub const SUCCESS: &str = include_str!("fixtures/success.jsonl");
pub const EMPTY_PATCH: &str = include_str!("fixtures/empty_patch.jsonl");
pub const NOT_A_PATCH: &str = include_str!("fixtures/not_a_patch.jsonl");
pub const NOT_LOGGED_IN: &str = include_str!("fixtures/not_logged_in.jsonl");
pub const RATE_LIMITED: &str = include_str!("fixtures/rate_limited.jsonl");

const ELAPSED: Duration = Duration::from_millis(13_480);
/// `resetsAt` 1793623200 s of the fixtures.
const RESETS_AT_MS: i64 = 1_793_623_200_000;
/// The week's `resetsAt` 1793970000 s of the fixtures.
const WEEK_RESETS_AT_MS: i64 = 1_793_970_000_000;

fn reply(stream: &str) -> Result<super::AgentReply, AgentError> {
    Events::parse(stream).reply(ELAPSED, None, "", OutputKind::Patch)
}

#[test]
fn success_gives_the_patch_and_the_usage() {
    let reply = reply(SUCCESS).unwrap();
    assert_eq!(reply.patch["ops"][0]["op"], "question");
    assert_eq!(reply.patch["ops"][0]["cardField"], "scenarios");
    assert_eq!(
        reply.usage,
        Usage {
            duration_ms: 13_480,
            input_tokens: 2,
            output_tokens: 1464,
            cache_read: 1292,
            cache_write: 10_049,
            cost_usd: Some(0.054_969_2),
            utilization: Some(0.24),
            resets_at: Some(RESETS_AT_MS),
            windows: WindowShares {
                session: Some(WindowShare {
                    used: 0.24,
                    resets_at: Some(RESETS_AT_MS),
                }),
                week: Some(WindowShare {
                    used: 0.1,
                    resets_at: Some(WEEK_RESETS_AT_MS),
                }),
            },
        }
    );
}

#[test]
fn an_empty_patch_is_a_reply() {
    let reply = reply(EMPTY_PATCH).unwrap();
    assert_eq!(reply.patch, json!({ "ops": [] }));
    assert_eq!(reply.usage.utilization, Some(0.82));
    assert_eq!(reply.usage.cache_write, 6120);
}

#[test]
fn a_text_answer_is_invalid_output() {
    let Err(AgentError::InvalidOutput(message)) = reply(NOT_A_PATCH) else {
        panic!("not invalid output");
    };
    assert!(message.contains("Новых фактов"), "{message}");
}

#[test]
fn structured_output_without_ops_is_invalid_output() {
    let stream = r#"{"type":"result","subtype":"success","is_error":false,"structured_output":{"questions":[]}}"#;
    assert!(matches!(reply(stream), Err(AgentError::InvalidOutput(_))));
    let stream =
        r#"{"type":"result","subtype":"success","is_error":false,"structured_output":"{}"}"#;
    assert!(matches!(reply(stream), Err(AgentError::InvalidOutput(_))));
}

#[test]
fn not_logged_in_is_recognized() {
    assert_eq!(reply(NOT_LOGGED_IN), Err(AgentError::NotLoggedIn));
    let stderr = "Invalid API key · Please run /login\n";
    assert_eq!(
        Events::default().reply(ELAPSED, None, stderr, OutputKind::Patch),
        Err(AgentError::NotLoggedIn)
    );
}

#[test]
fn rate_limited_carries_the_reset_time() {
    assert_eq!(
        reply(RATE_LIMITED),
        Err(AgentError::RateLimited {
            resets_at: Some(1_793_641_200_000)
        })
    );
    // An older CLI: no event, the reset in the text.
    let stream = r#"{"type":"result","subtype":"success","is_error":true,"result":"Claude AI usage limit reached|1793641200"}"#;
    assert_eq!(
        reply(stream),
        Err(AgentError::RateLimited {
            resets_at: Some(1_793_641_200_000)
        })
    );
    assert_eq!(reset_in_text("You've hit your limit · resets 7pm"), None);
}

#[test]
fn a_rejected_call_still_tells_both_windows() {
    let limit = Events::parse(RATE_LIMITED).rate_limit.unwrap();
    assert!(limit.rejected);
    assert_eq!(
        limit.windows,
        WindowShares {
            session: Some(WindowShare {
                used: 1.0,
                resets_at: Some(1_793_641_200_000),
            }),
            week: Some(WindowShare {
                used: 0.31,
                resets_at: Some(WEEK_RESETS_AT_MS),
            }),
        }
    );
}

#[test]
fn other_errors_are_invalid_output_or_process() {
    let stream = r#"{"type":"result","subtype":"error_max_structured_output_retries","is_error":true,"errors":["Failed to provide valid structured output after 5 attempts"]}"#;
    let Err(AgentError::InvalidOutput(message)) = reply(stream) else {
        panic!("not invalid output");
    };
    assert!(message.contains("structured output"), "{message}");

    let stream = r#"{"type":"result","subtype":"success","is_error":true,"api_error_status":529,"result":"API Error: 529 Overloaded"}"#;
    assert!(matches!(reply(stream), Err(AgentError::Process(_))));
}

#[test]
fn unknown_events_and_garbage_are_skipped() {
    let stream = format!(
        "Warning: something on stdout\n\n{{\"type\":\"brand_new_event\",\"x\":1}}\n[1,2]\n{{\"type\":\"result\"\n{SUCCESS}"
    );
    assert_eq!(reply(&stream), reply(SUCCESS));
}

#[test]
fn no_result_is_a_process_error_with_stderr() {
    let Err(AgentError::Process(message)) =
        Events::parse("").reply(ELAPSED, None, "\u{1b}[31mboom\u{1b}[0m", OutputKind::Patch)
    else {
        panic!("not a process error");
    };
    assert!(message.ends_with("boom"), "{message}");
}

#[test]
fn the_fullest_limit_window_counts() {
    let info = json!({
        "status": "allowed_warning",
        "resetsAt": 1_793_970_000,
        "rateLimitType": "seven_day",
        "unifiedWindows": {
            "five_hour": { "utilization": 0.3, "resetsAt": 1_793_623_200 },
            "seven_day": { "utilization": 0.91, "resetsAt": 1_793_970_000 }
        }
    });
    assert_eq!(
        RateLimit::of(&info),
        RateLimit {
            rejected: false,
            utilization: Some(0.91),
            resets_at: Some(1_793_970_000_000),
            windows: WindowShares {
                session: Some(WindowShare {
                    used: 0.3,
                    resets_at: Some(RESETS_AT_MS),
                }),
                week: Some(WindowShare {
                    used: 0.91,
                    resets_at: Some(WEEK_RESETS_AT_MS),
                }),
            },
        }
    );
    assert_eq!(RateLimit::of(&json!({})), RateLimit::default());
    // A window without its share is not known.
    let partial = json!({ "unifiedWindows": { "five_hour": { "resetsAt": 1 } } });
    assert!(RateLimit::of(&partial).windows.is_empty());
}

/// The phases the hook hears on a stream, in order.
fn phases(stream: &str) -> Vec<super::OutputPhase> {
    let heard = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = std::sync::Arc::clone(&heard);
    let mut events = Events {
        hook: Some(super::OutputHook::new(move |phase| {
            sink.lock().unwrap().push(phase);
        })),
        ..Events::default()
    };
    for line in stream.lines() {
        events.line(line);
    }
    heard.lock().unwrap().clone()
}

#[test]
fn the_hook_hears_reading_then_writing_once_each() {
    use super::OutputPhase::{Reading, Writing};
    // The spike's call: a thinking delta, then the StructuredOutput block.
    assert_eq!(phases(SUCCESS), [Reading, Writing]);
    // The tool call straight away still reads first.
    let tool_first = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"StructuredOutput","input":{}}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}}"#;
    assert_eq!(phases(tool_first), [Reading, Writing]);
    // Only the assistant message with the call (no partial messages).
    let message_only = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":{}}]}}"#;
    assert_eq!(phases(message_only), [Reading, Writing]);
    // Text only: reading, never writing.
    let text = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}}"#;
    assert_eq!(phases(text), [Reading]);
}

#[test]
fn an_object_output_takes_any_object_but_nothing_else() {
    let result = |output: &str| {
        format!(
            r#"{{"type":"result","subtype":"success","is_error":false,"structured_output":{output}}}"#
        )
    };
    let brief = result(r#"{"product":"Звонки","stack":[]}"#);
    let reply = Events::parse(&brief)
        .reply(ELAPSED, None, "", OutputKind::Object)
        .unwrap();
    assert_eq!(reply.patch["product"], "Звонки");
    // The fast loop's check stays: no ops, no patch.
    assert!(matches!(
        Events::parse(&brief).reply(ELAPSED, None, "", OutputKind::Patch),
        Err(AgentError::InvalidOutput(_))
    ));
    for not_an_object in ["[1]", "\"текст\"", "null"] {
        assert!(matches!(
            Events::parse(&result(not_an_object)).reply(ELAPSED, None, "", OutputKind::Object),
            Err(AgentError::InvalidOutput(_))
        ));
    }
}
