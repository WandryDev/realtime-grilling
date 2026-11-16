//! Hand-built corpora and reports for the tests of the judge, the metrics
//! and `compare`.

use serde_json::{Value, json};

use super::{
    corpus::{self, Channels, Corpus, Origin, Project, Recording, Segment},
    report::{self, Flags, Phrase, Report, ReportCall, ReportQuestion, ReportTopic, Run},
};
use crate::storage::{
    call_state::{AgentCallOutcome, CardLens, Evidence, EvidenceSource, GapType, QuestionStatus},
    settings::SettingsMap,
    transcript::TranscriptChannel,
};

pub const MINUTE: i64 = 60_000;
pub const ME: TranscriptChannel = TranscriptChannel::Me;
pub const OTHERS: TranscriptChannel = TranscriptChannel::Others;

/// A segment `id` of 2 s starting at `start_ms` (for the judge's tests,
/// which run a fake `claude` script: Unix only).
#[cfg(unix)]
pub fn segment(id: &str, channel: TranscriptChannel, start_ms: i64, text: &str) -> Segment {
    Segment {
        id: id.to_owned(),
        channel,
        start_ms,
        end_ms: start_ms + 2_000,
        text: text.to_owned(),
    }
}

/// «Телемедиа» with a brief, the live pass `live`, no refined pass.
pub fn corpus(live: Vec<Segment>) -> Corpus {
    Corpus {
        version: corpus::FORMAT,
        name: "telemedia".to_owned(),
        origin: Origin::Export {
            recording_id: "rec".to_owned(),
            exported_at: 0,
        },
        channels: Channels::Real,
        project: Some(Project {
            name: "Телемедиа".to_owned(),
            description: "Единая система приёма звонков для сети клиник".to_owned(),
            notes: String::new(),
            brief: Some(json!({
                "product": "Клиники теряют до половины звонков пациентов",
                "stack": ["Mango Office"],
                "modules": [],
                "glossary": [],
                "keyDocuments": [],
                "gaps": [{ "lens": "users", "text": "Не сказано, кто принимает звонки ночью" }],
            })),
            brief_previous: None,
            sources: Vec::new(),
        }),
        people: Vec::new(),
        participant_ids: Vec::new(),
        glossary: String::new(),
        settings: SettingsMap::new(),
        recording: Recording {
            started_at: 1_000_000_000_000,
            duration_ms: live.iter().map(|s| s.end_ms).max().unwrap_or(0),
        },
        live,
        refined: None,
        original: None,
        discussion_end_ms: None,
    }
}

pub fn topic(id: &str, title: &str, at_ms: i64) -> ReportTopic {
    ReportTopic {
        id: id.to_owned(),
        title: title.to_owned(),
        at_ms,
    }
}

/// [`question`] that waited behind a full list and was never shown.
pub fn never_shown(id: &str, at_ms: i64, topic_id: &str, text: &str) -> ReportQuestion {
    ReportQuestion {
        shown_at_ms: None,
        ..question(id, at_ms, topic_id, text)
    }
}

/// An open `empty` question about `users` of `topic_id`, citing `seg`,
/// shown as soon as it was added.
pub fn question(id: &str, at_ms: i64, topic_id: &str, text: &str) -> ReportQuestion {
    ReportQuestion {
        id: id.to_owned(),
        at_ms,
        shown_at_ms: Some(at_ms),
        topic_id: Some(topic_id.to_owned()),
        topic: None,
        card_field: Some(CardLens::Users),
        gap_type: GapType::Empty,
        priority: 2,
        text: text.to_owned(),
        description: "Без этого не оценить объём".to_owned(),
        evidence: vec![Evidence {
            source: EvidenceSource::Segment,
            id: "seg".to_owned(),
            quote: "звонки теряются в час пик".to_owned(),
        }],
        status: QuestionStatus::Open,
        answer_evidence: None,
    }
}

pub fn phrase(id: &str, channel: TranscriptChannel, end_ms: i64) -> Phrase {
    Phrase {
        id: id.to_owned(),
        channel,
        start_ms: end_ms - 2_000,
        end_ms,
    }
}

pub fn call(at_ms: i64, duration_ms: i64, cost_usd: f64, rejected: Value) -> ReportCall {
    ReportCall {
        kind: report::CallKind::FastLoop,
        at_ms,
        duration_ms,
        outcome: AgentCallOutcome::Ok,
        input_tokens: Some(1_000),
        output_tokens: Some(100),
        cache_read: Some(500),
        cache_write: Some(0),
        cost_usd: Some(cost_usd),
        rejected,
        error: None,
    }
}

/// A complete run of «telemedia» with nothing in it yet.
pub fn report() -> Report {
    Report {
        version: report::FORMAT,
        corpus: "telemedia".to_owned(),
        corpus_path: None,
        discussion_end_ms: None,
        label: "test".to_owned(),
        complete: true,
        stopped: None,
        channels: Channels::Real,
        rules_sha256: "ab".repeat(32),
        flags: Flags::default(),
        run: Run::default(),
        topics: Vec::new(),
        questions: Vec::new(),
        calls: Vec::new(),
        log: Vec::new(),
        phrases: Vec::new(),
    }
}

/// [`report`] with `phrases` fed (the run ends at the last one).
pub fn report_with(
    topics: Vec<ReportTopic>,
    questions: Vec<ReportQuestion>,
    phrases: Vec<Phrase>,
) -> Report {
    let mut report = report();
    report.run.segments = phrases.len();
    report.run.segments_fed = phrases.len();
    report.run.last_fed_ms = phrases.iter().map(|phrase| phrase.end_ms).max();
    report.questions = questions
        .into_iter()
        .map(|mut question| {
            question.topic = topics
                .iter()
                .find(|topic| Some(&topic.id) == question.topic_id.as_ref())
                .map(|topic| topic.title.clone());
            question
        })
        .collect();
    report.topics = topics;
    report.phrases = phrases;
    report
}

/// `future` on a current-thread runtime (for the fake `claude` below).
#[cfg(unix)]
pub fn block_on<T>(future: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

/// A fake `claude` (in the manner of `summary/fake_cli_tests.rs`).
#[cfg(unix)]
pub mod fake {
    use std::{fs, os::unix::fs::PermissionsExt as _, path::Path, sync::Arc};

    use serde_json::{Value, json};

    use crate::agent::claude_cli::{Agent, ClaudeCodeCli};

    /// Counts its runs, records the n-th run's arguments and stdin, then plays
    /// `events-<n>.jsonl`.
    const FAKE_CLAUDE: &str = r#"#!/bin/sh
    STATE='@STATE@'
    echo run >> "$STATE/runs"
    n=$(wc -l < "$STATE/runs" | tr -d ' ')
    for arg in "$@"; do printf '%s\0' "$arg"; done > "$STATE/args-$n"
    cat > "$STATE/stdin-$n"
    cat "$STATE/events-$n.jsonl"
    "#;

    /// A call that writes `output` through `StructuredOutput`.
    pub fn events(output: &Value) -> String {
        [
            json!({ "type": "system", "subtype": "init", "model": "claude-sonnet-5-5" }),
            json!({
                "type": "result", "subtype": "success", "is_error": false,
                "structured_output": output,
                "total_cost_usd": 0.12,
                "usage": { "input_tokens": 20_000, "output_tokens": 800 }
            }),
        ]
        .iter()
        .map(|line| format!("{line}\n"))
        .collect()
    }

    pub struct Fake {
        dir: tempfile::TempDir,
    }

    impl Fake {
        /// The n-th call answers `outputs[n - 1]`.
        pub fn new(outputs: &[Value]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            for (index, output) in outputs.iter().enumerate() {
                fs::write(
                    dir.path().join(format!("events-{}.jsonl", index + 1)),
                    events(output),
                )
                .unwrap();
            }
            Self { dir }
        }

        pub fn path(&self) -> &Path {
            self.dir.path()
        }

        pub fn agent(&self) -> Arc<dyn Agent> {
            let body = FAKE_CLAUDE.replace("@STATE@", &self.path().display().to_string());
            let cli = self.path().join("bin/claude");
            fs::create_dir_all(cli.parent().unwrap()).unwrap();
            fs::write(&cli, body).unwrap();
            fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
            Arc::new(ClaudeCodeCli::new(cli, self.path().join("work")))
        }

        pub fn read(&self, name: &str) -> String {
            fs::read_to_string(self.path().join(name)).unwrap_or_default()
        }

        pub fn runs(&self) -> usize {
            self.read("runs").lines().count()
        }
    }
}
