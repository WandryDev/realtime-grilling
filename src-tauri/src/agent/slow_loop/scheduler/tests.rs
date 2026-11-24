//! The scenarios of `specs/agent-slow-loop` «Когда запускается медленный
//! контур», «Журнал и ошибки медленного контура» on a paused clock with
//! fake agents, next to a fast loop.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};

use super::*;
use crate::{
    agent::{
        fast_loop::{
            events::AgentLoopState,
            scheduler::{FastLoop, LoopConfig},
            testing::{FakeAgent, Provider, Step, TestHost, add_source, database, recording, say},
        },
        slow_loop::app,
    },
    storage::call_state::AgentCall,
};

const OTHERS: TranscriptChannel = TranscriptChannel::Others;

/// The Outline document the slow loop searches.
const REGULATION: &str = "# Регламент смены\n\n## Старший смены\n\n\
Оператор смены отвечает за распределение звонков между линиями. В смене три оператора, \
старший смены следит за очередью и подменяет тех, кто ушёл на перерыв.\n\n\
## Ночь\n\nНочью звонки уходят на автоответчик клиники.";

/// 16 words of the client about the regulation.
const ABOUT_SHIFTS: &str = "У нас операторы смены сами распределяют звонки между линиями, \
                            старший смены иногда следит за очередью, вот так и работаем";

/// 16 words about nothing the sources have.
const SMALL_TALK: &str = "Погода сегодня хорошая, солнце светит, мы вчера ездили за город, \
                          отдыхали всей семьёй целый длинный день";

struct Rig {
    host: Arc<TestHost>,
    slow_agent: Arc<FakeAgent>,
    fast_agent: Arc<FakeAgent>,
    fast_loop: FastLoop,
    slow_loop: SlowLoop,
    recording: String,
    t0: Instant,
    dir: tempfile::TempDir,
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

impl Rig {
    /// A recording of a project with the regulation in Outline (or without
    /// a source), its live pass started in both loops.
    async fn new(sources: bool, slow: impl IntoIterator<Item = Step>) -> Self {
        let db = database();
        let recording = recording(&db);
        if sources {
            add_source(
                &db,
                &recording,
                Some("outline"),
                "Регламент смены",
                REGULATION,
                true,
            );
        }
        let host = TestHost::new(db);
        let slow_agent = FakeAgent::new(slow);
        let fast_agent = FakeAgent::new([]);
        let dir = tempfile::tempdir().unwrap();
        let fast_loop = FastLoop::new(
            host.clone(),
            Provider::ready(fast_agent.clone()),
            tokio::runtime::Handle::current(),
            LoopConfig::new(dir.path().join("agent")),
        );
        let slow_loop = SlowLoop::new(
            host.clone(),
            Provider::ready(slow_agent.clone()),
            tokio::runtime::Handle::current(),
            SlowConfig::new(dir.path().join("agent")),
            fast_loop.halt(),
        );
        app::connect(&fast_loop, &slow_loop);
        let rig = Self {
            host,
            slow_agent,
            fast_agent,
            fast_loop,
            slow_loop,
            recording,
            t0: Instant::now(),
            dir,
        };
        rig.fast_loop.live_started(&rig.recording);
        rig.slow_loop.live_started(&rig.recording);
        settle().await;
        rig
    }

    fn secs(&self, at: Instant) -> u64 {
        (at - self.t0).as_secs()
    }

    /// When the slow agent's calls started, in seconds.
    fn slow_starts(&self) -> Vec<u64> {
        self.slow_agent
            .starts()
            .into_iter()
            .map(|at| self.secs(at))
            .collect()
    }

    fn fast_starts(&self) -> Vec<u64> {
        self.fast_agent
            .starts()
            .into_iter()
            .map(|at| self.secs(at))
            .collect()
    }

    /// The client says `text` now: both loops hear it.
    async fn client(&self, text: &str) -> String {
        let start_ms = i64::try_from(self.t0.elapsed().as_millis()).unwrap();
        let segment = self
            .host
            .db(|db| say(db, &self.recording, OTHERS, start_ms, text));
        self.fast_loop
            .phrase_with_id(&self.recording, OTHERS, &segment.id);
        self.slow_loop
            .phrase(&self.recording, OTHERS, text, Some(&segment.id));
        settle().await;
        segment.id
    }

    async fn until(&self, seconds: u64) {
        tokio::time::sleep_until(self.t0 + Duration::from_secs(seconds)).await;
        settle().await;
    }

    /// The slow loop's journal.
    fn slow_calls(&self) -> Vec<AgentCall> {
        self.host
            .db(|db| call_state::agent_calls(db, &self.recording))
            .unwrap()
            .into_iter()
            .filter(|call| call.kind == AgentCallKind::SlowLoop)
            .collect()
    }

    fn findings(&self) -> Vec<context_findings::ContextFinding> {
        self.host
            .db(|db| context_findings::visible(db, &self.recording))
            .unwrap()
    }

    fn fast_state(&self) -> AgentLoopState {
        self.fast_loop.status(&self.recording).state
    }
}

fn found(quote: &str, queries: Value) -> Step {
    Step::patch(json!({
        "findings": [{ "candidate": "C1", "quote": quote, "note": "Противоречит: в регламенте три оператора" }],
        "queries": queries
    }))
}

fn nothing() -> Step {
    Step::patch(json!({ "findings": [], "queries": [] }))
}

/* Когда запускается медленный контур */

/// The first call a minute after the start, with what the client said; a
/// finding is stored, the windows hear of it, the journal has the call.
#[tokio::test(start_paused = true)]
async fn the_first_call_comes_a_minute_after_the_start() {
    let rig = Rig::new(
        true,
        [found(
            "В смене три оператора",
            json!(["старший смены", "перерыв"]),
        )],
    )
    .await;
    assert_eq!(
        rig.slow_loop.search(&rig.recording),
        Some(ContextSearch {
            running: false,
            queries: Vec::new()
        })
    );
    rig.client(ABOUT_SHIFTS).await;
    rig.until(59).await;
    assert!(rig.slow_starts().is_empty());
    rig.until(60).await;
    assert_eq!(rig.slow_starts(), [60]);
    assert_eq!(
        rig.slow_loop.search(&rig.recording),
        Some(ContextSearch {
            running: true,
            queries: Vec::new()
        })
    );
    let request = rig.slow_agent.received(0).request;
    assert!(
        request
            .user_message
            .contains("[C1] Outline «Регламент смены» › Регламент смены › Старший смены")
    );
    assert!(request.user_message.contains(ABOUT_SHIFTS));
    assert_eq!(request.schema, schema_argument());
    assert_eq!(request.options.output, OutputKind::Object);
    assert_eq!(request.options.effort, Some("low"));
    assert_eq!(request.options.timeout, Some(claude_cli::TIMEOUT));
    let changes = rig.host.changes();

    rig.until(66).await;
    let findings = rig.findings();
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].quote, "В смене три оператора");
    assert_eq!(findings[0].source_name, "Регламент смены");
    assert!(
        findings[0]
            .source_url
            .as_deref()
            .unwrap()
            .starts_with("https://outline")
    );
    assert!(
        rig.host.changes() >= changes + 2,
        "the finding and the end of the search"
    );
    assert_eq!(
        rig.slow_loop.search(&rig.recording),
        Some(ContextSearch {
            running: false,
            queries: vec!["старший смены".to_owned(), "перерыв".to_owned()]
        })
    );
    let calls = rig.slow_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].outcome, AgentCallOutcome::Ok);
    let agent_call: Option<String> = rig.host.db(|db| {
        db.query_row("SELECT agent_call_id FROM context_findings", [], |row| {
            row.get(0)
        })
        .unwrap()
    });
    assert_eq!(agent_call.as_deref(), Some(calls[0].id.as_str()));
    // The fast loop's state never changed for it: its calls only.
    assert_eq!(rig.fast_starts(), [0]);

    // The next call gets the queries of this one.
    rig.client(ABOUT_SHIFTS).await;
    rig.until(121).await;
    assert_eq!(rig.slow_starts(), [60, 120]);
    let message = rig.slow_agent.received(1).request.user_message;
    assert!(message.contains("# Твои запросы из прошлого вызова\n\n- старший смены\n- перерыв\n"));
    assert!(message.contains("- [D1] Outline «Регламент смены»: «В смене три оператора»"));
    // The prompt file is the same bytes for both calls.
    let (first, second) = (rig.slow_agent.received(0), rig.slow_agent.received(1));
    assert!(!first.prompt.is_empty());
    assert_eq!(first.prompt, second.prompt);
    assert!(
        String::from_utf8(first.prompt)
            .unwrap()
            .starts_with(assembly::RULES)
    );
}

/// Spec «Проект без источников»: no slow calls, the fast loop as usual.
#[tokio::test(start_paused = true)]
async fn a_project_without_sources_gets_no_slow_calls() {
    let rig = Rig::new(false, []).await;
    assert_eq!(rig.slow_loop.search(&rig.recording), None);
    rig.client(ABOUT_SHIFTS).await;
    rig.until(30).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(300).await;
    assert!(rig.slow_agent.starts().is_empty());
    assert!(rig.slow_calls().is_empty());
    assert_eq!(rig.fast_starts(), [0, 30]);
    let prompt = assembly::prompt_path(&rig.dir.path().join("agent"), &rig.recording);
    assert!(!prompt.exists());
}

/// Spec «Клиент молчит»: 5 words in a minute start nothing; 15 do, at
/// once when the minute has passed.
#[tokio::test(start_paused = true)]
async fn a_silent_client_starts_no_call() {
    let rig = Rig::new(true, [nothing(), nothing()]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    assert_eq!(rig.slow_starts(), [60]);
    rig.client("Да, операторы смены, всё так").await;
    rig.until(200).await;
    assert_eq!(rig.slow_starts(), [60], "5 words since the last call");
    rig.client("Старший смены у нас один на всю клинику и он очень занят")
        .await;
    assert_eq!(rig.slow_starts(), [60, 200]);
}

/// Before the first call the client said too little: nothing, even after a
/// minute.
#[tokio::test(start_paused = true)]
async fn no_first_call_without_the_clients_words() {
    let rig = Rig::new(true, []).await;
    rig.client("Здравствуйте").await;
    rig.until(600).await;
    assert!(rig.slow_starts().is_empty());
    assert!(rig.slow_calls().is_empty());
}

/// Spec «Параллельно с быстрым контуром»: a slow call starts while a fast
/// one runs, without waiting; the fast loop still runs one call at a time.
#[tokio::test(start_paused = true)]
async fn a_slow_call_runs_next_to_a_fast_one() {
    let rig = Rig::new(true, [nothing().after(Duration::from_secs(20))]).await;
    rig.fast_agent
        .push(Step::empty().after(Duration::from_secs(25)));
    rig.client(ABOUT_SHIFTS).await;
    assert_eq!(rig.fast_starts(), [0]);
    rig.until(40).await;
    rig.fast_agent
        .push(Step::empty().after(Duration::from_secs(30)));
    rig.client(ABOUT_SHIFTS).await;
    rig.until(55).await;
    assert_eq!(rig.fast_starts(), [0, 40]);
    assert_eq!(rig.fast_state(), AgentLoopState::Thinking);
    rig.client(ABOUT_SHIFTS).await;
    rig.until(60).await;
    assert_eq!(rig.slow_starts(), [60], "while the fast call runs");
    rig.until(69).await;
    assert_eq!(rig.fast_starts(), [0, 40], "no second fast call meanwhile");
    assert_eq!(rig.fast_agent.most_at_once(), 1);
    rig.until(71).await;
    assert_eq!(rig.fast_starts(), [0, 40, 70]);
}

/// Spec «Смена темы»: the fast loop switched the topic: a slow call at once,
/// though the last one was less than a minute ago.
#[tokio::test(start_paused = true)]
async fn a_new_topic_starts_a_slow_call_at_once() {
    let rig = Rig::new(true, [nothing(), nothing()]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    assert_eq!(rig.slow_starts(), [60]);
    rig.fast_agent.push(Step::patch(json!({ "ops": [
        { "op": "topic", "action": "create", "title": "Смены операторов" }
    ] })));
    rig.until(70).await;
    rig.client("Теперь о сменах").await;
    rig.until(76).await;
    assert_eq!(
        rig.slow_starts(),
        [60, 75],
        "at the topic the fast loop created"
    );
    let message = rig.slow_agent.received(1).request.user_message;
    assert!(message.contains("Смены операторов (текущая)"), "{message}");
}

/// The first topic before the first minute: the first call at once.
#[tokio::test(start_paused = true)]
async fn the_first_topic_comes_before_the_minute() {
    let rig = Rig::new(true, [nothing()]).await;
    rig.fast_agent.push(Step::patch(json!({ "ops": [
        { "op": "topic", "action": "create", "title": "Смены" }
    ] })));
    rig.client(ABOUT_SHIFTS).await;
    rig.until(6).await;
    assert_eq!(rig.slow_starts(), [5]);
}

/// No candidate: an `empty` call without the agent.
#[tokio::test(start_paused = true)]
async fn without_candidates_no_process_runs() {
    let rig = Rig::new(true, []).await;
    rig.client(SMALL_TALK).await;
    rig.until(61).await;
    assert!(rig.slow_agent.starts().is_empty());
    let calls = rig.slow_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].outcome, AgentCallOutcome::Empty);
    assert_eq!(calls[0].input_tokens, None);
    assert_eq!(
        rig.slow_loop
            .search(&rig.recording)
            .map(|search| search.running),
        Some(false)
    );
}

/* Журнал и ошибки медленного контура */

/// Spec «Медленный контур ошибся»: the windows show no error of the agent,
/// the fast loop goes on, the next slow call no sooner than a minute later.
#[tokio::test(start_paused = true)]
async fn a_failed_slow_call_leaves_the_agent_state_alone() {
    let rig = Rig::new(
        true,
        [
            Step::fail(AgentError::Process("boom".to_owned())),
            nothing(),
        ],
    )
    .await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    assert_eq!(rig.slow_starts(), [60]);
    assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::Error);
    let states = rig.host.states();
    assert!(
        states
            .iter()
            .all(|state| matches!(state, AgentLoopState::Idle | AgentLoopState::Thinking)),
        "{states:?}"
    );
    assert_eq!(rig.fast_state(), AgentLoopState::Idle);

    // A topic change and the client's words don't start one before 125 s.
    rig.slow_loop.topic_changed(&rig.recording);
    rig.client(ABOUT_SHIFTS).await;
    rig.until(124).await;
    assert_eq!(rig.slow_starts(), [60]);
    assert_eq!(rig.fast_starts(), [0, 66], "the fast loop goes on");
    rig.until(126).await;
    assert_eq!(rig.slow_starts(), [60, 125]);
}

/// A reply off the schema: an `invalid` call, the same pause.
#[tokio::test(start_paused = true)]
async fn a_reply_off_the_schema_is_invalid() {
    let rig = Rig::new(true, [Step::patch(json!({ "ops": [] }))]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::Invalid);
    assert!(rig.findings().is_empty());
}

/// An invented quote: no finding, its reason in the journal.
#[tokio::test(start_paused = true)]
async fn an_invented_quote_is_journaled() {
    let rig = Rig::new(true, [found("В смене двадцать пять операторов", json!([]))]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    assert!(rig.findings().is_empty());
    let call = &rig.slow_calls()[0];
    assert_eq!(call.outcome, AgentCallOutcome::Empty);
    assert_eq!(call.rejected[0]["reason"], "quoteNotFound");
    // Spec «Кандидат отброшен»: the journal has the candidate and the
    // finding rejected with its reason.
    let candidates: Vec<(String, String, String)> = rig.host.db(|db| {
        db.prepare(
            "SELECT label, source_kind, source_name FROM slow_loop_candidates
              WHERE agent_call_id = ?1 ORDER BY rank",
        )
        .unwrap()
        .query_map([&call.id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    });
    let op: (i64, String) = rig.host.db(|db| {
        db.query_row(
            "SELECT applied, json_extract(reason, '$.reason') FROM agent_call_ops
              WHERE agent_call_id = ?1",
            [&call.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    });
    assert_eq!(
        candidates[0],
        (
            "C1".to_owned(),
            "outline".to_owned(),
            "Регламент смены".to_owned()
        )
    );
    assert_eq!(op, (0, "quoteNotFound".to_owned()));
}

/// Spec «Лимит подписки»: both loops stop until the limit resets.
#[tokio::test(start_paused = true)]
async fn the_limit_stops_both_loops_until_it_resets() {
    let resets_at = now_ms() + 180_000;
    let rig = Rig::new(
        true,
        [
            Step::fail(AgentError::RateLimited {
                resets_at: Some(resets_at),
            }),
            nothing(),
        ],
    )
    .await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::RateLimited);
    assert_eq!(rig.fast_starts(), [0]);

    rig.client(ABOUT_SHIFTS).await;
    rig.until(100).await;
    assert_eq!(rig.fast_starts(), [0], "the fast loop stopped too");
    assert_eq!(
        rig.fast_state(),
        AgentLoopState::RateLimited {
            resets_at: Some(resets_at)
        }
    );
    rig.slow_loop.topic_changed(&rig.recording);
    rig.until(240).await;
    assert_eq!(rig.slow_starts(), [60], "nor the slow one");

    // 180 s after the failure at 65 s (the wall clock moved a few ms).
    rig.until(246).await;
    assert_eq!(rig.slow_starts(), [60, 244]);
    assert_eq!(rig.fast_state(), AgentLoopState::Idle);
    rig.client(ABOUT_SHIFTS).await;
    assert_eq!(rig.fast_starts(), [0, 246]);
}

/// «Нужен вход» from a slow call: both loops wait for a status check.
#[tokio::test(start_paused = true)]
async fn a_missing_login_stops_both_loops_until_the_agent_is_ready() {
    let rig = Rig::new(true, [Step::fail(AgentError::NotLoggedIn), nothing()]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(200).await;
    assert_eq!(rig.fast_starts(), [0]);
    assert_eq!(rig.fast_state(), AgentLoopState::NeedsLogin);
    assert_eq!(rig.slow_starts(), [60]);

    rig.fast_loop.agent_ready();
    rig.slow_loop.agent_ready();
    settle().await;
    assert_eq!(rig.fast_state(), AgentLoopState::Idle);
    assert_eq!(rig.slow_starts(), [60, 200], "words were said meanwhile");
}

/// Spec «Запись остановлена»: the slow call is cancelled, its findings are
/// not stored, the search is gone from the call state.
#[tokio::test(start_paused = true)]
async fn the_end_of_the_recording_cancels_the_slow_call() {
    let rig = Rig::new(
        true,
        [found("В смене три оператора", json!([])).after(Duration::from_secs(20))],
    )
    .await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(70).await;
    assert_eq!(rig.slow_starts(), [60]);
    let prompt = assembly::prompt_path(&rig.dir.path().join("agent"), &rig.recording);
    assert!(prompt.exists());
    rig.slow_loop.live_finished(&rig.recording);
    rig.fast_loop.live_finished(&rig.recording);
    rig.until(100).await;
    assert!(rig.findings().is_empty());
    assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::Cancelled);
    assert_eq!(rig.slow_loop.search(&rig.recording), None);
    assert!(!prompt.exists());
}

/// The app's exit: the slow call is cancelled, its process killed, the
/// prompt files gone; nothing starts again.
#[tokio::test(start_paused = true)]
async fn the_apps_exit_stops_the_slow_loop() {
    let rig = Rig::new(true, [nothing().after(Duration::MAX)]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(61).await;
    let dir = rig.dir.path().join("agent");
    let left = assembly::prompt_path(&dir, "0196f3a2-crashed");
    std::fs::write(&left, "old").unwrap();
    assert!(assembly::prompt_path(&dir, &rig.recording).exists());
    rig.slow_loop.shutdown();
    assert!(!left.exists());
    assert!(!assembly::prompt_path(&dir, &rig.recording).exists());
    rig.until(70).await;
    assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::Cancelled);
    rig.slow_loop.live_started("other");
    rig.until(300).await;
    assert_eq!(rig.slow_starts(), [60]);
}

/// A call that hangs is cancelled after the timeout and counts as an error.
#[tokio::test(start_paused = true)]
async fn a_hanging_slow_call_times_out() {
    let rig = Rig::new(true, [nothing().after(Duration::MAX), nothing()]).await;
    rig.client(ABOUT_SHIFTS).await;
    rig.until(100).await;
    assert_eq!(rig.slow_calls()[0].outcome, AgentCallOutcome::Timeout);
    rig.client(ABOUT_SHIFTS).await;
    rig.until(200).await;
    assert_eq!(rig.slow_starts(), [60, 152], "a minute after the timeout");
}

/// Call-analytics task 2.2: the slow loop's call says why it ran and
/// names the client's last phrase: the minute's `interval`, then
/// `topicChanged` after the fast loop's new topic.
#[tokio::test(start_paused = true)]
async fn the_slow_call_journals_its_trigger() {
    let rig = Rig::new(true, [nothing(), nothing()]).await;
    let first = rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    rig.fast_agent.push(Step::patch(json!({ "ops": [
        { "op": "topic", "action": "create", "title": "Смены операторов" }
    ] })));
    rig.until(70).await;
    let second = rig.client("Теперь о сменах").await;
    rig.until(90).await;
    let triggers: Vec<(String, Option<String>)> = rig.host.db(|db| {
        db.prepare(
            "SELECT trigger_reason, trigger_segment_id FROM agent_calls
              WHERE recording_id = ?1 AND kind = 'slowLoop' ORDER BY started_at",
        )
        .unwrap()
        .query_map([&rig.recording], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
    });
    assert_eq!(
        triggers,
        [
            ("interval".to_owned(), Some(first)),
            ("topicChanged".to_owned(), Some(second)),
        ]
    );
}

/// Spec «Находка из Outline»: the journal links the phrase that triggered
/// the slow call, its queries, the candidate, the finding, the fast loop's
/// calls that were given it, and the question that cited it.
#[tokio::test(start_paused = true)]
async fn a_finding_from_outline_is_chained_in_the_journal() {
    let rig = Rig::new(
        true,
        [found("В смене три оператора", json!(["старший смены"]))],
    )
    .await;
    let trigger = rig.client(ABOUT_SHIFTS).await;
    rig.until(66).await;
    let finding = rig.findings()[0].id.clone();
    let slow = rig.slow_calls()[0].id.clone();
    rig.client("Иногда операторы уходят на перерыв").await;
    rig.until(95).await;
    rig.client("Тогда старший смены их подменяет").await;
    rig.until(125).await;
    // The third fast call after the finding cites it.
    let start_ms = i64::try_from(rig.t0.elapsed().as_millis()).unwrap();
    let said = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            start_ms,
            "У нас пять операторов в смену, иногда шесть",
        )
    });
    let evidence =
        json!({ "source": "segment", "id": said.id, "quote": "пять операторов в смену" });
    rig.fast_agent.push(Step::patch(json!({ "ops": [
        { "op": "topic", "action": "create", "title": "Смены" },
        {
            "op": "question", "title": "Кто распределяет звонки между линиями?",
            "description": "В регламенте — старший смены", "cardField": "scenarios",
            "gapType": "empty", "priority": 2,
            "evidence": [evidence, { "source": "document", "id": "D1", "quote": "в смене три оператора" }]
        }
    ] })));
    rig.fast_loop
        .phrase_with_id(&rig.recording, OTHERS, &said.id);
    rig.slow_loop
        .phrase(&rig.recording, OTHERS, "пять операторов", Some(&said.id));
    settle().await;
    rig.until(160).await;

    let question = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap()
        .questions[0]
        .id
        .clone();
    rig.host.db(|db| {
        let one = |sql: &str, id: &str| -> String {
            db.query_row(sql, [id], |row| row.get(0)).unwrap()
        };
        // The slow call: its trigger, its queries, its candidate, its finding.
        assert_eq!(
            one("SELECT trigger_segment_id FROM agent_calls WHERE id = ?1", &slow),
            trigger
        );
        assert!(
            one("SELECT json_extract(queries, '$.client') FROM agent_calls WHERE id = ?1", &slow)
                .contains("операторы смены")
        );
        assert_eq!(
            one(
                "SELECT source_name FROM slow_loop_candidates WHERE agent_call_id = ?1 AND label = 'C1'",
                &slow
            ),
            "Регламент смены"
        );
        assert_eq!(
            one(
                "SELECT agent_call_id FROM agent_call_ops
                  WHERE subject_id = ?1 AND op = 'finding' AND applied = 1",
                &finding
            ),
            slow
        );
        // The fast loop's calls that were given it.
        let given: i64 = db
            .query_row(
                "SELECT count(*) FROM agent_calls, json_each(agent_calls.findings_in_prompt)
                  WHERE kind = 'fastLoop' AND json_each.value = ?1",
                [&finding],
                |row| row.get(0),
            )
            .unwrap();
        assert!(given >= 3, "{given}");
        // The question that cited it came from one of them.
        let creator = one(
            "SELECT agent_call_id FROM agent_call_ops
              WHERE subject_id = ?1 AND op = 'question' AND applied = 1",
            &question,
        );
        assert!(
            one("SELECT findings_in_prompt FROM agent_calls WHERE id = ?1", &creator)
                .contains(&finding)
        );
        assert_eq!(
            one("SELECT question_id FROM context_findings WHERE id = ?1", &finding),
            question
        );
    });
}
