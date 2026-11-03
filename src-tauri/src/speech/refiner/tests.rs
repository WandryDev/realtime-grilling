use std::{
    fs::File,
    io::BufWriter,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
};

use super::*;
use crate::{
    events::{Change, Entity},
    recording::ogg_opus::OggOpusWriter,
    speech::{
        recognizer::Decode,
        testing::{FakeHost, Script, eventually, segment},
    },
    storage::transcript::{TranscriptPass, for_recording},
    vad::detector::test_audio::{fixture, read_wav},
};

fn config() -> RefinerConfig {
    RefinerConfig {
        progress_every: Duration::ZERO,
        heartbeat: Duration::from_secs(60),
        pause_poll: Duration::from_millis(5),
        retry_after: Duration::from_millis(20),
    }
}

fn write_opus(path: &Path, samples: &[f32]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut writer = OggOpusWriter::new(BufWriter::new(File::create(path).unwrap())).unwrap();
    writer.write(samples).unwrap();
    writer.finish().unwrap();
}

/// A stopped recording: two phrases on "Я", silence on "Остальные", and a
/// live segment.
fn recording(host: &FakeHost, dir: &Path) -> String {
    let id = host.recording();
    let speech = read_wav(&fixture("two-phrases.wav"));
    let files = host.db(|connection| recordings::get(connection, &id).unwrap().files);
    write_opus(&dir.join(files.me), &speech);
    write_opus(&dir.join(files.others), &vec![0.0; speech.len()]);
    host.db(|connection| {
        transcript::append_live(
            connection,
            &id,
            SegmentInput {
                channel: TranscriptChannel::Me,
                start_ms: 800,
                end_ms: 4_900,
                text: "живая".into(),
            },
        )
        .unwrap();
    });
    id
}

fn state(host: &FakeHost, id: &str) -> TranscriptState {
    host.db(|connection| recordings::get(connection, id).unwrap().transcript_state)
}

fn refine_events(host: &FakeHost) -> Vec<TranscriptRefine> {
    host.events()
        .into_iter()
        .filter_map(|event| match event {
            TranscriptEvent::Refine(refine) => Some(refine),
            _ => None,
        })
        .collect()
}

/// "уточнённая N" for the N-th phrase, decoded with beam search.
fn numbered() -> Arc<Script> {
    let count = AtomicUsize::new(0);
    Script::new(move |_, params| {
        assert_eq!(params.decode, Decode::Beam5);
        let n = count.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(vec![segment(&format!("уточнённая {n}"))])
    })
}

#[test]
fn the_refined_pass_replaces_the_live_one() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let id = recording(&host, dir.path());
    let script = numbered();
    let refiner = Refiner::start(host.as_host(), script.recognizer(), config());

    refiner.enqueue(&id);
    eventually("done", || {
        refine_events(&host).last().map(|e| e.state) == Some(RefineState::Done)
    });
    assert_eq!(state(&host, &id), TranscriptState::Refined);
    let segments = host.db(|connection| for_recording(connection, &id).unwrap());
    let texts: Vec<&str> = segments.iter().map(|s| s.text.as_str()).collect();
    assert_eq!(texts, ["уточнённая 1", "уточнённая 2"]);
    assert!(segments.iter().all(|s| s.pass == TranscriptPass::Refined));
    assert!(segments.iter().all(|s| s.channel == TranscriptChannel::Me));
    // The phrases of the fixture: 0.8–4.9 s and 5.9–… s.
    assert!(segments[0].start_ms.abs_diff(800) <= 150, "{segments:?}");
    assert!(segments[1].start_ms > segments[0].end_ms);

    let events = refine_events(&host);
    assert_eq!(
        events.first().map(|e| (e.progress, e.state)),
        Some((0, RefineState::Refining))
    );
    assert_eq!(
        events.last().map(|e| (e.progress, e.state)),
        Some((100, RefineState::Done))
    );
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].progress <= pair[1].progress)
    );
    let data = host.data.lock().unwrap().clone();
    assert_eq!(data.len(), 1);
    assert_eq!(
        (data[0].entity, data[0].change),
        (Entity::Transcript, Change::Updated)
    );
}

#[test]
fn the_second_pass_waits_while_recording() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let id = recording(&host, dir.path());
    let script = numbered();
    host.paused.store(true, Ordering::SeqCst);
    let refiner = Refiner::start(host.as_host(), script.recognizer(), config());

    refiner.enqueue(&id);
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(script.calls(), 0);
    assert_eq!(state(&host, &id), TranscriptState::Live);

    host.paused.store(false, Ordering::SeqCst);
    eventually("refined", || state(&host, &id) == TranscriptState::Refined);
    assert_eq!(script.calls(), 2);
}

#[test]
fn a_restart_queues_what_was_left_and_starts_it_over() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let left = recording(&host, dir.path());
    let fresh = recording(&host, dir.path());
    let done = recording(&host, dir.path());
    host.db(|connection| {
        recordings::set_transcript_state(connection, &left, TranscriptState::Refining).unwrap();
        recordings::set_transcript_state(connection, &done, TranscriptState::Refined).unwrap();
    });
    let script = numbered();

    // No `enqueue`: the start finds them.
    let _refiner = Refiner::start(host.as_host(), script.recognizer(), config());
    eventually("both refined", || {
        state(&host, &left) == TranscriptState::Refined
            && state(&host, &fresh) == TranscriptState::Refined
    });
    // Two phrases each; the refined one is not touched.
    assert_eq!(script.calls(), 4);
    let refined = host.db(|connection| for_recording(connection, &done).unwrap());
    assert_eq!(refined[0].pass, TranscriptPass::Live);
}

#[test]
fn an_error_marks_the_recording_failed_and_keeps_the_live_pass() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let id = recording(&host, dir.path());
    let script = Script::new(|_, _| Err(RecognizerError::Inference("broken".into())));
    let refiner = Refiner::start(host.as_host(), script.recognizer(), config());

    refiner.enqueue(&id);
    eventually("failed", || state(&host, &id) == TranscriptState::Failed);
    let segments = host.db(|connection| for_recording(connection, &id).unwrap());
    assert_eq!(segments.len(), 1);
    assert_eq!(segments[0].text, "живая");
    eventually("the failure event", || {
        refine_events(&host).last().map(|e| e.state) == Some(RefineState::Failed)
    });

    // Missing files fail too.
    let gone = recording(&host, dir.path());
    let files = host.db(|connection| recordings::get(connection, &gone).unwrap().files);
    std::fs::remove_file(dir.path().join(files.others)).unwrap();
    refiner.enqueue(&gone);
    eventually("failed", || state(&host, &gone) == TranscriptState::Failed);
}

#[test]
fn without_a_model_the_recording_waits() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let id = recording(&host, dir.path());
    host.model.lock().unwrap().1 = false;
    let script = numbered();
    let refiner = Refiner::start(host.as_host(), script.recognizer(), config());

    refiner.enqueue(&id);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(state(&host, &id), TranscriptState::Live);
    assert!(refine_events(&host).is_empty());

    host.model.lock().unwrap().1 = true;
    eventually("refined", || state(&host, &id) == TranscriptState::Refined);
}

/// The recording ids in the order their second pass started.
fn started(host: &FakeHost) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for event in refine_events(host) {
        if !ids.contains(&event.recording_id) {
            ids.push(event.recording_id);
        }
    }
    ids
}

#[test]
fn a_call_that_just_ended_goes_before_older_ones() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let older = recording(&host, dir.path());
    let old = recording(&host, dir.path());
    let script = numbered();
    host.paused.store(true, Ordering::SeqCst);
    let refiner = Refiner::start(host.as_host(), script.recognizer(), config());
    // The most recent of those left unrefined is taken (and waits, paused).
    eventually("the left ones queued", || {
        refiner.0.queue().iter().eq([&older])
    });

    let fresh = recording(&host, dir.path());
    refiner.enqueue(&fresh);
    assert!(refiner.0.queue().iter().eq([&fresh, &older]));
    host.paused.store(false, Ordering::SeqCst);
    eventually("all refined", || {
        [&older, &old, &fresh]
            .iter()
            .all(|id| state(&host, id) == TranscriptState::Refined)
    });
    assert_eq!(started(&host), [old, fresh, older]);
}

#[test]
fn recordings_of_before_speech_recognition_are_not_queued() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let skipped = recording(&host, dir.path());
    host.db(|connection| {
        recordings::set_transcript_state(connection, &skipped, TranscriptState::Skipped).unwrap();
    });
    let fresh = recording(&host, dir.path());
    let script = numbered();
    let _refiner = Refiner::start(host.as_host(), script.recognizer(), config());
    eventually("refined", || {
        state(&host, &fresh) == TranscriptState::Refined
    });
    assert_eq!(state(&host, &skipped), TranscriptState::Skipped);
    assert_eq!(started(&host), [fresh]);
}

#[test]
fn a_slow_phrase_still_sends_news() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let id = recording(&host, dir.path());
    let script = numbered();
    *script.delay.lock().unwrap() = Duration::from_millis(300);
    let refiner = Refiner::start(
        host.as_host(),
        script.recognizer(),
        RefinerConfig {
            heartbeat: Duration::from_millis(20),
            ..config()
        },
    );

    refiner.enqueue(&id);
    // The state is stored before `done` goes out: wait for the event.
    eventually("done", || {
        refine_events(&host)
            .last()
            .is_some_and(|event| event.state == RefineState::Done)
    });
    let events = refine_events(&host);
    // While the first phrase is recognized the progress stays, the events
    // go on.
    let repeats = events
        .windows(2)
        .filter(|pair| {
            pair[0].progress == pair[1].progress && pair[1].state == RefineState::Refining
        })
        .count();
    assert!(repeats >= 3, "{events:?}");
    assert!(
        events
            .windows(2)
            .all(|pair| pair[0].progress <= pair[1].progress)
    );
    assert_eq!(events.last().map(|e| e.state), Some(RefineState::Done));
}

#[test]
fn a_storage_opened_late_queues_what_was_left() {
    let dir = tempfile::tempdir().unwrap();
    let host = FakeHost::new(Some(dir.path()));
    let left = recording(&host, dir.path());
    host.db_down.store(true, Ordering::SeqCst);
    let script = numbered();
    let refiner = Refiner::start(host.as_host(), script.recognizer(), config());
    std::thread::sleep(Duration::from_millis(50));
    assert!(refine_events(&host).is_empty());

    host.db_down.store(false, Ordering::SeqCst);
    tauri::async_runtime::block_on(refiner.queue_unrefined());
    eventually("refined", || {
        state(&host, &left) == TranscriptState::Refined
    });
}
