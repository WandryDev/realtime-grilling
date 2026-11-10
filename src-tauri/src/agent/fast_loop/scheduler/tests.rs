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
/// ended: a call at once.
#[tokio::test(start_paused = true)]
async fn the_client_finished_a_phrase_after_the_gap() {
    let rig = Rig::new([]).await;
    rig.say(OTHERS, "Первая фраза клиента").await;
    rig.until(8).await;
    rig.say(OTHERS, "Вторая фраза клиента").await;
    assert_eq!(rig.starts(), [0, 8]);
}

/// «Слишком рано»: «реже», 12 s after the last start the call waits for the
/// gap and starts at 30 s by itself, with no other phrase.
#[tokio::test(start_paused = true)]
async fn too_early_starts_by_itself_once_the_gap_passes() {
    let rig = Rig::new([]).await;
    rig.setting(settings::QUESTION_FREQUENCY, json!("rare"));
    rig.say(OTHERS, "Первая фраза клиента").await;
    rig.until(12).await;
    rig.say(OTHERS, "Слишком рано").await;
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

/// «Фраза во время вызова»: one call at a time; a phrase during the call
/// starts the next one as soon as it ends (the gap passed), with no other
/// phrase, and the next call gets it.
#[tokio::test(start_paused = true)]
async fn a_phrase_during_a_call_starts_the_next_when_it_ends() {
    let rig = Rig::new([Step::empty().after(Duration::from_secs(25))]).await;
    rig.say(OTHERS, "Первая фраза").await;
    rig.until(21).await;
    let during = rig.say(OTHERS, "Пока агент думает").await;
    assert_eq!(rig.starts(), [0], "a call is running");
    rig.until(26).await;
    assert_eq!(rig.starts(), [0, 25]);
    let message = rig.agent.received(1).request.user_message;
    assert!(message.contains(&during.id), "{message}");
}

/// «Фраза во время вызова» with the gap still running at the end of the
/// call: the next starts when the gap passes.
#[tokio::test(start_paused = true)]
async fn a_phrase_during_a_short_call_waits_for_the_gap() {
    let rig = Rig::new([Step::empty().after(Duration::from_secs(2))]).await;
    rig.say(OTHERS, "Первая фраза").await;
    rig.until(1).await;
    rig.say(OTHERS, "Пока агент думает").await;
    rig.until(4).await;
    assert_eq!(rig.starts(), [0], "the call ended at 2 s, the gap is 5 s");
    rig.until(6).await;
    assert_eq!(rig.starts(), [0, 5]);
}

#[tokio::test(start_paused = true)]
async fn the_frequency_is_read_at_every_phrase() {
    let rig = Rig::new([]).await;
    rig.setting(settings::QUESTION_FREQUENCY, json!("often"));
    rig.say(OTHERS, "Раз").await;
    rig.until(6).await;
    rig.say(OTHERS, "Два: вызов кончился, промежутка нет").await;
    assert_eq!(rig.starts(), [0, 6]);

    rig.setting(settings::QUESTION_FREQUENCY, json!("rare"));
    rig.until(20).await;
    rig.say(OTHERS, "Три: 14 с после второго").await;
    assert_eq!(rig.starts(), [0, 6]);
    rig.until(37).await;
    assert_eq!(rig.starts(), [0, 6, 36]);
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
