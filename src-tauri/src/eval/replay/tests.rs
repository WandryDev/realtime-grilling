//! The scenarios of `specs/question-replay` «Прогон в темпе звонка» and the
//! report, with a fake agent.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::*;
use crate::{
    agent::{
        claude_cli::{AgentReply, Usage},
        fast_loop::{
            assembly,
            testing::{FakeAgent, Step},
        },
    },
    eval::corpus::{Channels, Origin, Person, Project, Recording},
    storage::{call_state::AgentCallOutcome, settings::SettingsMap, transcript::TranscriptChannel},
};

const OTHERS: TranscriptChannel = TranscriptChannel::Others;
const ME: TranscriptChannel = TranscriptChannel::Me;

/// The fake's 8 s pass in a few ms of real time.
const FAST: Follow = Follow {
    step: Duration::from_millis(100),
    every: Duration::from_millis(1),
};

/// A segment of the corpus: id `seg-<n>`, 2 s long, ending at `end_ms`.
fn segment(n: usize, channel: TranscriptChannel, end_ms: i64, text: &str) -> Segment {
    Segment {
        id: format!("seg-{n}"),
        channel,
        start_ms: end_ms - 2_000,
        end_ms,
        text: text.to_owned(),
    }
}

/// «Телемедиа» with Ольга on the call, started at 1 000 000 000 000.
fn corpus(live: Vec<Segment>) -> Corpus {
    Corpus {
        version: crate::eval::corpus::FORMAT,
        name: "telemedia".to_owned(),
        origin: Origin::Export {
            recording_id: "0196f3a2-0000-7000-8000-000000000000".to_owned(),
            exported_at: 0,
        },
        channels: Channels::Real,
        project: Some(Project {
            name: "Телемедиа".to_owned(),
            description: "Единая система приёма звонков для сети клиник".to_owned(),
            notes: String::new(),
            brief: Some(json!({
                "product": "Клиники теряют до половины звонков пациентов",
                "stack": ["amoCRM API v4", "Mango Office"],
                "modules": [],
                "glossary": [{ "term": "Первичка", "definition": "Пациент без карты" }],
                "keyDocuments": [],
            })),
            brief_previous: None,
            sources: Vec::new(),
        }),
        people: vec![Person {
            id: "olga".to_owned(),
            name: "Ольга Демченко".to_owned(),
            role: "CEO".to_owned(),
            profile: json!({ "howToAsk": "Через деньги и сроки", "tech": 1 }),
        }],
        participant_ids: vec!["olga".to_owned()],
        glossary: String::new(),
        settings: SettingsMap::new(),
        recording: Recording {
            started_at: STARTED_AT,
            duration_ms: live.iter().map(|s| s.end_ms).max().unwrap_or(0),
        },
        live,
        refined: None,
        original: None,
    }
}

const STARTED_AT: i64 = 1_000_000_000_000;

fn options() -> Options {
    Options {
        label: "test".to_owned(),
        ..Options::default()
    }
}

async fn replay(
    corpus: &Corpus,
    agent: Arc<dyn Agent>,
    options: &Options,
    follow: Follow,
) -> Report {
    let dir = tempfile::tempdir().unwrap();
    run(corpus, agent, options, &dir.path().join("prompts"), follow)
        .await
        .unwrap()
}

fn message(agent: &FakeAgent, index: usize) -> String {
    agent.received(index).request.user_message
}

/// «Фраза во время вызова»: the call takes 8 s; a phrase of the client
/// meanwhile is not in it, and is in the next one.
#[tokio::test(start_paused = true)]
async fn a_phrase_during_a_call_goes_to_the_next_one() {
    let agent = FakeAgent::new([Step::empty().after(Duration::from_secs(8))]);
    let corpus = corpus(vec![
        segment(1, OTHERS, 2_000, "Звонки идут на личные телефоны"),
        segment(2, OTHERS, 5_000, "Ночью никто не отвечает"),
        segment(3, OTHERS, 30_000, "Пациенты ждут по десять минут"),
    ]);
    let report = replay(&corpus, agent.clone(), &options(), FAST).await;

    assert_eq!(agent.calls(), 2);
    let first = message(&agent, 0);
    assert!(first.contains("Звонки идут на личные телефоны"), "{first}");
    assert!(!first.contains("Ночью никто не отвечает"), "{first}");
    let second = message(&agent, 1);
    assert!(second.contains("[S:seg-2]"), "{second}");
    assert!(second.contains("Пациенты ждут по десять минут"), "{second}");

    assert!(report.complete);
    let starts: Vec<i64> = report.calls.iter().map(|call| call.at_ms).collect();
    assert!((2_000..2_200).contains(&starts[0]), "{starts:?}");
    assert!((30_000..30_200).contains(&starts[1]), "{starts:?}");
    assert_eq!(report.run.segments_fed, 3);
}

/// A call whose agent waits on the real world (a CLI is a child process):
/// tokio would move the paused clock past the phrases and the timeout while
/// it runs; the run's clock instead follows real time.
struct RealWait {
    wait: Duration,
    received: std::sync::Mutex<Vec<String>>,
}

impl Agent for RealWait {
    fn run(&self, request: AgentRequest, cancel: oneshot::Receiver<()>) -> AgentFuture<'_> {
        self.received.lock().unwrap().push(request.user_message);
        let (done, waited) = oneshot::channel();
        let wait = self.wait;
        std::thread::spawn(move || {
            std::thread::sleep(wait);
            let _ = done.send(());
        });
        Box::pin(async move {
            tokio::select! {
                _ = waited => Ok(AgentReply { patch: json!({ "ops": [] }), usage: Usage::default() }),
                _ = cancel => Err(AgentError::Cancelled),
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn the_clock_follows_a_call_that_waits_on_the_real_world() {
    let agent = Arc::new(RealWait {
        wait: Duration::from_millis(700),
        received: std::sync::Mutex::new(Vec::new()),
    });
    let corpus = corpus(vec![
        segment(1, OTHERS, 2_000, "Звонки идут на личные телефоны"),
        segment(2, OTHERS, 2_200, "Ночью никто не отвечает"),
        segment(3, OTHERS, 30_000, "Пациенты ждут по десять минут"),
    ]);
    let report = replay(&corpus, agent.clone(), &options(), FOLLOW).await;

    let outcomes: Vec<_> = report.calls.iter().map(|call| call.outcome).collect();
    assert_eq!(
        outcomes,
        [AgentCallOutcome::Empty, AgentCallOutcome::Empty],
        "{report:#?}"
    );
    // The first call took ~0.7 s of the run's clock, not 0 and not 32.
    let idle_after_first = report
        .log
        .iter()
        .filter(|entry| entry.at_ms > 2_000)
        .find(|entry| {
            matches!(&entry.event, LogEvent::AgentStatus { state } if *state == AgentLoopState::Idle)
        })
        .unwrap()
        .at_ms;
    assert!(
        (2_500..4_000).contains(&idle_after_first),
        "{idle_after_first}"
    );
    assert!((30_000..30_300).contains(&report.calls[1].at_ms));
    let received = agent.received.lock().unwrap();
    assert!(!received[0].contains("Ночью никто не отвечает"));
    assert!(received[1].contains("Ночью никто не отвечает"));
}

/// «Отрезок звонка»: the loop gets only the phrases of minutes 20–40; the
/// report's times are from the start of the call.
#[tokio::test(start_paused = true)]
async fn a_part_of_the_call() {
    let agent = FakeAgent::new([]);
    let live = (0..60)
        .map(|minute| {
            let end_ms = minute * 60_000 + 30_000;
            segment(
                usize::try_from(minute).unwrap(),
                OTHERS,
                end_ms,
                &format!("Фраза минуты {minute:02} про очередь"),
            )
        })
        .collect();
    let options = Options {
        from_min: Some(20.0),
        to_min: Some(40.0),
        ..options()
    };
    let report = replay(&corpus(live), agent.clone(), &options, FAST).await;

    assert_eq!(report.run.segments, 20);
    assert_eq!(report.run.segments_fed, 20);
    assert_eq!(report.calls.len(), 20);
    assert_eq!(agent.calls(), 20);
    for index in 0..agent.calls() {
        let message = message(&agent, index);
        for minute in (0..20).chain(40..60) {
            let phrase = format!("Фраза минуты {minute:02}");
            assert!(!message.contains(&phrase), "{phrase} in {message}");
        }
    }
    let first = report.calls[0].at_ms;
    assert!(
        (20 * 60_000 + 30_000..20 * 60_000 + 30_200).contains(&first),
        "{first}"
    );
    assert_eq!(report.run.last_fed_ms, Some(39 * 60_000 + 30_000));
    assert_eq!(report.flags.from_min, Some(20.0));
}

/// «Агент недоступен»: a call fails for want of a login; the run stops,
/// and what it had is saved as incomplete.
#[tokio::test(start_paused = true)]
async fn an_agent_that_is_not_logged_in_stops_the_run() {
    let agent = FakeAgent::new([
        Step::empty().after(Duration::from_secs(3)),
        Step::fail(AgentError::NotLoggedIn).after(Duration::from_secs(1)),
    ]);
    let corpus = corpus(vec![
        segment(1, OTHERS, 2_000, "Звонки идут на личные телефоны"),
        segment(2, OTHERS, 30_000, "Ночью никто не отвечает"),
        segment(3, OTHERS, 60_000, "Пациенты ждут по десять минут"),
        segment(4, OTHERS, 90_000, "Хотим одну очередь"),
    ]);
    let report = replay(&corpus, agent.clone(), &options(), FAST).await;

    assert!(!report.complete);
    assert_eq!(report.stopped.as_deref(), Some("Нужен вход в Claude Code"));
    let outcomes: Vec<_> = report.calls.iter().map(|call| call.outcome).collect();
    assert_eq!(
        outcomes,
        [AgentCallOutcome::Empty, AgentCallOutcome::NotLoggedIn]
    );
    assert_eq!(report.run.segments_fed, 2);
    assert_eq!(agent.calls(), 2);
}

fn question_patch(segment_id: &str) -> Value {
    let evidence = json!([{ "source": "segment", "id": format!("S:{segment_id}"), "quote": "если все заняты" }]);
    json!({ "ops": [
        { "op": "topic", "action": "create", "title": "Очередь операторов" },
        { "op": "card", "field": "edgeCases", "value": "Все операторы заняты", "evidence": evidence },
        {
            "op": "question",
            "title": "Что происходит со звонком, если все операторы заняты?",
            "description": "Клиент не описал сценарий",
            "cardField": "edgeCases",
            "gapType": "empty",
            "priority": 3,
            "evidence": evidence
        },
        {
            "op": "question",
            "title": "Кто придумал эту цитату?",
            "description": "",
            "cardField": "edgeCases",
            "gapType": "empty",
            "priority": 1,
            "evidence": [{ "source": "segment", "id": format!("S:{segment_id}"), "quote": "такого клиент не говорил" }]
        }
    ] })
}

/// The report holds the question with its time, topic, field, gap,
/// evidence (by the corpus's ids) and status; the call with its cost and
/// the rejected operation; the rules' hash.
#[tokio::test(start_paused = true)]
async fn the_report_holds_the_questions_and_calls() {
    let agent = FakeAgent::new([Step {
        usage: Usage {
            input_tokens: 9_000,
            output_tokens: 300,
            cost_usd: Some(0.031),
            ..Usage::default()
        },
        ..Step::patch(question_patch("seg-2"))
    }]);
    let corpus = corpus(vec![
        segment(1, ME, 4_000, "Что будет, если все операторы заняты?"),
        segment(
            2,
            OTHERS,
            10_000,
            "Если все заняты, тогда уже как получится",
        ),
    ]);
    let report = replay(&corpus, agent, &options(), FAST).await;
    let json = serde_json::to_value(&report).unwrap();

    assert_eq!(json["version"], 1);
    assert_eq!(json["corpus"], "telemedia");
    assert_eq!(json["label"], "test");
    assert_eq!(json["complete"], true);
    assert_eq!(json["channels"], "real");
    assert_eq!(json["rulesSha256"], report::sha256_hex(assembly::RULES));
    assert_eq!(json["flags"]["realtime"], false);
    assert_eq!(json["run"]["callStartedAt"], STARTED_AT);

    assert_eq!(json["topics"].as_array().unwrap().len(), 1);
    assert_eq!(json["topics"][0]["title"], "Очередь операторов");
    let questions = json["questions"].as_array().unwrap();
    assert_eq!(questions.len(), 1, "{questions:#?}");
    let question = &questions[0];
    // The call started at 10 s and took 5.
    let at = question["atMs"].as_i64().unwrap();
    assert!((15_000..15_300).contains(&at), "{at}");
    assert_eq!(question["topic"], "Очередь операторов");
    assert_eq!(question["topicId"], json["topics"][0]["id"]);
    assert_eq!(question["cardField"], "edgeCases");
    assert_eq!(question["gapType"], "empty");
    assert_eq!(question["priority"], 3);
    assert_eq!(
        question["text"],
        "Что происходит со звонком, если все операторы заняты?"
    );
    assert_eq!(question["evidence"][0]["id"], "seg-2");
    assert_eq!(question["status"], "open");
    assert_eq!(question["shownAtMs"], question["atMs"]);

    let calls = json["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert!((10_000..10_200).contains(&call["atMs"].as_i64().unwrap()));
    assert_eq!(call["outcome"], "ok");
    assert_eq!(call["inputTokens"], 9_000);
    assert_eq!(call["outputTokens"], 300);
    assert_eq!(call["costUsd"], 0.031);
    assert_eq!(call["rejected"].as_array().unwrap().len(), 1);
    assert_eq!(call["rejected"][0]["subject"], "Кто придумал эту цитату?");

    let events: Vec<&str> = json["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["event"].as_str().unwrap())
        .collect();
    assert!(events.contains(&"callStateChanged"), "{events:?}");
}

/// `--rules`: the prefix opens with the file's text, and the report has its
/// hash and the file.
#[tokio::test(start_paused = true)]
async fn rules_from_a_file_replace_the_built_in_ones() {
    let agent = FakeAgent::new([]);
    let corpus = corpus(vec![segment(
        1,
        OTHERS,
        2_000,
        "Звонки идут на личные телефоны",
    )]);
    let options = Options {
        rules: Some(Rules {
            file: "rules-topics.md".to_owned(),
            text: "# Правила\n\nВариант: темы по подсистемам.\n".to_owned(),
        }),
        ..options()
    };
    let report = replay(&corpus, agent.clone(), &options, FAST).await;

    let prompt = String::from_utf8(agent.received(0).prompt).unwrap();
    assert!(prompt.starts_with("# Правила\n\nВариант: темы по подсистемам.\n"));
    assert!(!prompt.contains("Ты — быстрый контур"));
    assert!(prompt.contains("Название: Телемедиа"));
    assert_eq!(
        report.rules_sha256,
        report::sha256_hex("# Правила\n\nВариант: темы по подсистемам.\n")
    );
    assert_eq!(report.flags.rules_file.as_deref(), Some("rules-topics.md"));
}

/// `--realtime`: the same run on the real clock (short, so the test is).
#[tokio::test]
async fn the_real_clock_gives_the_same_calls() {
    let agent = FakeAgent::new([Step::empty().after(Duration::from_millis(300))]);
    let short = |n: usize, start_ms: i64, end_ms: i64, text: &str| Segment {
        start_ms,
        end_ms,
        ..segment(n, OTHERS, end_ms, text)
    };
    let corpus = corpus(vec![
        short(1, 0, 200, "Звонки идут на личные телефоны"),
        short(2, 250, 400, "Ночью никто не отвечает"),
    ]);
    let options = Options {
        realtime: true,
        ..options()
    };
    let report = replay(&corpus, agent.clone(), &options, FOLLOW).await;

    assert!(report.complete);
    assert_eq!(agent.calls(), 1);
    assert!(!message(&agent, 0).contains("Ночью никто не отвечает"));
    assert!(report.run.wall_ms < 2_000, "{}", report.run.wall_ms);
    assert!((200..400).contains(&report.calls[0].at_ms), "{report:#?}");
}

/// The state's hints run on the replay's clock: 7 minutes after the
/// question, with the client talking, the next call is told so; with
/// `--baseline-state` it is not, nor of the empty lenses.
#[tokio::test(start_paused = true)]
async fn the_pause_line_follows_the_replay_clock_and_the_baseline_drops_it() {
    let corpus = corpus(vec![
        segment(1, ME, 4_000, "Что будет, если все операторы заняты?"),
        segment(
            2,
            OTHERS,
            10_000,
            "Если все заняты, тогда уже как получится",
        ),
        segment(3, OTHERS, 7 * 60_000 + 30_000, "Ещё у нас ночная смена"),
    ]);
    let pause = "7 мин без новых вопросов. Проверь:";

    let agent = FakeAgent::new([Step::patch(question_patch("seg-2"))]);
    let report = replay(&corpus, agent.clone(), &options(), FAST).await;
    assert_eq!(agent.calls(), 2);
    let second = message(&agent, 1);
    assert!(second.contains(pause), "{second}");
    assert!(
        second.contains("Пустые линзы: цель, пользователи,"),
        "{second}"
    );
    assert!(!report.flags.baseline_state);
    let fed: Vec<&str> = report.phrases.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(fed, ["seg-1", "seg-2", "seg-3"]);

    let agent = FakeAgent::new([Step::patch(question_patch("seg-2"))]);
    let options = Options {
        baseline_state: true,
        ..options()
    };
    let report = replay(&corpus, agent.clone(), &options, FAST).await;
    let second = message(&agent, 1);
    assert!(!second.contains("мин без новых вопросов"), "{second}");
    assert!(!second.contains("Пустые линзы"), "{second}");
    assert!(report.flags.baseline_state);
}
