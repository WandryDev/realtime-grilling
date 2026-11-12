//! The retention periods (settings-real task 3.2) on a temp database with
//! the recordings' files.

use std::{
    io::Write as _,
    sync::{Arc, Mutex},
};

use serde_json::json;

use super::*;
use crate::{
    events::testing::RecordingSink,
    storage::{
        call_state::{
            self, CardLens, Evidence, EvidenceSource, GapType, NewQuestion, ValidatedOp,
            ValidatedPatch,
        },
        calls::{self, CallCreate, CallStatus},
        recordings::{RecordingLinks, RecordingState},
        settings::SettingsMap,
        summaries,
        transcript::{self, SegmentInput, TranscriptChannel},
    },
};

const NOW: i64 = 400 * DAY_MS;

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

struct Fixture {
    _dir: tempfile::TempDir,
    storage: Storage,
    store: Arc<dyn RecordingStore>,
}

impl Fixture {
    fn new(audio: &str, transcripts: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(dir.path());
        assert!(storage.error().is_none(), "{:?}", storage.error());
        let store: Arc<dyn RecordingStore> = storage.recording_store().unwrap();
        let fx = Self {
            _dir: dir,
            storage,
            store,
        };
        let patch = SettingsMap::from([
            (settings::AUDIO_RETENTION.to_owned(), json!(audio)),
            (
                settings::TRANSCRIPT_RETENTION.to_owned(),
                json!(transcripts),
            ),
        ]);
        fx.now(|db| settings::put(db, &patch).map(|_| ()));
        fx
    }

    fn now<T>(&self, work: impl FnOnce(&Connection) -> CommandResult<T>) -> T {
        self.storage.read_now(work).unwrap()
    }

    /// A call that ended `days` ago, with audio, a phrase, a question that
    /// rests on it and a summary. `live`: the call goes on (its recording
    /// is being written since then).
    fn call(&self, days: i64, live: bool) -> (String, String) {
        let ended = NOW - days * DAY_MS;
        let store = Arc::clone(&self.store);
        self.now(move |db| {
            let (call, _) = calls::create(
                db,
                CallCreate {
                    status: Some(if live {
                        CallStatus::Live
                    } else {
                        CallStatus::Finished
                    }),
                    started_at: Some(ended - 60_000),
                    ended_at: (!live).then_some(ended),
                    ..CallCreate::default()
                },
            )?;
            let id =
                recordings::create(db, &RecordingLinks::call(&call.id), ended - 60_000, |id| {
                    store.files(id)
                })?;
            let mut writers = store.create(&id).unwrap();
            writers.me.write_all(b"opus").unwrap();
            drop(writers);
            if !live {
                store.finish(&id).unwrap();
                recordings::finish(db, &id, ended)?;
            }
            transcript::append_live(
                db,
                &id,
                SegmentInput {
                    channel: TranscriptChannel::Others,
                    start_ms: 0,
                    end_ms: 900,
                    text: "Двести звонков в день".to_owned(),
                },
            )?;
            let evidence = vec![Evidence {
                source: EvidenceSource::Segment,
                id: "S1".to_owned(),
                quote: "двести".to_owned(),
            }];
            let ops = vec![
                ValidatedOp::CreateTopic {
                    title: "Очередь".to_owned(),
                },
                ValidatedOp::AddQuestion(NewQuestion {
                    text: "Кто отвечает ночью?".to_owned(),
                    description: String::new(),
                    card_field: CardLens::Goal,
                    gap_type: GapType::Empty,
                    priority: 2,
                    evidence,
                }),
            ];
            call_state::apply_patch(db, &id, &ValidatedPatch { ops })?;
            if !live {
                summaries::save_ready(
                    db,
                    &call.id,
                    &summaries::ReadySummary {
                        title: "Пилот".to_owned(),
                        tldr: "Договорились о пилоте.".to_owned(),
                        transcript_pass: summaries::SummaryTranscriptPass::Live,
                        content: summaries::SummaryContent::default(),
                    },
                )?;
            }
            Ok((call.id, id))
        })
    }

    fn recording(&self, id: &str) -> recordings::Recording {
        let id = id.to_owned();
        self.now(move |db| recordings::get(db, &id))
    }

    fn segments(&self, id: &str) -> usize {
        let id = id.to_owned();
        self.now(move |db| transcript::for_recording(db, &id)).len()
    }

    fn questions(&self, id: &str) -> usize {
        let id = id.to_owned();
        self.now(move |db| call_state::get(db, &id)).questions.len()
    }

    fn has_files(&self, id: &str) -> bool {
        self._dir
            .path()
            .join(crate::recording::store::RECORDINGS_DIR)
            .join(id)
            .exists()
    }

    /// A pass at [`NOW`] with the app's steps; returns it, the events and
    /// the recordings whose second pass was stopped.
    fn pass(&self) -> (Purged, Vec<DataChanged>, Vec<String>) {
        let sink = RecordingSink::default();
        let stopped = Mutex::new(Vec::new());
        let stop = |id: &str| stopped.lock().unwrap().push(id.to_owned());
        let forget = |_: &str| {};
        let host = PassHost {
            store: Some(Arc::clone(&self.store)),
            stop_refining: &stop,
            forget_audio: &forget,
        };
        let purged = block_on(run(&self.storage, &sink, &host, NOW)).unwrap();
        (purged, sink.events(), stopped.into_inner().unwrap())
    }
}

/// `app-settings`, «Аудио старше 30 дней»: the audio of a call 31 days old
/// goes, the transcript and the summary stay; a call 29 days old keeps it.
#[test]
fn audio_older_than_the_period_is_deleted() {
    let fx = Fixture::new("30", "365");
    let (old_call, old) = fx.call(31, false);
    let (_, young) = fx.call(29, false);

    let (purged, events, stopped) = fx.pass();

    assert_eq!(purged.audio, std::slice::from_ref(&old));
    assert!(purged.transcripts.is_empty());
    assert_eq!(
        stopped,
        std::slice::from_ref(&old),
        "its second pass stops first"
    );
    let recording = fx.recording(&old);
    assert_eq!(recording.audio_deleted_at, Some(NOW));
    assert!(!fx.has_files(&old), "the files are gone");
    assert_eq!(fx.segments(&old), 1, "the transcript stays");
    assert_eq!(fx.questions(&old), 1);
    let summary = fx.now(move |db| summaries::get(db, &old_call));
    assert!(summary.is_some(), "the summary stays");

    assert_eq!(fx.recording(&young).audio_deleted_at, None);
    assert!(fx.has_files(&young));
    assert_eq!(events.len(), 1);

    let (again, events, _) = fx.pass();
    assert!(again.is_empty(), "nothing left to delete");
    assert!(events.is_empty(), "no event without a change");
}

/// `app-settings`, «Не удалять».
#[test]
fn never_keeps_the_audio() {
    let fx = Fixture::new("never", "never");
    let (_, old) = fx.call(3_650 / 10, false);
    let (purged, events, _) = fx.pass();
    assert!(purged.is_empty());
    assert!(events.is_empty());
    assert_eq!(fx.recording(&old).audio_deleted_at, None);
    assert!(fx.has_files(&old));
    assert_eq!(fx.segments(&old), 1);
}

/// The transcript of a call older than its period goes; the summary, the
/// topics and the questions stay, and `transcript_deleted_at` says so.
#[test]
fn a_transcript_older_than_the_period_is_deleted() {
    let fx = Fixture::new("never", "90");
    let (call, old) = fx.call(91, false);
    let (_, young) = fx.call(89, false);
    fx.now(|db| recordings::set_transcript_state(db, &old, recordings::TranscriptState::Live));

    let (purged, events, stopped) = fx.pass();

    assert_eq!(purged.transcripts, std::slice::from_ref(&old));
    assert!(purged.audio.is_empty());
    assert_eq!(stopped, std::slice::from_ref(&old));
    let recording = fx.recording(&old);
    assert_eq!(recording.transcript_deleted_at, Some(NOW));
    assert_eq!(
        recording.transcript_state,
        recordings::TranscriptState::Failed,
        "no second pass writes it again"
    );
    assert_eq!(recording.audio_deleted_at, None, "the audio stays");
    assert!(fx.has_files(&old));
    assert_eq!(fx.segments(&old), 0);
    assert_eq!(fx.questions(&old), 1, "the questions stay");
    let state = fx.now({
        let old = old.clone();
        move |db| call_state::get(db, &old)
    });
    assert_eq!(state.topics.len(), 1, "the topics stay");
    let summary = fx.now({
        let call = call.clone();
        move |db| summaries::get(db, &call)
    });
    assert!(summary.is_some(), "the summary stays");
    let shown = fx.now(move |db| crate::storage::call_records::transcript(db, None, &call));
    assert!(shown[0].transcript_deleted);
    assert!(shown[0].segments.is_empty());

    assert_eq!(fx.recording(&young).transcript_deleted_at, None);
    assert_eq!(fx.segments(&young), 1);
    assert_eq!(events.len(), 1);
}

/// A call in progress is never touched, however old its start.
#[test]
fn a_recording_in_progress_is_untouched() {
    let fx = Fixture::new("7", "90");
    let (_, live) = fx.call(200, true);
    assert_eq!(fx.recording(&live).status, RecordingState::Recording);
    let (purged, events, _) = fx.pass();
    assert!(purged.is_empty(), "{purged:?}");
    assert!(events.is_empty());
    let recording = fx.recording(&live);
    assert_eq!(recording.audio_deleted_at, None);
    assert_eq!(recording.transcript_deleted_at, None);
    assert!(fx.has_files(&live));
    assert_eq!(fx.segments(&live), 1);
}

/// One `DataChanged` per pass, whatever it deleted: the calls without a
/// project scope, so every window re-reads its calls.
#[test]
fn one_event_per_pass() {
    let fx = Fixture::new("30", "90");
    for days in [31, 45, 100, 120] {
        fx.call(days, false);
    }
    let (purged, events, _) = fx.pass();
    assert_eq!(purged.audio.len(), 4);
    assert_eq!(purged.transcripts.len(), 2);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].entity, Entity::Call);
    assert_eq!(events[0].project_id, None);
    assert_eq!(events[0].change, Change::Updated);
}
