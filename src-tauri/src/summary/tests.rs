//! The summary build without a process: its builds, the `transcript` stage
//! on a fake second pass (paused time instead of real 60 s waits).

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use rusqlite::Connection;
use tokio::sync::broadcast;

use super::{
    REFINE_SILENCE, SummaryProgress, SummaryStage, SummaryStageState,
    builds::{Stop, SummaryBuilds},
    transcript::{self, Waited, wait_for_passes},
};
use crate::{
    speech::events::{RefineState, TranscriptRefine},
    storage::{
        calls::{self, CallCreate, CallStatus},
        open_in_memory, people,
        projects::{self, ProjectCreate},
        recordings::{self, Recording, RecordingFiles, RecordingLinks, TranscriptState},
        summaries::SummaryTranscriptPass,
        transcript::{SegmentInput, TranscriptChannel, append_live, replace_refined},
    },
};

/* Fixtures */

/// A call's data in a database: projects, people, a call, its recordings
/// and their passes.
pub struct CallData<'a> {
    pub connection: &'a Connection,
}

impl CallData<'_> {
    pub fn project(&self, name: &str) -> String {
        let input = ProjectCreate {
            name: name.to_owned(),
            ..ProjectCreate::default()
        };
        projects::create(self.connection, input).unwrap().0.id
    }

    pub fn person(&self, project_id: &str, name: &str, role: &str) -> String {
        let input = people::PersonCreate {
            project_id: project_id.to_owned(),
            name: name.to_owned(),
            role: Some(role.to_owned()),
            profile: None,
        };
        people::create(self.connection, input).unwrap().0.id
    }

    pub fn call(&self, project_id: Option<&str>, people: &[&str], status: CallStatus) -> String {
        let input = CallCreate {
            project_id: project_id.map(str::to_owned),
            status: Some(status),
            started_at: Some(1_000_000),
            participant_ids: Some(people.iter().map(|id| (*id).to_owned()).collect()),
            ..CallCreate::default()
        };
        calls::create(self.connection, input).unwrap().0.id
    }

    /// A stopped recording of the call that started `offset_ms` after it,
    /// with live segments `(channel, start_ms, text)`.
    pub fn recording(
        &self,
        call_id: &str,
        offset_ms: i64,
        live: &[(TranscriptChannel, i64, &str)],
    ) -> String {
        let call = calls::get(self.connection, call_id).unwrap();
        let links = RecordingLinks {
            call_id: Some(call_id.to_owned()),
            project_id: call.project_id,
            participant_ids: call.participant_ids,
        };
        let started_at = call.started_at.unwrap() + offset_ms;
        let id = recordings::create(self.connection, &links, started_at, |id| RecordingFiles {
            me: format!("recordings/{id}/me.opus"),
            others: format!("recordings/{id}/others.opus"),
        })
        .unwrap();
        for (channel, start_ms, text) in live {
            append_live(self.connection, &id, segment(*channel, *start_ms, text)).unwrap();
        }
        recordings::finish(self.connection, &id, started_at + 600_000).unwrap();
        id
    }

    pub fn refine(&self, recording_id: &str, refined: &[(TranscriptChannel, i64, &str)]) {
        let segments = refined
            .iter()
            .map(|(channel, start_ms, text)| segment(*channel, *start_ms, text))
            .collect();
        replace_refined(self.connection, recording_id, segments).unwrap();
    }

    pub fn set_state(&self, recording_id: &str, state: TranscriptState) {
        recordings::set_transcript_state(self.connection, recording_id, state).unwrap();
    }

    pub fn delete_audio(&self, recording_id: &str) {
        recordings::mark_audio_deleted(self.connection, recording_id, 5).unwrap();
    }

    pub fn recordings(&self, call_id: &str) -> Vec<Recording> {
        transcript::recordings_of(self.connection, call_id).unwrap()
    }
}

pub fn segment(channel: TranscriptChannel, start_ms: i64, text: &str) -> SegmentInput {
    SegmentInput {
        channel,
        start_ms,
        end_ms: start_ms + 2_000,
        text: text.to_owned(),
    }
}

use TranscriptChannel::Others;

fn news(recording_id: &str, state: RefineState) -> TranscriptRefine {
    TranscriptRefine {
        recording_id: recording_id.to_owned(),
        progress: 50,
        state,
    }
}

/* Builds */

#[test]
fn one_build_per_call_until_the_slot_drops() {
    let builds = SummaryBuilds::default();
    let slot = builds.start("a").unwrap();
    // «Повторный старт во время сборки»: nothing new, follow that one.
    assert!(builds.start("a").is_none());
    assert!(builds.is_building("a"));
    let other = builds.start("b").unwrap();
    drop(slot);
    assert!(!builds.is_building("a"));
    assert!(builds.is_building(other.call_id()));
    assert!(builds.start("a").is_some());
}

#[test]
fn a_stop_reaches_the_agent_call_and_the_first_reason_stays() {
    let builds = SummaryBuilds::default();
    assert!(!builds.stop("a", Stop::Stopped));
    let slot = builds.start("a").unwrap();
    let mut armed = slot.arm();
    assert!(armed.try_recv().is_err());
    assert_eq!(slot.stopped(), None);

    assert!(builds.stop("a", Stop::Stopped));
    assert!(armed.try_recv().is_ok());
    assert!(builds.stop("a", Stop::Aborted));
    assert_eq!(slot.stopped(), Some(Stop::Stopped));
    // A call armed after the stop ends at once.
    assert!(slot.arm().try_recv().is_ok());
}

/// "Отменить завершение" then "Завершить" again: the new build takes the
/// call while the old one winds down, and the old one's end leaves it.
#[test]
fn a_stopped_build_gives_its_place_to_a_new_one() {
    let builds = SummaryBuilds::default();
    let old = builds.start("a").unwrap();
    builds.stop("a", Stop::Aborted);
    let new = builds
        .start("a")
        .expect("a stopped build does not hold the call");
    assert!(!builds.is_current("a", old.generation()));
    assert!(builds.is_current("a", new.generation()));
    assert_eq!(old.stopped(), Some(Stop::Aborted));
    assert_eq!(new.stopped(), None);
    // The old one can no longer arm or record anything.
    assert!(old.arm().try_recv().is_ok());
    let progress = SummaryProgress {
        call_id: "a".to_owned(),
        stage: SummaryStage::Summary,
        state: SummaryStageState::Running,
        counts: None,
    };
    old.record(&progress);
    assert_eq!(builds.progress("a"), None);
    new.record(&progress);
    assert_eq!(builds.progress("a"), Some(progress));

    drop(old);
    assert!(builds.is_building("a"));
    drop(new);
    assert!(!builds.is_building("a"));
}

#[test]
fn deleting_a_project_and_the_exit_stop_builds() {
    let builds = SummaryBuilds::default();
    let a = builds.start("a").unwrap();
    a.set_project(Some("p".to_owned()));
    let b = builds.start("b").unwrap();
    b.set_project(Some("q".to_owned()));
    let loose = builds.start("c").unwrap();
    builds.stop_project("p");
    assert_eq!(a.stopped(), Some(Stop::Aborted));
    assert_eq!((b.stopped(), loose.stopped()), (None, None));
    builds.shutdown();
    assert_eq!(b.stopped(), Some(Stop::Shutdown));
    assert_eq!(loose.stopped(), Some(Stop::Shutdown));
}

/* The transcript stage */

/// Reads the recordings of `call_id` from a shared connection, without a
/// blocking task: paused time must not run ahead while it waits.
fn reader(
    connection: &Arc<Mutex<Connection>>,
    call_id: &str,
) -> impl FnMut() -> std::future::Ready<crate::error::CommandResult<Vec<Recording>>> + use<> {
    let connection = Arc::clone(connection);
    let call_id = call_id.to_owned();
    move || {
        std::future::ready(transcript::recordings_of(
            &connection.lock().unwrap(),
            &call_id,
        ))
    }
}

struct Pass {
    connection: Arc<Mutex<Connection>>,
    call_id: String,
    recordings: Vec<String>,
    news: broadcast::Sender<TranscriptRefine>,
}

impl Pass {
    /// A call of two recordings, both waiting for their second pass.
    fn new() -> Self {
        let connection = open_in_memory().unwrap();
        let data = CallData {
            connection: &connection,
        };
        let project = data.project("Обменник");
        let call_id = data.call(Some(&project), &[], CallStatus::Finishing);
        let first = data.recording(&call_id, 0, &[(Others, 1_000, "живая первая")]);
        let second = data.recording(&call_id, 700_000, &[(Others, 1_000, "живая вторая")]);
        Self {
            connection: Arc::new(Mutex::new(connection)),
            call_id,
            recordings: vec![first, second],
            news: broadcast::channel(16).0,
        }
    }

    fn data<T>(&self, work: impl FnOnce(&CallData) -> T) -> T {
        let connection = self.connection.lock().unwrap();
        work(&CallData {
            connection: &connection,
        })
    }

    fn wait(&self) -> tokio::task::JoinHandle<Waited> {
        let mut read = reader(&self.connection, &self.call_id);
        let mut news = self.news.subscribe();
        tokio::spawn(async move {
            wait_for_passes(&mut read, &mut news, REFINE_SILENCE)
                .await
                .unwrap()
        })
    }

    fn pass(&self) -> SummaryTranscriptPass {
        let connection = self.connection.lock().unwrap();
        transcript::read(&connection, &self.call_id).unwrap().pass
    }
}

/// «Уточнённая»: every recording's pass ends, the summary is built from the
/// refined transcript.
#[tokio::test(start_paused = true)]
async fn the_build_waits_for_the_second_pass_of_every_recording() {
    let pass = Pass::new();
    let started = tokio::time::Instant::now();
    let waiting = pass.wait();

    tokio::time::sleep(Duration::from_secs(40)).await;
    pass.news
        .send(news(&pass.recordings[0], RefineState::Refining))
        .unwrap();
    tokio::time::sleep(Duration::from_secs(40)).await;
    pass.data(|data| data.refine(&pass.recordings[0], &[(Others, 900, "уточнённая первая")]));
    pass.news
        .send(news(&pass.recordings[0], RefineState::Done))
        .unwrap();
    tokio::time::sleep(Duration::from_secs(40)).await;
    assert!(
        !waiting.is_finished(),
        "the second recording is not refined"
    );
    pass.data(|data| data.refine(&pass.recordings[1], &[(Others, 900, "уточнённая вторая")]));
    pass.news
        .send(news(&pass.recordings[1], RefineState::Done))
        .unwrap();

    assert_eq!(waiting.await.unwrap(), Waited::Settled);
    assert_eq!(started.elapsed(), Duration::from_secs(120));
    assert_eq!(pass.pass(), SummaryTranscriptPass::Refined);
    let read = {
        let connection = pass.connection.lock().unwrap();
        transcript::read(&connection, &pass.call_id).unwrap()
    };
    let texts: Vec<&str> = read
        .recordings
        .iter()
        .flat_map(|recording| recording.segments.iter().map(|s| s.text.as_str()))
        .collect();
    assert_eq!(texts, ["уточнённая первая", "уточнённая вторая"]);
}

/// «Второй проход не успел»: a minute without news of the call's
/// recordings, and the summary goes with the live transcript. News of
/// another recording does not count.
#[tokio::test(start_paused = true)]
async fn a_minute_without_news_goes_on_with_the_live_transcript() {
    let pass = Pass::new();
    let started = tokio::time::Instant::now();
    let waiting = pass.wait();

    tokio::time::sleep(Duration::from_secs(30)).await;
    pass.news
        .send(news(&pass.recordings[1], RefineState::Refining))
        .unwrap();
    tokio::time::sleep(Duration::from_secs(50)).await;
    pass.news
        .send(news("another-call", RefineState::Refining))
        .unwrap();
    tokio::time::sleep(Duration::from_secs(9)).await;
    assert!(!waiting.is_finished());

    assert_eq!(waiting.await.unwrap(), Waited::Silence);
    assert_eq!(started.elapsed(), Duration::from_secs(90));
    assert_eq!(pass.pass(), SummaryTranscriptPass::Live);
}

/// «Смешанная»: one recording refined, the other's pass silent.
#[tokio::test(start_paused = true)]
async fn one_refined_recording_and_one_late_make_a_mixed_transcript() {
    let pass = Pass::new();
    pass.data(|data| data.refine(&pass.recordings[0], &[(Others, 900, "уточнённая первая")]));
    pass.data(|data| data.set_state(&pass.recordings[1], TranscriptState::Refining));

    assert_eq!(pass.wait().await.unwrap(), Waited::Silence);
    assert_eq!(pass.pass(), SummaryTranscriptPass::Mixed);

    // A failed pass settles at once and keeps the live transcript.
    pass.data(|data| data.set_state(&pass.recordings[1], TranscriptState::Failed));
    let started = tokio::time::Instant::now();
    assert_eq!(pass.wait().await.unwrap(), Waited::Settled);
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert_eq!(pass.pass(), SummaryTranscriptPass::Mixed);
}

/// «Удалённое аудио»: no second pass runs without the audio, so nothing is
/// waited for and the live transcript is used.
#[tokio::test(start_paused = true)]
async fn deleted_audio_is_not_waited_for() {
    let pass = Pass::new();
    for recording in &pass.recordings {
        pass.data(|data| data.delete_audio(recording));
    }
    let started = tokio::time::Instant::now();
    assert_eq!(pass.wait().await.unwrap(), Waited::Settled);
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert_eq!(pass.pass(), SummaryTranscriptPass::Live);
}

/// Without the second pass in the app (no news can come) the wait is the
/// silence, once.
#[tokio::test(start_paused = true)]
async fn without_news_at_all_the_silence_ends_the_wait() {
    let pass = Pass::new();
    let mut read = reader(&pass.connection, &pass.call_id);
    let (sender, mut news) = broadcast::channel::<TranscriptRefine>(1);
    drop(sender);
    let started = tokio::time::Instant::now();
    let waited = wait_for_passes(&mut read, &mut news, REFINE_SILENCE)
        .await
        .unwrap();
    assert_eq!(waited, Waited::Silence);
    assert_eq!(started.elapsed(), REFINE_SILENCE);
}
