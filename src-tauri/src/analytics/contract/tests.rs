//! The contract exported for the server and the web (call-analytics task
//! 3.1): the TypeScript types and a sample of each event. CI fails when
//! they are stale (`git diff --exit-code analytics/contract`).

use std::path::{Path, PathBuf};

use serde_json::json;
use specta_typescript::Typescript;

use super::*;

/// `analytics/contract` of the repository.
fn contract_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("analytics")
        .join("contract")
}

const AT: i64 = 1_795_000_000_000;

fn envelope(n: u32, event: Event) -> Envelope {
    Envelope {
        id: format!("0193f2a1-7c4e-7b1a-9f02-{n:012}"),
        v: VERSION,
        at: AT + i64::from(n) * 1_000,
        event,
    }
}

/// One event of each kind: what a call with Outline produces.
fn samples() -> Vec<Envelope> {
    let evidence =
        json!([{ "source": "segment", "id": "seg-2", "quote": "звонок встаёт в очередь" }]);
    vec![
        envelope(
            1,
            Event::Project(ProjectEvent {
                local_id: "proj-1".to_owned(),
                name: "Обменник".to_owned(),
            }),
        ),
        envelope(
            2,
            Event::Call(CallEvent {
                id: "call-1".to_owned(),
                project_local_id: Some("proj-1".to_owned()),
                title: "KYC для юрлиц".to_owned(),
                status: CallStatus::Finished,
                started_at: Some(AT),
                ended_at: Some(AT + 4_440_000),
            }),
        ),
        envelope(
            3,
            Event::Recording(RecordingEvent {
                id: "rec-1".to_owned(),
                call_id: Some("call-1".to_owned()),
                status: RecordingStatus::Finished,
                started_at: AT,
                ended_at: Some(AT + 4_440_000),
            }),
        ),
        envelope(
            4,
            Event::Segment(SegmentEvent {
                id: "seg-2".to_owned(),
                recording_id: "rec-1".to_owned(),
                channel: Channel::Others,
                start_ms: 61_000,
                end_ms: 64_500,
                text: "Если все заняты, звонок встаёт в очередь".to_owned(),
            }),
        ),
        envelope(
            5,
            Event::RefinedTranscript(RefinedTranscriptEvent {
                recording_id: "rec-1".to_owned(),
                segments: vec![RefinedSegment {
                    id: "ref-1".to_owned(),
                    channel: Channel::Others,
                    start_ms: 61_000,
                    end_ms: 64_400,
                    text: "Если все заняты, звонок встаёт в очередь.".to_owned(),
                }],
            }),
        ),
        envelope(
            6,
            Event::Topic(TopicEvent {
                id: "topic-1".to_owned(),
                recording_id: "rec-1".to_owned(),
                title: "Очередь операторов".to_owned(),
                created_at: AT + 70_000,
            }),
        ),
        envelope(
            7,
            Event::Card(CardEvent {
                id: "card-1".to_owned(),
                topic_id: "topic-1".to_owned(),
                recording_id: "rec-1".to_owned(),
                fields: json!([{ "field": "edgeCases", "value": "Все операторы заняты", "evidence": evidence }]),
            }),
        ),
        envelope(
            8,
            Event::Question(QuestionEvent {
                id: "q-1".to_owned(),
                recording_id: "rec-1".to_owned(),
                topic_id: Some("topic-1".to_owned()),
                text: "Сколько ждёт звонок в очереди?".to_owned(),
                description: "Клиент не назвал предел".to_owned(),
                card_field: Some("edgeCases".to_owned()),
                gap_type: "empty".to_owned(),
                priority: 3,
                evidence,
                answer_evidence: None,
                status: QuestionStatus::Open,
                pinned: true,
                shown_at: Some(AT + 71_000),
                created_at: AT + 70_000,
            }),
        ),
        envelope(
            9,
            Event::QuestionStep(QuestionStepEvent {
                id: "qe-1".to_owned(),
                question_id: "q-1".to_owned(),
                recording_id: "rec-1".to_owned(),
                step: QuestionStepKind::Pinned,
                agent_call_id: None,
                at: AT + 300_000,
            }),
        ),
        envelope(
            10,
            Event::Finding(FindingEvent {
                id: "f-1".to_owned(),
                recording_id: "rec-1".to_owned(),
                source_kind: SourceKind::Outline,
                source_name: "Регламент KYC".to_owned(),
                source_url: Some("https://outline.example/doc/kyc".to_owned()),
                chunk_key: "src-1#3".to_owned(),
                quote: "Проверка длится до трёх рабочих дней".to_owned(),
                note: "Дополняет: срок проверки".to_owned(),
                question_id: Some("q-1".to_owned()),
                agent_call_id: Some("ac-2".to_owned()),
                created_at: AT + 120_000,
                hidden_at: None,
                evicted_at: None,
            }),
        ),
        envelope(
            11,
            Event::FindingStep(FindingStepEvent {
                id: "fe-1".to_owned(),
                finding_id: "f-1".to_owned(),
                recording_id: "rec-1".to_owned(),
                step: FindingStepKind::Shown,
                at: AT + 120_000,
            }),
        ),
        envelope(
            12,
            Event::PromptPart(PromptPartEvent {
                hash: "9f2c1d6a0b7e4c3d2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b"
                    .to_owned(),
                text: "Ты помощник аналитика на звонке.".to_owned(),
            }),
        ),
        envelope(
            13,
            Event::AgentCall(Box::new(AgentCallEvent {
                id: "ac-1".to_owned(),
                kind: AgentCallKind::FastLoop,
                recording_id: Some("rec-1".to_owned()),
                call_id: None,
                project_local_id: None,
                started_at: AT + 65_000,
                duration_ms: 9_800,
                outcome: AgentCallOutcome::Ok,
                input_tokens: Some(2),
                output_tokens: Some(640),
                cache_read: Some(31_000),
                cache_write: Some(1_200),
                cost_usd: Some(0.042),
                utilization: Some(0.31),
                error: None,
                model: None,
                effort: None,
                trigger: Some(CallTrigger::TurnEnd),
                trigger_segment_id: Some("seg-2".to_owned()),
                window_segments: Some(vec!["seg-1".to_owned(), "seg-2".to_owned()]),
                findings_in_prompt: Some(Vec::new()),
                queries: None,
                raw_reply: Some(
                    "{\"type\":\"result\",\"subtype\":\"success\",\"structured_output\":{\"ops\":[]}}"
                        .to_owned(),
                ),
                reply: Some(json!({ "ops": [] })),
                parts: vec![PromptPartRef {
                    label: "file".to_owned(),
                    hash: "9f2c1d6a0b7e4c3d2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b"
                        .to_owned(),
                }],
                candidates: Vec::new(),
            })),
        ),
        envelope(
            14,
            Event::AgentCallOp(AgentCallOpEvent {
                agent_call_id: "ac-1".to_owned(),
                idx: 1,
                op: "question".to_owned(),
                body: json!({ "op": "question", "title": "Сколько ждёт звонок в очереди?" }),
                applied: false,
                reason: Some(json!({ "reason": "repeat", "of": "q-0", "score": 0.91 })),
                subject_kind: None,
                subject_id: None,
            }),
        ),
    ]
}

/// Every kind of [`Event`] has a sample.
#[test]
fn every_kind_has_a_sample() {
    let kinds: std::collections::BTreeSet<&str> =
        samples().iter().map(|sample| sample.event.kind()).collect();
    assert_eq!(kinds.len(), 14);
}

/// The envelope is `{ id, v, at, kind, body }` and reads back the same.
#[test]
fn the_envelope_is_flat_and_round_trips() {
    for sample in samples() {
        let value = serde_json::to_value(&sample).unwrap();
        let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
        // A JSON object: the order is not part of it.
        assert_eq!(keys, ["at", "body", "id", "kind", "v"], "{value}");
        assert_eq!(value["kind"], sample.event.kind());
        let back: Envelope = serde_json::from_value(value).unwrap();
        assert_eq!(back, sample);
    }
}

/// Nothing names the manager (spec `analytics-delivery`, «Что
/// отправляется»).
#[test]
fn no_event_names_the_manager() {
    for sample in samples() {
        let text = serde_json::to_string(&sample).unwrap().to_lowercase();
        for field in ["manager", "email", "\"user", "account"] {
            assert!(!text.contains(field), "{field} in {text}");
        }
    }
}

/// Writes `src/generated.ts` and `fixtures/<kind>.json`.
#[test]
fn export_contract() {
    let dir = contract_dir();
    let types = specta::Types::default().register::<Envelope>();
    Typescript::default()
        .header(
            "// Generated from src-tauri/src/analytics/contract.rs. Do not edit: run \
             `cargo test` in src-tauri to regenerate.\n",
        )
        .export_to(
            dir.join("src").join("generated.ts"),
            &types,
            specta_serde::Format,
        )
        .unwrap();
    let fixtures = dir.join("fixtures");
    std::fs::create_dir_all(&fixtures).unwrap();
    for sample in samples() {
        let mut text = serde_json::to_string_pretty(&sample).unwrap();
        text.push('\n');
        std::fs::write(fixtures.join(format!("{}.json", sample.event.kind())), text).unwrap();
    }
    let generated = std::fs::read_to_string(dir.join("src").join("generated.ts")).unwrap();
    assert!(generated.contains("Envelope"), "{generated}");
}
