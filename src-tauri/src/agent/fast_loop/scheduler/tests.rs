//! The scenarios of `specs/agent-fast-loop` «Когда запускается вызов» and
//! «Состояние агента» on a paused clock with a fake agent.

use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tokio::time::Instant;

use super::*;
use crate::{
    agent::{
        claude_cli::Usage,
        fast_loop::testing::{
            FakeAgent, Provider, Reported, Step, TestHost, database, recording, say, set_setting,
        },
    },
    storage::{
        call_state::AgentCallOutcome,
        projects::{self, ProjectUpdate},
        recordings,
        transcript::TranscriptSegment,
    },
};

const OTHERS: TranscriptChannel = TranscriptChannel::Others;
const ME: TranscriptChannel = TranscriptChannel::Me;

struct Rig {
    host: Arc<TestHost>,
    agent: Arc<FakeAgent>,
    provider: Arc<Provider>,
    fast_loop: FastLoop,
    recording: String,
    t0: Instant,
    dir: tempfile::TempDir,
}

/// Lets the loop's tasks and the database work run; the clock moves a
/// few ms at most.
async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
}

impl Rig {
    async fn new(steps: impl IntoIterator<Item = Step>) -> Self {
        Self::with(steps, true).await
    }

    async fn with(steps: impl IntoIterator<Item = Step>, ready: bool) -> Self {
        let db = database();
        let recording = recording(&db);
        let host = TestHost::new(db);
        let agent = FakeAgent::new(steps);
        let provider = if ready {
            Provider::ready(agent.clone())
        } else {
            Provider::not_ready(AgentLoopState::NeedsLogin)
        };
        let dir = tempfile::tempdir().unwrap();
        let fast_loop = crate::agent::fast_loop::testing::fast_loop(
            host.clone(),
            provider.clone(),
            dir.path().join("agent"),
        );
        let rig = Self {
            host,
            agent,
            provider,
            fast_loop,
            recording,
            t0: Instant::now(),
            dir,
        };
        rig.fast_loop.live_started(&rig.recording);
        settle().await;
        rig
    }

    /// Seconds since the start, whole.
    fn at(&self, instant: Instant) -> u64 {
        (instant - self.t0).as_secs()
    }

    fn starts(&self) -> Vec<u64> {
        self.agent
            .starts()
            .into_iter()
            .map(|at| self.at(at))
            .collect()
    }

    /// Stores a phrase now (by the paused clock) and tells the loop.
    async fn say(&self, channel: TranscriptChannel, text: &str) -> TranscriptSegment {
        let start_ms = i64::try_from(self.t0.elapsed().as_millis()).unwrap();
        let segment = self
            .host
            .db(|db| say(db, &self.recording, channel, start_ms, text));
        self.fast_loop.phrase(&self.recording, channel);
        settle().await;
        segment
    }

    /// Until `seconds` after the start.
    async fn until(&self, seconds: u64) {
        tokio::time::sleep_until(self.t0 + Duration::from_secs(seconds)).await;
        settle().await;
    }

    fn calls(&self) -> Vec<call_state::AgentCall> {
        self.host
            .db(|db| call_state::agent_calls(db, &self.recording))
            .unwrap()
    }

    fn state(&self) -> AgentLoopState {
        self.fast_loop.status(&self.recording).state
    }

    fn setting(&self, key: &str, value: Value) {
        self.host.db(|db| set_setting(db, key, value));
    }
}

/* Когда запускается вызов */

#[tokio::test(start_paused = true)]
async fn a_phrase_of_others_starts_a_call_one_of_me_does_not() {
    let rig = Rig::new([]).await;
    assert_eq!(rig.state(), AgentLoopState::Idle);
    rig.say(ME, "Расскажите, как сейчас принимаете звонки")
        .await;
    assert_eq!(rig.agent.calls(), 0);

    rig.say(OTHERS, "Звонки идут на личные телефоны").await;
    assert_eq!(rig.starts(), [0]);
    assert_eq!(rig.state(), AgentLoopState::Thinking);
    rig.until(6).await;
    assert_eq!(rig.state(), AgentLoopState::Idle);
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Empty);
}

/// «Клиент закончил фразу»: «обычно», the last call started 8 s ago and
/// ended; the client speaks, then the manager: a call at once.
#[tokio::test(start_paused = true)]
async fn the_client_finished_a_turn() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Первая фраза клиента").await;
    rig.until(7).await;
    rig.say(OTHERS, "Вторая фраза клиента").await;
    assert_eq!(rig.starts(), [0], "the client may go on");
    rig.until(8).await;
    rig.say(ME, "Понял, а сколько у вас операторов?").await;
    assert_eq!(rig.starts(), [0, 8]);
}

/// «Клиент продолжает говорить»: the manager is silent; the call comes
/// 20 s after the last start, by itself.
#[tokio::test(start_paused = true)]
async fn the_client_goes_on_and_the_interval_starts_the_call() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Первая фраза клиента").await;
    for second in [8, 12, 16] {
        rig.until(second).await;
        rig.say(OTHERS, "И ещё про очередь").await;
    }
    rig.until(19).await;
    assert_eq!(rig.starts(), [0]);
    rig.until(21).await;
    assert_eq!(rig.starts(), [0, 20]);
}

/// «Слишком рано»: «реже», 12 s after the last start the turn ended; the
/// call waits for the 30 s gap and starts by itself.
#[tokio::test(start_paused = true)]
async fn too_early_starts_by_itself_once_the_gap_passes() {
    let rig = Rig::new([]).await;
    rig.setting(settings::QUESTION_FREQUENCY, json!("rare"));
    rig.say(OTHERS, "Первая фраза клиента").await;
    rig.until(12).await;
    rig.say(OTHERS, "Слишком рано").await;
    rig.say(ME, "Угу").await;
    rig.until(29).await;
    assert_eq!(rig.starts(), [0], "the gap hasn't passed");
    rig.until(31).await;
    assert_eq!(rig.starts(), [0, 30]);
}

/// «Тишина»: no phrases since the last call, no call.
#[tokio::test(start_paused = true)]
async fn silence_starts_nothing() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Единственная фраза").await;
    rig.until(300).await;
    assert_eq!(rig.starts(), [0]);
}

/// Phrases of the manager alone don't make a call due.
#[tokio::test(start_paused = true)]
async fn the_managers_phrases_make_no_call_due() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Фраза клиента").await;
    rig.until(10).await;
    rig.say(ME, "А сколько у вас операторов?").await;
    rig.until(60).await;
    assert_eq!(rig.starts(), [0]);
}

/// «Фраза во время вызова»: one call at a time; the client and then the
/// manager speak during a 25 s call: the next starts as it ends, with no
/// other phrase, and gets the client's.
#[tokio::test(start_paused = true)]
async fn a_turn_during_a_call_starts_the_next_when_it_ends() {
    let rig = Rig::new([Step::empty().after(Duration::from_secs(25))]).await;
    rig.say(OTHERS, "Первая фраза").await;
    rig.until(10).await;
    let during = rig.say(OTHERS, "Пока агент думает").await;
    rig.say(ME, "Ясно").await;
    assert_eq!(rig.starts(), [0], "a call is running");
    rig.until(26).await;
    assert_eq!(rig.starts(), [0, 25]);
    let message = rig.agent.received(1).request.user_message;
    assert!(message.contains(&during.id), "{message}");
}

/// A turn that ended during a short call: the next starts when the 5 s gap
/// passes.
#[tokio::test(start_paused = true)]
async fn a_turn_during_a_short_call_waits_for_the_gap() {
    let rig = Rig::new([Step::empty().after(Duration::from_secs(2))]).await;
    rig.say(OTHERS, "Первая фраза").await;
    rig.until(1).await;
    rig.say(OTHERS, "Пока агент думает").await;
    rig.say(ME, "Ага").await;
    rig.until(4).await;
    assert_eq!(rig.starts(), [0], "the call ended at 2 s, the gap is 5 s");
    rig.until(6).await;
    assert_eq!(rig.starts(), [0, 5]);
}

/// A phrase of the manager before the client's doesn't end the client's
/// turn.
#[tokio::test(start_paused = true)]
async fn the_manager_before_the_client_is_no_turn_end() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Первая фраза клиента").await;
    rig.until(6).await;
    rig.say(ME, "А как сейчас?").await;
    rig.say(OTHERS, "Сейчас всё вручную").await;
    rig.until(19).await;
    assert_eq!(rig.starts(), [0]);
    rig.until(21).await;
    assert_eq!(rig.starts(), [0, 20]);
}

#[tokio::test(start_paused = true)]
async fn the_frequency_is_read_at_every_phrase() {
    let rig = Rig::new([]).await;
    rig.setting(settings::QUESTION_FREQUENCY, json!("often"));
    rig.say(OTHERS, "Раз").await;
    rig.until(6).await;
    rig.say(OTHERS, "Два").await;
    rig.say(ME, "Понял").await;
    assert_eq!(rig.starts(), [0, 6], "no gap after a turn");

    rig.setting(settings::QUESTION_FREQUENCY, json!("rare"));
    rig.until(20).await;
    rig.say(OTHERS, "Три: 14 с после второго").await;
    rig.say(ME, "Угу").await;
    assert_eq!(rig.starts(), [0, 6]);
    rig.until(37).await;
    assert_eq!(rig.starts(), [0, 6, 36]);
}

#[test]
fn intervals_by_frequency() {
    let interval = |value: Value| {
        settings::question_interval(&settings::SettingsMap::from([(
            settings::QUESTION_FREQUENCY.to_owned(),
            value,
        )]))
    };
    assert_eq!(interval(json!("rare")), Duration::from_secs(45));
    assert_eq!(interval(json!("normal")), Duration::from_secs(20));
    assert_eq!(interval(json!("often")), Duration::from_secs(10));
    assert_eq!(
        settings::question_interval(&settings::SettingsMap::new()),
        Duration::from_secs(20)
    );
}

#[test]
fn gaps_by_frequency() {
    let gap = |value: Value| {
        settings::question_gap(&settings::SettingsMap::from([(
            settings::QUESTION_FREQUENCY.to_owned(),
            value,
        )]))
    };
    assert_eq!(gap(json!("rare")), Duration::from_secs(30));
    assert_eq!(gap(json!("normal")), Duration::from_secs(5));
    assert_eq!(gap(json!("often")), Duration::ZERO);
    assert_eq!(gap(json!("sometimes")), Duration::from_secs(5));
    assert_eq!(
        settings::question_gap(&settings::SettingsMap::new()),
        Duration::from_secs(5)
    );
}

/* Состояние агента */

/// «Сбой вызова»: «ошибка» with the retry time, the call again 30 s later
/// by itself and not before.
#[tokio::test(start_paused = true)]
async fn a_failed_call_is_retried_after_30_s() {
    let rig = Rig::new([Step::fail(AgentError::Process("boom".to_owned()))]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(6).await;
    let AgentLoopState::Error { message, retry_at } = rig.state() else {
        panic!("not an error: {:?}", rig.state());
    };
    assert_eq!(message, "boom");
    let wait = retry_at.unwrap() - now_ms();
    assert!((29_000..=30_000).contains(&wait), "{wait}");
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Error);
    assert_eq!(rig.calls()[0].error.as_deref(), Some("boom"));

    rig.until(21).await;
    rig.say(OTHERS, "Фраза до повтора").await;
    rig.until(34).await;
    assert_eq!(rig.starts(), [0], "not before 30 s");
    rig.until(36).await;
    assert_eq!(rig.starts(), [0, 35]);
    rig.until(41).await;
    assert_eq!(rig.state(), AgentLoopState::Idle);
}

/// «Повторить» starts a call at once.
#[tokio::test(start_paused = true)]
async fn agent_retry_calls_at_once() {
    let rig = Rig::new([Step::fail(AgentError::Process("boom".to_owned()))]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(10).await;
    rig.fast_loop.retry(&rig.recording).unwrap();
    settle().await;
    assert_eq!(rig.starts(), [0, 10]);
    assert_eq!(rig.state(), AgentLoopState::Thinking);
    rig.until(60).await;
    assert_eq!(rig.starts(), [0, 10], "the timer was replaced by the retry");
    assert!(matches!(
        rig.fast_loop.retry("other"),
        Err(CommandError::NotFound { .. })
    ));
}

/// «Вход истёк»: «нужен вход», no calls until a status check finds the
/// agent ready; the recording goes on.
#[tokio::test(start_paused = true)]
async fn not_logged_in_stops_the_calls_until_the_agent_is_ready() {
    let rig = Rig::new([Step::fail(AgentError::NotLoggedIn)]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(6).await;
    assert_eq!(rig.state(), AgentLoopState::NeedsLogin);
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::NotLoggedIn);
    rig.until(40).await;
    rig.say(OTHERS, "Запись идёт").await;
    rig.until(120).await;
    rig.say(OTHERS, "И дальше").await;
    assert_eq!(rig.starts(), [0]);

    rig.fast_loop.agent_ready();
    settle().await;
    assert_eq!(rig.state(), AgentLoopState::Idle);
    rig.say(OTHERS, "После входа").await;
    assert_eq!(rig.starts(), [0, 120]);
}

#[tokio::test(start_paused = true)]
async fn rate_limited_stops_the_calls_until_the_limit_resets() {
    let resets_at = now_ms() + 120_000;
    let rig = Rig::new([Step::fail(AgentError::RateLimited {
        resets_at: Some(resets_at),
    })])
    .await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(6).await;
    assert_eq!(
        rig.state(),
        AgentLoopState::RateLimited {
            resets_at: Some(resets_at)
        }
    );
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::RateLimited);
    rig.until(60).await;
    rig.say(OTHERS, "Лимит ещё не сброшен").await;
    assert_eq!(rig.starts(), [0]);

    // The paused clock moved 5 s by the failure, the wall clock did not:
    // the reset comes 120 s after the failure.
    rig.until(124).await;
    assert!(matches!(rig.state(), AgentLoopState::RateLimited { .. }));
    rig.until(126).await;
    assert_eq!(rig.state(), AgentLoopState::Idle);
    rig.say(OTHERS, "Лимит сброшен").await;
    assert_eq!(rig.starts(), [0, 126]);
}

#[tokio::test(start_paused = true)]
async fn rate_limited_without_a_reset_waits_for_a_retry() {
    let rig = Rig::new([Step::fail(AgentError::RateLimited { resets_at: None })]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(3_600).await;
    rig.say(OTHERS, "Через час").await;
    assert_eq!(rig.starts(), [0]);
    assert_eq!(rig.state(), AgentLoopState::RateLimited { resets_at: None });
    rig.fast_loop.retry(&rig.recording).unwrap();
    settle().await;
    assert_eq!(rig.starts(), [0, 3_600]);
}

/// «Зависший вызов»: cancelled after 30 s, the call goes on, the next call
/// follows the usual rules (a retry 30 s after the error).
#[tokio::test(start_paused = true)]
async fn a_hanging_call_is_cancelled() {
    let rig = Rig::new([Step::empty().after(Duration::MAX)]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(31).await;
    assert_eq!(rig.state(), AgentLoopState::Thinking);
    rig.until(33).await;
    assert!(
        matches!(&rig.state(), AgentLoopState::Error { message, .. } if message == "Агент не ответил вовремя"),
        "{:?}",
        rig.state()
    );
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Timeout);
    rig.until(63).await;
    assert_eq!(rig.starts(), [0, 62]);
}

/// The agent is not installed or not signed in when the recording starts:
/// no calls, the phrases wait; a retry once it is ready runs them.
#[tokio::test(start_paused = true)]
async fn no_calls_while_the_agent_is_not_ready() {
    let rig = Rig::with([], false).await;
    assert_eq!(rig.state(), AgentLoopState::NeedsLogin);
    rig.say(OTHERS, "Запись идёт без агента").await;
    rig.until(60).await;
    rig.say(OTHERS, "И дальше").await;
    assert_eq!(rig.agent.calls(), 0);
    assert!(!rig.dir.path().join("agent").exists(), "no prefix yet");

    rig.fast_loop.retry(&rig.recording).unwrap();
    settle().await;
    assert_eq!(rig.state(), AgentLoopState::NeedsLogin, "still not ready");
    assert_eq!(rig.agent.calls(), 0);

    *rig.provider.agent.lock().unwrap() = Ok(rig.agent.clone());
    rig.fast_loop.agent_ready();
    settle().await;
    assert_eq!(rig.starts(), [60], "the waiting phrases start a call");
}

/// The running call is cancelled (and recorded so): it doesn't apply a
/// late patch, nor overlap the next recording's call.
#[tokio::test(start_paused = true)]
async fn the_end_of_the_live_pass_cancels_the_call_and_stops_the_scheduler() {
    let rig = Rig::new([]).await;
    let prompt = assembly::prompt_path(&rig.dir.path().join("agent"), &rig.recording);
    assert!(prompt.exists());
    rig.say(OTHERS, "Фраза").await;
    assert_eq!(rig.state(), AgentLoopState::Thinking);
    rig.fast_loop.live_finished(&rig.recording);
    settle().await;
    let calls = rig.calls();
    assert_eq!(calls.len(), 1, "the cancelled call is recorded");
    assert_eq!(calls[0].outcome, AgentCallOutcome::Cancelled);
    assert!(!prompt.exists());
    assert_eq!(rig.host.last_state(), Some(AgentLoopState::Idle));
    assert_eq!(rig.state(), AgentLoopState::Idle);
    assert_eq!(rig.fast_loop.kept_statuses(), 0, "nothing kept for it");

    rig.until(60).await;
    rig.say(OTHERS, "После остановки").await;
    assert_eq!(rig.starts(), [0]);
    assert_eq!(rig.host.changes(), 0, "no late patch");
    assert!(rig.fast_loop.retry(&rig.recording).is_err());
}

/// «Одновременно MUST идти не больше одного вызова», across recordings:
/// a second recording's call waits for the first.
#[tokio::test(start_paused = true)]
async fn one_call_at_a_time_across_recordings() {
    let ten = Duration::from_secs(10);
    let rig = Rig::new([Step::empty().after(ten), Step::empty().after(ten)]).await;
    let other = rig.host.db(recording);
    rig.fast_loop.live_started(&other);
    settle().await;

    rig.say(OTHERS, "Фраза первой записи").await;
    rig.host
        .db(|db| say(db, &other, OTHERS, 1_000, "Фраза второй записи"));
    rig.fast_loop.phrase(&other, OTHERS);
    settle().await;
    assert_eq!(rig.agent.calls(), 1, "the second waits");
    rig.until(11).await;
    assert_eq!(rig.agent.calls(), 2);
    rig.until(30).await;
    assert_eq!(rig.starts(), [0, 10]);
    assert_eq!(rig.agent.most_at_once(), 1);
    assert_eq!(rig.fast_loop.status(&other).state, AgentLoopState::Idle);
}

/// The manager stops recording A while its call runs and starts B at once:
/// A's call is cancelled, B's runs alone.
#[tokio::test(start_paused = true)]
async fn a_stopped_recording_does_not_overlap_the_next() {
    let rig = Rig::new([Step::empty().after(Duration::MAX), Step::empty()]).await;
    rig.say(OTHERS, "Фраза записи А").await;
    rig.fast_loop.live_finished(&rig.recording);
    let next = rig.host.db(recording);
    rig.fast_loop.live_started(&next);
    settle().await;
    rig.host
        .db(|db| say(db, &next, OTHERS, 0, "Фраза записи Б"));
    rig.fast_loop.phrase(&next, OTHERS);
    settle().await;
    rig.until(10).await;
    assert_eq!(rig.agent.calls(), 2);
    assert_eq!(rig.agent.most_at_once(), 1);
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Cancelled);
    let next_calls = rig
        .host
        .db(|db| call_state::agent_calls(db, &next))
        .unwrap();
    assert_eq!(next_calls[0].outcome, AgentCallOutcome::Empty);
}

/// The app quits during a call: it is cancelled, the prefix files go at
/// once (the process exits right after), and nothing starts again.
#[tokio::test(start_paused = true)]
async fn the_apps_exit_cancels_the_call_and_removes_the_prompts() {
    let rig = Rig::new([Step::empty().after(Duration::MAX)]).await;
    let dir = rig.dir.path().join("agent");
    let prompt = assembly::prompt_path(&dir, &rig.recording);
    let left = assembly::prompt_path(&dir, "0196f3a2-crashed");
    std::fs::write(&left, "бриф").unwrap();
    rig.say(OTHERS, "Фраза").await;
    assert_eq!(rig.state(), AgentLoopState::Thinking);

    rig.fast_loop.shutdown();
    assert!(!prompt.exists() && !left.exists());
    settle().await;
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Cancelled);
    assert_eq!(rig.state(), AgentLoopState::Idle);

    rig.fast_loop.live_started(&rig.recording);
    rig.until(60).await;
    rig.say(OTHERS, "После выхода").await;
    assert_eq!(rig.agent.calls(), 1);
    assert!(rig.fast_loop.retry(&rig.recording).is_err());
}

/// At startup: the prefix files no live recording owns are removed, other
/// files stay.
#[tokio::test(start_paused = true)]
async fn the_sweep_keeps_only_the_prompts_of_live_recordings() {
    let rig = Rig::new([]).await;
    let dir = rig.dir.path().join("agent");
    let live = assembly::prompt_path(&dir, &rig.recording);
    let left = [
        assembly::prompt_path(&dir, "0196f3a2-a"),
        assembly::prompt_path(&dir, "0196f3a2-b"),
    ];
    for file in &left {
        std::fs::write(file, "бриф и профили").unwrap();
    }
    let other = dir.join("notes.md");
    std::fs::write(&other, "не промпт").unwrap();

    assert_eq!(rig.fast_loop.sweep_prompts(), 2);
    assert!(live.exists());
    assert!(left.iter().all(|file| !file.exists()));
    assert!(other.exists());
    assert_eq!(rig.fast_loop.sweep_prompts(), 0);
}

/// A not-ready state found after the recording ended doesn't stick to it:
/// the windows get `idle`, `call_state_get` says `idle`, nothing is kept.
#[tokio::test(start_paused = true)]
async fn a_state_found_after_the_recording_ended_does_not_stick() {
    let rig = Rig::with([], false).await;
    assert_eq!(rig.state(), AgentLoopState::NeedsLogin);
    // The check takes a while; the recording stops meanwhile.
    *rig.provider.delay.lock().unwrap() = Duration::from_secs(5);
    rig.fast_loop.retry(&rig.recording).unwrap();
    rig.until(1).await;
    rig.fast_loop.live_finished(&rig.recording);
    rig.until(10).await;
    assert_eq!(rig.state(), AgentLoopState::Idle);
    assert_eq!(rig.host.last_state(), Some(AgentLoopState::Idle));
    assert_eq!(rig.fast_loop.kept_statuses(), 0);

    // Stopped while waiting for the agent: the same.
    let rig = Rig::with([], false).await;
    rig.fast_loop.live_finished(&rig.recording);
    assert_eq!(rig.state(), AgentLoopState::Idle);
    assert_eq!(rig.host.last_state(), Some(AgentLoopState::Idle));
    assert_eq!(rig.fast_loop.kept_statuses(), 0);
}

/// «CLI сообщил лимит»: the windows get 0.82, the call is stored with its
/// duration and tokens.
#[tokio::test(start_paused = true)]
async fn the_limit_share_and_the_usage_are_kept() {
    let mut step = Step::empty();
    step.usage = Usage {
        duration_ms: 12_800,
        input_tokens: 2,
        output_tokens: 1_464,
        cache_read: 5_400,
        cache_write: 300,
        cost_usd: Some(0.04),
        utilization: Some(0.82),
        resets_at: None,
    };
    let rig = Rig::new([step]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(6).await;
    let status = rig.fast_loop.status(&rig.recording);
    assert_eq!(status.utilization, Some(0.82));
    assert_eq!(status.state, AgentLoopState::Idle);
    let reported = rig.host.reported.lock().unwrap().clone();
    assert!(reported.contains(&Reported::Status(status)));
    let call = &rig.calls()[0];
    assert_eq!(call.duration_ms, 12_800);
    assert_eq!(
        (
            call.input_tokens,
            call.output_tokens,
            call.cache_read,
            call.cache_write
        ),
        (Some(2), Some(1_464), Some(5_400), Some(300))
    );
    assert_eq!(call.cost_usd, Some(0.04));
    assert_eq!(call.utilization, Some(0.82));
}

/* What the calls get and what comes of them */

/// «Стабильная часть не меняется»: two calls of a recording get the same
/// prefix file, byte for byte, even after the project changed.
#[tokio::test(start_paused = true)]
async fn the_prefix_is_byte_identical_across_calls() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Первая").await;
    rig.host.db(|db| {
        let project_id = recordings::get(db, &rig.recording)
            .unwrap()
            .project_id
            .unwrap();
        projects::update(
            db,
            &project_id,
            ProjectUpdate {
                description: Some("Совсем другое описание".to_owned()),
                ..ProjectUpdate::default()
            },
        )
        .unwrap();
    });
    rig.until(25).await;
    rig.say(OTHERS, "Вторая").await;
    let (first, second) = (rig.agent.received(0), rig.agent.received(1));
    assert!(!first.prompt.is_empty());
    assert_eq!(first.prompt, second.prompt);
    assert_eq!(
        first.request.system_prompt_file,
        second.request.system_prompt_file
    );
    let prompt = String::from_utf8(first.prompt).unwrap();
    assert!(prompt.contains("P1: Единая система приёма звонков"));
    assert_ne!(first.request.user_message, second.request.user_message);
    assert_eq!(first.request.schema, patch::schema_argument());
}

/// A finding of the slow loop in the recording, found at `at` (ms).
fn found(rig: &Rig, quote: &str, at: i64) -> String {
    use crate::storage::context_findings::{self, FindingSourceKind, Inserted, NewFinding};
    let inserted = rig.host.db(|db| {
        context_findings::insert_at(
            db,
            &rig.recording,
            &NewFinding {
                source_id: None,
                source_kind: FindingSourceKind::Outline,
                source_name: "Регламент смены".to_owned(),
                source_url: Some("https://outline.example/doc/reg".to_owned()),
                chunk_key: format!("reg#{at}"),
                quote: quote.to_owned(),
                note: "Противоречит: в регламенте три оператора".to_owned(),
                question_id: None,
                agent_call_id: None,
            },
            at,
        )
        .unwrap()
    });
    let Inserted::Added { id, .. } = inserted else {
        panic!("no room");
    };
    id
}

/// Spec «Стабильная часть не меняется» with a finding between the calls:
/// the prefixes are the same bytes, the finding is only in the second
/// call's state, as `D1`.
#[tokio::test(start_paused = true)]
async fn a_finding_between_two_calls_leaves_the_prefix_alone() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Первая").await;
    found(&rig, "В смене три оператора", 1_000);
    rig.until(25).await;
    rig.say(OTHERS, "Вторая").await;
    let (first, second) = (rig.agent.received(0), rig.agent.received(1));
    assert!(!first.prompt.is_empty());
    assert_eq!(first.prompt, second.prompt);
    assert!(
        !String::from_utf8(first.prompt)
            .unwrap()
            .contains("В смене три оператора")
    );
    assert!(!first.request.user_message.contains("Найдено в материалах"));
    let message = second.request.user_message;
    assert!(
        message.contains(
            "# Найдено в материалах\n\nНаходки медленного контура в источниках проекта — \
             материал проекта, а не слова клиента:\n\
             - [D1] Outline «Регламент смены»: «В смене три оператора» — \
             Противоречит: в регламенте три оператора\n"
        ),
        "{message}"
    );
}

/// Spec «Убрать» in the fast loop: a finding hidden during the call makes
/// the operation that cites it stale; the next call doesn't get it. A new
/// question that cites a finding links it.
#[tokio::test(start_paused = true)]
async fn a_hidden_finding_is_stale_and_gone_from_the_next_call() {
    let rig = Rig::new([]).await;
    let segment = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            0,
            "У нас пять операторов в смену, иногда шесть",
        )
    });
    let kept = found(&rig, "Старший смены распределяет звонки по линиям", 500);
    let hidden = found(&rig, "В смене три оператора", 1_000);
    let said = json!({ "source": "segment", "id": segment.id, "quote": "пять операторов в смену" });
    rig.agent.push(Step::patch(json!({ "ops": [
        { "op": "topic", "action": "create", "title": "Смены" },
        { "op": "card", "field": "users", "value": "Пять операторов",
          "evidence": [said.clone()] },
        {
            "op": "question", "title": "Так пять операторов в смене или три?",
            "description": "Клиент и регламент расходятся", "cardField": "users",
            "gapType": "contradiction", "priority": 3,
            "evidence": [said.clone(), { "source": "document", "id": "D2", "quote": "в смене три оператора" }]
        },
        {
            "op": "question", "title": "Кто распределяет звонки между линиями?",
            "description": "В регламенте — старший смены", "cardField": "scenarios",
            "gapType": "empty", "priority": 2,
            "evidence": [said, { "source": "document", "id": "[D1]", "quote": "старший смены распределяет звонки" }]
        }
    ] })));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(2).await;
    assert_eq!(rig.state(), AgentLoopState::Thinking);
    let message = rig.agent.received(0).request.user_message;
    assert!(message.contains("- [D1] Outline"), "{message}");
    assert!(message.contains("- [D2] Outline «Регламент смены»: «В смене три оператора»"));
    rig.host.db(|db| {
        crate::storage::context_findings::hide(db, &rig.recording, &hidden, 2_000).unwrap();
    });
    rig.until(6).await;

    let call = &rig.calls()[0];
    assert_eq!(call.outcome, AgentCallOutcome::Ok);
    assert_eq!(call.rejected[0]["index"], 2);
    assert_eq!(call.rejected[0]["reason"], "stale", "{}", call.rejected);
    assert_eq!(call.rejected[0]["cause"]["reason"], "unknownSource");
    let state = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap();
    let texts: Vec<&str> = state.questions.iter().map(|q| q.text.as_str()).collect();
    assert_eq!(texts, ["Кто распределяет звонки между линиями?"]);
    assert_eq!(
        state.questions[0].evidence[1].id, kept,
        "the finding's id is stored"
    );
    assert_eq!(state.findings.len(), 1);
    assert_eq!(
        state.findings[0].question_id.as_deref(),
        Some(state.questions[0].id.as_str()),
        "the question links its finding"
    );

    rig.until(25).await;
    rig.say(OTHERS, "Ещё фраза").await;
    let message = rig.agent.received(1).request.user_message;
    assert!(!message.contains("В смене три оператора"), "{message}");
    assert!(message.contains("- [D1] Outline «Регламент смены»: «Старший смены"));
}

fn applied_patch(segment: &TranscriptSegment, quote: &str) -> Value {
    let evidence =
        json!([{ "source": "segment", "id": format!("S:{}", segment.id), "quote": quote }]);
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
        }
    ] })
}

#[tokio::test(start_paused = true)]
async fn a_patch_is_checked_applied_and_reported() {
    let rig = Rig::new([]).await;
    let segment = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            0,
            "Если все заняты, тогда уже как получится",
        )
    });
    rig.agent
        .push(Step::patch(applied_patch(&segment, "если все заняты")));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(6).await;

    assert_eq!(rig.host.changes(), 1);
    let state = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap();
    assert_eq!(state.topics[0].title, "Очередь операторов");
    let question = &state.questions[0];
    assert_eq!(
        question.text,
        "Что происходит со звонком, если все операторы заняты?"
    );
    assert!(question.visible);
    assert_eq!(question.rank, Some(0));
    assert_eq!(question.evidence[0].id, segment.id);
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Ok);
    assert_eq!(rig.calls()[0].rejected, json!([]));
    assert_eq!(rig.state(), AgentLoopState::Idle);

    // The next call sees it with its id.
    rig.until(25).await;
    rig.say(OTHERS, "Ещё фраза").await;
    let message = rig.agent.received(1).request.user_message;
    assert!(
        message.contains(&format!("[Q:{}]", question.id)),
        "{message}"
    );
}

/// The times the loop writes come from the host's clock, not the system's
/// (question-quality design.md, decision 3): a host a day behind stores a
/// day-old call, topic and question.
#[tokio::test(start_paused = true)]
async fn the_times_written_follow_the_hosts_clock() {
    const DAY_MS: i64 = 24 * 60 * 60 * 1000;
    let rig = Rig::new([]).await;
    rig.host.clock_shift.store(-DAY_MS, Ordering::SeqCst);
    let segment = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            0,
            "Если все заняты, тогда уже как получится",
        )
    });
    rig.agent
        .push(Step::patch(applied_patch(&segment, "если все заняты")));
    let before = now_ms();
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(6).await;
    let after = now_ms();

    let shifted = |at: i64| (before - DAY_MS..=after - DAY_MS).contains(&at);
    let state = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap();
    let question = &state.questions[0];
    assert!(shifted(question.created_at), "{}", question.created_at);
    assert!(shifted(question.shown_at.unwrap()));
    assert!(shifted(state.topics[0].created_at));
    assert!(shifted(state.cards[0].updated_at));
    let call = &rig.calls()[0];
    assert!(shifted(call.started_at), "{}", call.started_at);
    assert!(shifted(call.created_at));
}

/// The client answers Q1; while the call runs the manager hides Q1. The
/// answer is stale and logged so; the card field and the new question still
/// apply, and the call is no error.
#[tokio::test(start_paused = true)]
async fn a_quick_action_during_the_call_drops_only_the_stale_step() {
    let rig = Rig::new([]).await;
    let first = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            0,
            "Если все заняты, тогда уже как получится",
        )
    });
    rig.agent
        .push(Step::patch(applied_patch(&first, "если все заняты")));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(6).await;
    let asked = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap()
        .questions[0]
        .id
        .clone();

    rig.until(25).await;
    let start_ms = i64::try_from(rig.t0.elapsed().as_millis()).unwrap();
    let answer = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            start_ms,
            "Тогда звонок уходит на автоответчик, потом перезваниваем",
        )
    });
    let evidence =
        json!([{ "source": "segment", "id": answer.id, "quote": "звонок уходит на автоответчик" }]);
    rig.agent.push(Step::patch(json!({ "ops": [
        { "op": "card", "field": "scenarios", "value": "Автоответчик, потом перезвон", "evidence": evidence },
        { "op": "answered", "questionId": asked, "evidence": evidence },
        {
            "op": "question", "title": "Через сколько минут перезванивают?",
            "description": "Срок перезвона не назван", "cardField": "scenarios",
            "gapType": "empty", "priority": 2, "evidence": evidence
        }
    ] })));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(27).await;
    assert_eq!(rig.state(), AgentLoopState::Thinking);
    rig.host
        .db(|db| call_state::act(db, &asked, call_state::QuestionAction::Hide))
        .unwrap();
    rig.until(31).await;

    assert_eq!(rig.state(), AgentLoopState::Idle, "no error");
    let state = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap();
    let hidden = state.questions.iter().find(|q| q.id == asked).unwrap();
    assert_eq!(hidden.status, call_state::QuestionStatus::Hidden);
    assert!(
        state
            .questions
            .iter()
            .any(|q| q.text == "Через сколько минут перезванивают?")
    );
    let card = state.current_card().unwrap();
    assert!(
        card.fields
            .iter()
            .any(|f| f.field == call_state::CardLens::Scenarios)
    );
    let call = &rig.calls()[1];
    assert_eq!(call.outcome, AgentCallOutcome::Ok);
    assert_eq!(call.rejected[0]["reason"], "stale", "{}", call.rejected);
    assert_eq!(call.rejected[0]["cause"]["reason"], "questionClosed");
    assert_eq!(call.rejected[0]["index"], 1);
    assert_eq!(rig.host.changes(), 2);
}

/// «Выдуманная цитата»: no question, the reason in `agent_calls.rejected`.
#[tokio::test(start_paused = true)]
async fn a_made_up_quote_leaves_no_question() {
    let rig = Rig::new([]).await;
    let segment = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            0,
            "Звонки идут на личные телефоны",
        )
    });
    rig.agent.push(Step::patch(applied_patch(
        &segment,
        "у нас двадцать операторов в смене",
    )));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(6).await;

    let state = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap();
    assert!(state.questions.is_empty());
    let call = &rig.calls()[0];
    let reasons: Vec<&str> = call
        .rejected
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|rejection| rejection["reason"].as_str())
        .collect();
    assert_eq!(
        reasons,
        ["quoteNotFound", "quoteNotFound"],
        "{}",
        call.rejected
    );
    // The topic still went through.
    assert_eq!(call.outcome, AgentCallOutcome::Ok);
    assert_eq!(rig.host.changes(), 1);
}

/// «Ответ не по схеме»: nothing changes, the call failed.
#[tokio::test(start_paused = true)]
async fn a_reply_off_the_schema_changes_nothing() {
    let rig = Rig::new([Step::patch(json!({ "ops": [{ "op": "dance" }] }))]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(6).await;
    assert_eq!(rig.host.changes(), 0);
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Invalid);
    assert!(matches!(rig.state(), AgentLoopState::Error { .. }));
}

/// «Пустой патч»: no change, no error.
#[tokio::test(start_paused = true)]
async fn an_empty_patch_is_no_error() {
    let rig = Rig::new([Step::empty()]).await;
    rig.say(OTHERS, "Фраза").await;
    rig.until(6).await;
    assert_eq!(rig.host.changes(), 0);
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Empty);
    assert_eq!(
        rig.host.states(),
        [
            AgentLoopState::Idle,
            AgentLoopState::Thinking,
            AgentLoopState::Idle
        ]
    );
}

/// «Вызов не помнит предыдущий»: the second call gets what the first one
/// stored.
#[tokio::test(start_paused = true)]
async fn the_second_call_gets_the_state_of_the_first() {
    let rig = Rig::new([]).await;
    let segment = rig.host.db(|db| {
        say(
            db,
            &rig.recording,
            OTHERS,
            0,
            "Если все заняты, тогда уже как получится",
        )
    });
    rig.agent
        .push(Step::patch(applied_patch(&segment, "если все заняты")));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(25).await;
    rig.say(OTHERS, "Вторая фраза").await;
    let message = rig.agent.received(1).request.user_message;
    for part in [
        "Очередь операторов (текущая)",
        "- edgeCases: Все операторы заняты",
        "Что происходит со звонком, если все операторы заняты?",
    ] {
        assert!(message.contains(part), "no «{part}» in\n{message}");
    }
}

/* Старый вопрос уступает место (question-volume, decision 3) */

/// A topic with three questions shown 9 minutes ago by the host's clock,
/// and, with `waiting`, a fourth that waits behind them.
fn shown_long_ago(rig: &Rig, waiting: bool) {
    use call_state::{
        CardLens, Evidence, EvidenceSource, GapType, NewQuestion, ValidatedOp, ValidatedPatch,
    };
    let ask = |text: &str| {
        ValidatedOp::AddQuestion(NewQuestion {
            text: text.to_owned(),
            description: String::new(),
            card_field: CardLens::Goal,
            gap_type: GapType::Empty,
            priority: 2,
            evidence: vec![Evidence {
                source: EvidenceSource::Segment,
                id: "S1".to_owned(),
                quote: "цитата".to_owned(),
            }],
        })
    };
    let then = rig.host.now_ms() - 9 * 60_000;
    let mut ops = vec![ValidatedOp::CreateTopic {
        title: "Очередь".to_owned(),
    }];
    ops.extend(["Первый", "Второй", "Третий"].map(ask));
    rig.host
        .db(|db| call_state::apply_patch_at(db, &rig.recording, &ValidatedPatch { ops }, then))
        .unwrap();
    if waiting {
        let ops = vec![ask("Новый")];
        rig.host
            .db(|db| {
                call_state::apply_patch_at(
                    db,
                    &rig.recording,
                    &ValidatedPatch { ops },
                    then + 1_000,
                )
            })
            .unwrap();
    }
}

fn visible_texts(rig: &Rig) -> Vec<String> {
    rig.host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap()
        .visible()
        .into_iter()
        .map(|question| question.text.clone())
        .collect()
}

/// An empty patch 9 minutes after the list filled, with a question
/// waiting: the oldest gives its place, the windows hear it once.
#[tokio::test(start_paused = true)]
async fn an_empty_patch_lets_a_waiting_question_in() {
    let rig = Rig::new([]).await;
    shown_long_ago(&rig, true);
    assert_eq!(visible_texts(&rig), ["Первый", "Второй", "Третий"]);
    rig.say(OTHERS, "Клиент говорит дальше").await;
    rig.until(6).await;
    assert_eq!(rig.calls()[0].outcome, AgentCallOutcome::Empty);
    assert_eq!(visible_texts(&rig), ["Второй", "Третий", "Новый"]);
    assert_eq!(rig.host.changes(), 1);
}

/// Nobody waits: the old questions stay, no event.
#[tokio::test(start_paused = true)]
async fn an_empty_patch_without_waiting_questions_changes_nothing() {
    let rig = Rig::new([]).await;
    shown_long_ago(&rig, false);
    rig.say(OTHERS, "Клиент говорит дальше").await;
    rig.until(6).await;
    assert_eq!(visible_texts(&rig), ["Первый", "Второй", "Третий"]);
    assert_eq!(rig.host.changes(), 0);
}

/* Проверка темы (question-volume, decision 2) */

/// The host's clock from the recording's start (`testing::recording`
/// starts at 1 s): the phrases' times and the loop's line up.
fn align_host_clock(rig: &Rig) {
    rig.host
        .clock_shift
        .store(1_000 - now_ms(), std::sync::atomic::Ordering::SeqCst);
}

fn move_host_clock(rig: &Rig, minutes: i64) {
    rig.host
        .clock_shift
        .fetch_add(minutes * 60_000, std::sync::atomic::Ordering::SeqCst);
}

/// The indexes of the agent's requests that were topic checks.
fn topic_checks(rig: &Rig) -> Vec<usize> {
    (0..rig.agent.calls())
        .filter(|index| rig.agent.received(*index).request.schema == topic_check::SCHEMA)
        .collect()
}

/// Stores a phrase of the client now by the host's clock (aligned with
/// the recording's start) without telling the loop yet.
fn store(rig: &Rig, text: &str) -> TranscriptSegment {
    let start_ms = rig.host.now_ms() - 1_000;
    rig.host
        .db(|db| say(db, &rig.recording, OTHERS, start_ms, text))
}

/// The client says `text` now by the host's clock.
async fn client_says(rig: &Rig, text: &str) {
    store(rig, text);
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.fast_loop.phrase(&rig.recording, ME);
    settle().await;
}

/// A topic made by the first call and seen current by the second; then
/// `minutes` of the host's clock pass.
async fn long_topic(rig: &Rig, minutes: i64) {
    align_host_clock(rig);
    let first = store(rig, "Если все заняты, тогда уже как получится");
    rig.agent
        .push(Step::patch(applied_patch(&first, "если все заняты")));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.until(8).await;
    move_host_clock(rig, 1);
    client_says(rig, "Звонок ждёт свободного оператора").await;
    rig.until(16).await;
    move_host_clock(rig, minutes);
}

/// The client speaks of the operators, and the agent's next answer is
/// `reply` (a topic check's, if one is due), given the phrase.
async fn operators(rig: &Rig, reply: impl FnOnce(&TranscriptSegment) -> Step) -> TranscriptSegment {
    let phrase = store(
        rig,
        "Операторы колл-центра сидят все под одним номером телефона",
    );
    rig.agent.push(reply(&phrase));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.fast_loop.phrase(&rig.recording, ME);
    rig.until(30).await;
    phrase
}

fn new_topic(phrase: &TranscriptSegment, quote: &str) -> Step {
    Step::patch(json!({
        "decision": "new",
        "title": "Работа операторов в чатах",
        "evidence": { "id": phrase.id, "quote": quote },
    }))
}

fn topic_titles(rig: &Rig) -> (Vec<String>, Option<String>) {
    let state = rig
        .host
        .db(|db| call_state::get(db, &rig.recording))
        .unwrap();
    let current = state.current_topic_id.as_deref().and_then(|id| {
        state
            .topics
            .iter()
            .find(|topic| topic.id == id)
            .map(|topic| topic.title.clone())
    });
    (
        state
            .topics
            .iter()
            .map(|topic| topic.title.clone())
            .collect(),
        current,
    )
}

fn topic_check_calls(rig: &Rig) -> Vec<call_state::AgentCall> {
    rig.calls()
        .into_iter()
        .filter(|call| call.kind == call_state::AgentCallKind::TopicCheck)
        .collect()
}

/// «Долгая тема ушла в другую подсистему»: a new topic with the quote of
/// the phrase it began with; the fast-loop call that follows sees it.
#[tokio::test(start_paused = true)]
async fn a_long_topic_that_moved_on_gets_a_new_one() {
    let rig = Rig::new([]).await;
    long_topic(&rig, 12).await;
    operators(&rig, |phrase| {
        new_topic(phrase, "сидят все под одним номером")
    })
    .await;

    assert_eq!(topic_checks(&rig).len(), 1);
    // The CLI takes its reply as an object, not a patch with `ops`.
    let request = rig.agent.received(topic_checks(&rig)[0]).request;
    assert_eq!(
        request.options.output,
        crate::agent::claude_cli::OutputKind::Object
    );
    let (titles, current) = topic_titles(&rig);
    assert_eq!(titles, ["Очередь операторов", "Работа операторов в чатах"]);
    assert_eq!(current.as_deref(), Some("Работа операторов в чатах"));
    assert_eq!(topic_check_calls(&rig)[0].outcome, AgentCallOutcome::Ok);
    // The fast-loop call right after it has the new topic as current.
    let after = topic_checks(&rig)[0] + 1;
    let message = rig.agent.received(after).request.user_message;
    assert!(
        message.contains("Работа операторов в чатах (текущая)"),
        "{message}"
    );
    assert!(rig.host.changes() >= 2);
}

/// «Тема та же»: nothing changes, and the next check waits 3 minutes.
#[tokio::test(start_paused = true)]
async fn the_same_topic_stays() {
    let rig = Rig::new([]).await;
    long_topic(&rig, 10).await;
    operators(&rig, |_| Step::patch(json!({ "decision": "same" }))).await;
    assert_eq!(topic_checks(&rig).len(), 1);
    assert_eq!(topic_titles(&rig).0, ["Очередь операторов"]);
    assert_eq!(topic_check_calls(&rig)[0].outcome, AgentCallOutcome::Empty);

    // A minute later: no check; three minutes after the last: one.
    move_host_clock(&rig, 1);
    client_says(&rig, "Ещё про очередь").await;
    rig.until(40).await;
    assert_eq!(topic_checks(&rig).len(), 1);
    move_host_clock(&rig, 2);
    client_says(&rig, "И снова про очередь").await;
    rig.until(50).await;
    assert_eq!(topic_checks(&rig).len(), 2);
}

/// «Короткая тема»: 5 minutes, no check.
#[tokio::test(start_paused = true)]
async fn a_short_topic_is_not_checked() {
    let rig = Rig::new([]).await;
    long_topic(&rig, 5).await;
    operators(&rig, |_| Step::empty()).await;
    assert_eq!(topic_checks(&rig), Vec::<usize>::new());
    assert!(topic_check_calls(&rig).is_empty());
}

/// «Цитата не найдена»: the topic stays, the call is recorded with the
/// reason; the next check comes 3 minutes later.
#[tokio::test(start_paused = true)]
async fn a_new_topic_without_its_quote_changes_nothing() {
    let rig = Rig::new([]).await;
    long_topic(&rig, 12).await;
    operators(&rig, |phrase| {
        new_topic(phrase, "у каждого оператора свой номер")
    })
    .await;
    assert_eq!(topic_titles(&rig).0, ["Очередь операторов"]);
    let check = &topic_check_calls(&rig)[0];
    assert_eq!(check.outcome, AgentCallOutcome::Empty);
    assert_eq!(check.rejected[0]["op"], json!("topic"));

    move_host_clock(&rig, 3);
    client_says(&rig, "Операторы отвечают по очереди").await;
    rig.until(45).await;
    assert_eq!(topic_checks(&rig).len(), 2);
}

/// A failed topic check leaves the topic and the fast loop goes on: the
/// fast-loop call of the same slot runs, the state is not an error.
#[tokio::test(start_paused = true)]
async fn a_failed_topic_check_does_not_stop_the_loop() {
    let rig = Rig::new([]).await;
    long_topic(&rig, 12).await;
    let calls_before = rig.agent.calls();
    operators(&rig, |_| Step::fail(AgentError::Process("boom".to_owned()))).await;
    assert_eq!(
        rig.agent.calls(),
        calls_before + 2,
        "the check and the fast-loop call"
    );
    assert_eq!(topic_check_calls(&rig)[0].outcome, AgentCallOutcome::Error);
    assert_eq!(rig.state(), AgentLoopState::Idle);
    assert_eq!(topic_titles(&rig).0, ["Очередь операторов"]);

    // A reply off its schema too.
    move_host_clock(&rig, 3);
    store(&rig, "Операторы отвечают по очереди");
    rig.agent.push(Step::patch(json!({ "ops": [] })));
    rig.fast_loop.phrase(&rig.recording, OTHERS);
    rig.fast_loop.phrase(&rig.recording, ME);
    rig.until(50).await;
    assert_eq!(
        topic_check_calls(&rig)[1].outcome,
        AgentCallOutcome::Invalid
    );
    assert_eq!(rig.state(), AgentLoopState::Idle);
}
