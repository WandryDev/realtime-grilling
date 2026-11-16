use std::{collections::HashSet, fs, io::BufWriter};

use super::*;
use crate::{
    events::testing::RecordingSink,
    recording::ogg_opus::OggOpusWriter,
    storage::{
        call_records,
        calls::CallCreate,
        recordings::RecordingLinks,
        transcript::{self, SegmentInput},
    },
};

const SECOND: usize = SAMPLE_RATE as usize;

fn block_on<T>(future: impl Future<Output = T>) -> T {
    tauri::async_runtime::block_on(future)
}

pub fn write_opus(path: &Path, samples: &[f32]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut writer = OggOpusWriter::new(BufWriter::new(File::create(path).unwrap())).unwrap();
    writer.write(samples).unwrap();
    writer.finish().unwrap();
}

/// A 300 Hz tone at `amplitude`.
fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
    let count = (seconds * SAMPLE_RATE as f32) as usize;
    (0..count)
        .map(|n| {
            let t = n as f32 / SAMPLE_RATE as f32;
            amplitude * (2.0 * std::f32::consts::PI * 300.0 * t).sin()
        })
        .collect()
}

struct Fixture {
    dir: tempfile::TempDir,
    storage: Storage,
    sink: RecordingSink,
    cache: AudioCache,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open_in(&dir.path().join("data"));
        let cache = AudioCache::new(dir.path().join("cache"));
        Self {
            dir,
            storage,
            sink: RecordingSink::default(),
            cache,
        }
    }

    fn data(&self) -> PathBuf {
        self.storage.data_dir().unwrap().to_owned()
    }

    fn store(&self) -> Arc<dyn RecordingStore> {
        self.storage.recording_store().unwrap()
    }

    fn call(&self, status: CallStatus) -> String {
        let input = CallCreate {
            status: Some(status),
            ..CallCreate::default()
        };
        block_on(
            self.storage
                .write(&self.sink, move |db| calls::create(db, input)),
        )
        .unwrap()
        .id
    }

    /// A recording of the call with both files, a live phrase, stopped
    /// unless `live`.
    fn recording(&self, call_id: &str, live: bool) -> String {
        let store = self.store();
        let call_id = call_id.to_owned();
        let id = block_on(self.storage.write(&self.sink, move |db| {
            let id = recordings::create(db, &RecordingLinks::call(&call_id), 1_000, |id| {
                store.files(id)
            })?;
            transcript::append_live(
                db,
                &id,
                SegmentInput {
                    channel: TranscriptChannel::Others,
                    start_ms: 0,
                    end_ms: 1_000,
                    text: "Наличные считаем вечером".to_owned(),
                },
            )?;
            if !live {
                recordings::finish(db, &id, 61_000)?;
            }
            Ok((id, Vec::new()))
        }))
        .unwrap();
        let files = self.get(&id).files;
        let mut me = tone(1.0, 0.5);
        me.extend(vec![0.0; SECOND]);
        write_opus(&self.data().join(files.me), &me);
        write_opus(&self.data().join(files.others), &vec![0.0; 2 * SECOND]);
        id
    }

    fn get(&self, id: &str) -> Recording {
        let id = id.to_owned();
        block_on(self.storage.read(move |db| recordings::get(db, &id))).unwrap()
    }

    fn playable(&self, id: &str) -> Playable {
        playable_in(&self.storage, id).unwrap()
    }

    fn delete(&self, call_id: &str) -> CommandResult<()> {
        block_on(delete_call_audio(
            &self.storage,
            &self.sink,
            self.store(),
            None,
            self.cache.clone(),
            call_id,
        ))
    }

    fn cached(&self) -> usize {
        fs::read_dir(self.dir.path().join("cache")).map_or(0, Iterator::count)
    }
}

#[test]
fn a_channel_decodes_to_a_wav_once() {
    let fx = Fixture::new();
    let call = fx.call(CallStatus::Finished);
    let id = fx.recording(&call, false);
    let files = fx.playable(&id);

    let wav = fx.cache.wav(&id, TranscriptChannel::Me, &files.me).unwrap();
    let bytes = fs::read(&wav).unwrap();
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..16], b"WAVEfmt ");
    assert_eq!(
        u32::from_le_bytes(bytes[24..28].try_into().unwrap()),
        SAMPLE_RATE
    );
    assert_eq!(u16::from_le_bytes(bytes[34..36].try_into().unwrap()), 16);
    assert_eq!(&bytes[36..40], b"data");
    // Exactly the decoded length: two seconds.
    let decoded = ogg_opus::read_file(&files.me).unwrap();
    assert_eq!(bytes.len(), WAV_HEADER + decoded.len() * 2);
    assert_eq!(decoded.len(), 2 * SECOND);

    // Cached: the source may go, the WAV stays until forgotten.
    let modified = wav.metadata().unwrap().modified().unwrap();
    let again = fx.cache.wav(&id, TranscriptChannel::Me, &files.me).unwrap();
    assert_eq!(again.metadata().unwrap().modified().unwrap(), modified);
    let error = fx
        .cache
        .wav("../etc", TranscriptChannel::Me, &files.me)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidInput);

    // The app exits: the cache goes; a new start clears what was left.
    fx.cache.clear();
    assert_eq!(fx.cached(), 0);
    fx.cache.wav(&id, TranscriptChannel::Me, &files.me).unwrap();
    assert_eq!(fx.cached(), 1);
    AudioCache::new(fx.dir.path().join("cache"));
    assert_eq!(fx.cached(), 0);
}

#[test]
fn peaks_follow_the_sound_of_each_channel() {
    let fx = Fixture::new();
    let call = fx.call(CallStatus::Finished);
    let id = fx.recording(&call, false);
    let files = fx.playable(&id);

    let peaks = fx.cache.peaks(&id, &files, 4).unwrap();
    assert_eq!(peaks.duration_ms, 2_000);
    assert_eq!((peaks.me.len(), peaks.others.len()), (4, 4));
    // A tone of 0.5 for a second, then silence.
    assert!(
        peaks.me[..2]
            .iter()
            .all(|&peak| (0.35..0.7).contains(&peak)),
        "{peaks:?}"
    );
    assert!(peaks.me[3] < 0.05, "{peaks:?}");
    assert!(peaks.others.iter().all(|&peak| peak < 0.05), "{peaks:?}");

    // Cached: the same bars come back without the files.
    fs::remove_file(&files.me).unwrap();
    assert_eq!(fx.cache.peaks(&id, &files, 4).unwrap(), peaks);
    assert_eq!(fx.cache.peaks(&id, &files, 2).unwrap().me.len(), 2);
}

/// `call-details`, "Удалить запись": the files of every recording go, the
/// transcript stays, the player has nothing to play.
#[test]
fn deleting_the_audio_keeps_the_transcript() {
    let fx = Fixture::new();
    let call = fx.call(CallStatus::Finished);
    let first = fx.recording(&call, false);
    let second = fx.recording(&call, false);
    let other_call = fx.call(CallStatus::Finished);
    let kept = fx.recording(&other_call, false);
    for id in [&first, &second, &kept] {
        let files = fx.playable(id);
        fx.cache.peaks(id, &files, 8).unwrap();
    }
    assert_eq!(fx.cached(), 6);
    let before = fx.sink.events().len();

    fx.delete(&call).unwrap();

    for id in [&first, &second] {
        let recording = fx.get(id);
        assert!(recording.audio_deleted_at.is_some());
        assert!(!fx.data().join(&recording.files.me).exists());
        assert!(!fx.data().join(&recording.files.others).exists());
        assert!(!fx.data().join("recordings").join(id).exists());
        assert_eq!(playable_in(&fx.storage, id), None);
    }
    assert_eq!(fx.cached(), 2, "only the other call's WAVs stay");
    assert!(fx.data().join(fx.get(&kept).files.me).exists());
    let events = fx.sink.events()[before..].to_vec();
    assert_eq!(events.len(), 1);
    assert_eq!(
        (events[0].entity, events[0].id.as_str()),
        (Entity::Call, call.as_str())
    );

    let call_id = call.clone();
    let read = block_on(
        fx.storage
            .read(move |db| call_records::transcript(db, None, &call_id)),
    )
    .unwrap();
    assert!(read.iter().all(|recording| recording.audio_deleted));
    assert!(read.iter().all(|recording| recording.segments.len() == 1));

    // Again: nothing more to do, no event.
    fx.delete(&call).unwrap();
    assert_eq!(fx.sink.events().len(), before + 1);
    // After a restart the sweep leaves the rows and the transcript.
    let reopened = Storage::open_in(&fx.data());
    let first_id = first.clone();
    let segments =
        block_on(reopened.read(move |db| transcript::for_recording(db, &first_id))).unwrap();
    assert_eq!(segments.len(), 1);
}

#[test]
fn only_a_finished_call_loses_its_audio() {
    let fx = Fixture::new();
    let live_call = fx.call(CallStatus::Live);
    let recording = fx.recording(&live_call, true);
    let finishing = fx.call(CallStatus::Finishing);
    fx.recording(&finishing, false);
    let finished = fx.call(CallStatus::Finished);
    let still_written = fx.recording(&finished, true);

    for call in [&live_call, &finishing, &finished] {
        let error = fx.delete(call).unwrap_err();
        assert!(matches!(error, CommandError::Invalid { .. }), "{error:?}");
    }
    for id in [&recording, &still_written] {
        let recording = fx.get(id);
        assert_eq!(recording.audio_deleted_at, None);
        assert!(fx.data().join(&recording.files.me).exists());
        // A recording being written is not played either.
        assert_eq!(playable_in(&fx.storage, id), None);
    }
    let error = fx.delete("nope").unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
}

/// A store whose deletes fail, as a file the OS keeps open.
struct StuckStore(Arc<dyn RecordingStore>);

impl RecordingStore for StuckStore {
    fn files(&self, id: &str) -> crate::storage::recordings::RecordingFiles {
        self.0.files(id)
    }
    fn create(&self, id: &str) -> io::Result<crate::recording::store::ChannelWriters> {
        self.0.create(id)
    }
    fn finish(&self, id: &str) -> io::Result<()> {
        self.0.finish(id)
    }
    fn delete(&self, _id: &str) -> io::Result<()> {
        Err(io::Error::other("busy"))
    }
    fn sweep(&self, known_ids: &HashSet<String>) -> io::Result<Vec<String>> {
        self.0.sweep(known_ids)
    }
}

/// L28, L9: the mark goes first: a delete that fails leaves the recording
/// without audio (nothing plays it, no second pass), and the sweep at the
/// next start removes its files.
#[test]
fn a_failed_delete_still_marks_the_audio_deleted() {
    let fx = Fixture::new();
    let call = fx.call(CallStatus::Finished);
    let id = fx.recording(&call, false);
    let error = block_on(delete_call_audio(
        &fx.storage,
        &fx.sink,
        Arc::new(StuckStore(fx.store())),
        None,
        fx.cache.clone(),
        &call,
    ))
    .unwrap_err();
    assert!(matches!(error, CommandError::External { .. }), "{error:?}");
    let recording = fx.get(&id);
    assert!(recording.audio_deleted_at.is_some());
    assert_eq!(playable_in(&fx.storage, &id), None);
    assert!(fx.data().join(&recording.files.me).exists());
    Storage::open_in(&fx.data());
    assert!(
        !fx.data().join(&recording.files.me).exists(),
        "swept at start"
    );
}

/// M14: a deleted call or project takes its decoded audio with it.
#[test]
fn the_cache_forgets_recordings_that_are_gone() {
    let fx = Fixture::new();
    let call = fx.call(CallStatus::Finished);
    let gone = fx.recording(&call, false);
    let kept = fx.recording(&call, false);
    for id in [&gone, &kept] {
        fx.cache.peaks(id, &fx.playable(id), 4).unwrap();
    }
    assert_eq!(fx.cached(), 4);
    fx.cache.retain(&HashSet::from([kept.clone()]));
    assert_eq!(fx.cached(), 2, "only the kept recording's WAVs");
    // Its peaks went too: without the WAVs they are decoded again.
    let files = fx.playable(&gone);
    fs::remove_file(&files.me).unwrap();
    assert!(fx.cache.peaks(&gone, &files, 4).is_err());
    assert!(fx.cache.peaks(&kept, &fx.playable(&kept), 4).is_ok());

    // `calls_delete`: the rows go, then the cache follows the database.
    let id = call.clone();
    block_on(fx.storage.write(&fx.sink, move |db| calls::delete(db, &id))).unwrap();
    block_on(forget_deleted(&fx.storage, &fx.cache));
    assert_eq!(fx.cached(), 0);
}

/// L12: the app's cache is its own folder, locked while it runs; the
/// folders of apps that no longer run go, another running app's stays.
#[test]
fn each_running_app_has_its_own_cache() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join(CACHE_DIR);
    let stale = root.join("1");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("x.wav"), b"old").unwrap();
    let running = root.join("2");
    fs::create_dir_all(&running).unwrap();
    let held = File::create(running.join(LOCK_FILE)).unwrap();
    held.try_lock().unwrap();

    let cache = AudioCache::for_app(dir.path());
    let own = root.join(std::process::id().to_string());
    assert!(own.join(LOCK_FILE).exists());
    assert!(!stale.exists(), "left by an app that no longer runs");
    assert!(running.exists(), "another app runs");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(&own).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    let lock = File::open(own.join(LOCK_FILE)).unwrap();
    assert!(matches!(lock.try_lock(), Err(fs::TryLockError::WouldBlock)));
    drop(cache);
}
