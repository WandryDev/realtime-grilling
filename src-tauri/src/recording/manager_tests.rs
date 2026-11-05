//! The recorder on fake devices (audio-capture tasks 4.5–4.6): a thread per
//! open device pushes 10 ms blocks stamped with the host clock, as a real
//! callback would. The database and the files live in a temp folder.

use std::{
    collections::HashMap, f32::consts::TAU, fs::File, path::Path, sync::atomic::AtomicUsize,
};

use super::*;
use crate::{
    audio::sink::{BlockFormat, SampleSink},
    recording::store::{ME_FILE, OTHERS_FILE, RECORDINGS_DIR},
    speech::status::TranscriptionState,
    storage::{
        Storage,
        calls::{self, CallCreate},
        projects::{self, ProjectCreate},
    },
};

const RATE: u32 = 48_000;

/// What the fake devices do and did.
struct Rig {
    permissions: Mutex<HashMap<PermissionKind, PermissionState>>,
    opened: Mutex<Vec<AudioSource>>,
    closed: AtomicUsize,
    /// The microphone can't be opened (unplugged, the default not switched
    /// yet).
    mic_gone: AtomicBool,
    /// The running devices' stop flags and breakdowns, to unplug them.
    live: Mutex<HashMap<AudioSource, (Arc<AtomicBool>, Breakdown)>>,
    default_input: Mutex<Option<String>>,
    /// The default input becomes this while the microphone opens.
    switch_on_open: Mutex<Option<String>>,
    /// System audio pushes zeros (no access on macOS).
    system_silent: AtomicBool,
    playing: Arc<AtomicBool>,
}

impl Default for Rig {
    fn default() -> Self {
        Self {
            permissions: Mutex::new(HashMap::from([
                (PermissionKind::Microphone, PermissionState::Granted),
                (PermissionKind::SystemAudio, PermissionState::Granted),
            ])),
            opened: Mutex::default(),
            closed: AtomicUsize::new(0),
            mic_gone: AtomicBool::new(false),
            live: Mutex::default(),
            default_input: Mutex::new(Some("built-in".to_owned())),
            switch_on_open: Mutex::default(),
            system_silent: AtomicBool::new(false),
            playing: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Rig {
    fn permit(&self, kind: PermissionKind, state: PermissionState) {
        self.permissions.lock().unwrap().insert(kind, state);
    }

    fn opened(&self, source: AudioSource) -> usize {
        self.opened
            .lock()
            .unwrap()
            .iter()
            .filter(|opened| **opened == source)
            .count()
    }

    fn open_count(&self) -> usize {
        self.opened.lock().unwrap().len()
    }

    /// The microphone disappears: its stream reports `DeviceNotAvailable`
    /// and stops, and it can't be opened until [`Self::plug_mic`].
    fn unplug_mic(&self) {
        self.mic_gone.store(true, Ordering::SeqCst);
        if let Some((stop, breakdown)) = self.live.lock().unwrap().get(&AudioSource::Microphone) {
            stop.store(true, Ordering::SeqCst);
            breakdown.fail(CaptureFailure::NoDevice, "Микрофон отключён");
        }
    }

    fn plug_mic(&self) {
        self.mic_gone.store(false, Ordering::SeqCst);
    }
}

/// An open fake device; dropping it stops its thread.
struct FakeCapture {
    rig: Arc<Rig>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for FakeCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            thread.join().unwrap();
        }
        self.rig.closed.fetch_add(1, Ordering::SeqCst);
    }
}

/// Pushes 10 ms stereo blocks in real time, each stamped with the host time
/// of its first frame, until `stop`.
fn pump(mut sink: RingSink, frequency: f32, silent: bool, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    thread::spawn(move || {
        let block = RATE as usize / 100;
        let start = clock::now_ns();
        let mut sent = 0usize;
        let mut samples = vec![0.0f32; block * 2];
        loop {
            // A block arrives once it was captured.
            let due = start + clock::frames_to_ns(sent + block, RATE);
            let now = clock::now_ns();
            if due > now {
                thread::sleep(Duration::from_nanos(due - now));
            }
            if stop.load(Ordering::SeqCst) {
                break;
            }
            for (index, frame) in samples.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                #[allow(clippy::cast_precision_loss)]
                let time = (sent + index) as f32 / RATE as f32;
                let value = if silent {
                    0.0
                } else {
                    0.3 * (TAU * frequency * time).sin()
                };
                frame.fill(value);
            }
            let format = BlockFormat {
                channels: 2,
                sample_rate: RATE,
            };
            let stamp = start + clock::frames_to_ns(sent, RATE);
            sink.push(format, Some(stamp), samples.iter().copied());
            sent += block;
        }
    })
}

struct FakeDevices(Arc<Rig>);

impl CaptureDevices for FakeDevices {
    fn permission(&self, kind: PermissionKind) -> PermissionStatus {
        PermissionStatus::new(self.0.permissions.lock().unwrap()[&kind])
    }

    fn open(&self, source: AudioSource, sink: RingSink) -> CommandResult<Opened> {
        if source == AudioSource::Microphone && self.0.mic_gone.load(Ordering::SeqCst) {
            return Err(CommandError::capture(
                CaptureFailure::Busy,
                "Устройство переключается",
            ));
        }
        self.0.opened.lock().unwrap().push(source);
        if source == AudioSource::Microphone
            && let Some(next) = self.0.switch_on_open.lock().unwrap().take()
        {
            *self.0.default_input.lock().unwrap() = Some(next);
        }
        let stop = Arc::new(AtomicBool::new(false));
        self.0
            .live
            .lock()
            .unwrap()
            .insert(source, (Arc::clone(&stop), sink.breakdown()));
        let (frequency, silent) = match source {
            AudioSource::Microphone => (440.0, false),
            AudioSource::System => (300.0, self.0.system_silent.load(Ordering::SeqCst)),
        };
        let thread = pump(sink, frequency, silent, Arc::clone(&stop));
        let playing = Arc::clone(&self.0.playing);
        Ok(Opened {
            capture: Box::new(FakeCapture {
                rig: Arc::clone(&self.0),
                stop,
                thread: Some(thread),
            }),
            playing: (source == AudioSource::System)
                .then(|| Box::new(move || playing.load(Ordering::SeqCst)) as _),
        })
    }

    fn default_input(&self) -> Option<String> {
        self.0.default_input.lock().unwrap().clone()
    }
}

#[derive(Default)]
struct Seen {
    changes: Mutex<Vec<RecordingStatus>>,
    levels: Mutex<Vec<RecordingLevels>>,
}

struct TestHost {
    storage: Arc<Storage>,
    seen: Arc<Seen>,
}

impl RecordingHost for TestHost {
    fn changed(&self, status: &RecordingStatus) {
        self.seen.changes.lock().unwrap().push(status.clone());
    }

    fn levels(&self, levels: &RecordingLevels) {
        self.seen.levels.lock().unwrap().push(*levels);
    }

    fn database(&self, work: DbWork<'_>) -> CommandResult<()> {
        self.storage.read_now(|connection| work(connection))
    }

    fn store(&self) -> Option<Arc<dyn RecordingStore>> {
        let store: Arc<dyn RecordingStore> = self.storage.recording_store()?;
        Some(store)
    }
}

struct Fixture {
    dir: tempfile::TempDir,
    rig: Arc<Rig>,
    seen: Arc<Seen>,
    storage: Arc<Storage>,
    manager: RecordingManager,
}

impl Fixture {
    fn new() -> Self {
        Self::with(|_| {})
    }

    fn with(setup: impl FnOnce(&Rig)) -> Self {
        Self::configured(setup, |_| {})
    }

    fn configured(setup: impl FnOnce(&Rig), configure: impl FnOnce(&mut Config)) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let rig = Arc::new(Rig::default());
        setup(&rig);
        let seen = Arc::new(Seen::default());
        let storage = Arc::new(Storage::open_in(dir.path()));
        assert!(storage.error().is_none(), "{:?}", storage.error());
        let mut config = Config::new(
            dir.path().join("no-model.bin"),
            crate::vad::worker::default_sink(),
        );
        config.supervise = Duration::from_millis(20);
        config.silent_for = Duration::from_millis(200);
        config.stall_margin = Duration::from_millis(100);
        configure(&mut config);
        let manager = RecordingManager::new(
            FakeDevices(Arc::clone(&rig)),
            TestHost {
                storage: Arc::clone(&storage),
                seen: Arc::clone(&seen),
            },
            config,
        );
        Self {
            dir,
            rig,
            seen,
            storage,
            manager,
        }
    }

    fn recording(&self, id: &str) -> recordings::Recording {
        self.storage
            .read_now(|connection| recordings::get(connection, id))
            .unwrap()
    }

    fn recording_ids(&self) -> Vec<String> {
        self.storage.read_now(recordings::list_ids).unwrap()
    }

    fn file(&self, id: &str, name: &str) -> PathBuf {
        self.dir.path().join(RECORDINGS_DIR).join(id).join(name)
    }

    fn changes(&self) -> Vec<RecordingStatus> {
        self.seen.changes.lock().unwrap().clone()
    }

    /// Waits up to 2 s for the status to match.
    fn wait_for(&self, what: &str, matches: impl Fn(&RecordingStatus) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !matches(&self.manager.status()) {
            assert!(
                Instant::now() < deadline,
                "{what}: {:?}",
                self.manager.status()
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
}

/// Duration of an Ogg Opus file in ms, from its last granule position
/// (48 kHz) minus the pre-skip.
fn opus_duration_ms(path: &Path) -> u64 {
    let mut reader = ogg::PacketReader::new(File::open(path).unwrap());
    let head = reader.read_packet().unwrap().expect("OpusHead");
    assert_eq!(&head.data[..8], b"OpusHead");
    let pre_skip = u64::from(u16::from_le_bytes([head.data[10], head.data[11]]));
    let mut last = 0;
    let mut ended = false;
    while let Some(packet) = reader.read_packet().unwrap() {
        last = packet.absgp_page();
        ended = packet.last_in_stream();
    }
    assert!(ended, "{} ends with EOS", path.display());
    last.saturating_sub(pre_skip) / 48
}

fn ms(samples: u64) -> u64 {
    samples / 16
}

#[test]
fn a_jump_of_the_host_clock_is_skipped_but_steps_are_not() {
    const MS: u64 = 1_000_000;
    let mut jump = ClockJump::new(Duration::from_millis(10));
    assert_eq!(jump.skip(1_000 * MS), 0, "the first step");
    assert_eq!(jump.skip(1_010 * MS), 0);
    // A stalled thread: seconds, but within the limit.
    assert_eq!(jump.skip(4_010 * MS), 0);
    // The machine slept for an hour: all of it but one tick is left out.
    let hour = 3_600_000 * MS;
    assert_eq!(jump.skip(4_010 * MS + hour), hour - 10 * MS);
    assert_eq!(jump.skip(4_020 * MS + hour), 0, "steps go on from there");
    // The clock never goes back, but if it did nothing is skipped.
    assert_eq!(jump.skip(5 * MS), 0);
}

#[test]
fn start_and_stop_write_a_row_and_both_files() {
    let fx = Fixture::new();
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert!(uuid::Uuid::parse_str(&id).is_ok_and(|uuid| uuid.get_version_num() == 7));
    assert!(fx.manager.is_recording());
    let status = fx.manager.status();
    assert_eq!(status.id.as_deref(), Some(id.as_str()));
    assert!(status.started_at.is_some());
    assert_eq!(
        status.channels,
        RecordingChannels {
            me: ChannelState::Ok,
            others: ChannelState::Ok
        }
    );
    assert_eq!(
        status.segmentation,
        SegmentationStatus::Unavailable,
        "no model in the test"
    );
    let row = fx.recording(&id);
    assert_eq!(row.status, recordings::RecordingState::Recording);
    assert_eq!(row.call_id, None);

    thread::sleep(Duration::from_millis(600));
    fx.manager.stop(&id).unwrap();

    assert!(!fx.manager.is_recording());
    assert_eq!(fx.rig.closed.load(Ordering::SeqCst), 2, "devices released");
    let row = fx.recording(&id);
    assert_eq!(row.status, recordings::RecordingState::Finished);
    let ended_at = row.ended_at.unwrap();
    assert!(ended_at - row.started_at >= 600, "{row:?}");
    let me = opus_duration_ms(&fx.file(&id, ME_FILE));
    let others = opus_duration_ms(&fx.file(&id, OTHERS_FILE));
    assert!((500..=900).contains(&me), "me {me} ms");
    assert!(me.abs_diff(others) <= 20, "me {me} ms, others {others} ms");

    let changes = fx.changes();
    assert_eq!(changes.first(), Some(&status), "start is announced");
    assert_eq!(changes.last(), Some(&RecordingStatus::idle()));
    assert_eq!(fx.manager.status(), RecordingStatus::idle());
    let levels = fx.seen.levels.lock().unwrap().clone();
    assert!(levels.len() >= 3, "~10 Hz: {}", levels.len());
    // "Я" is after AEC3, which treats the fake's steady tone as echo while
    // "Остальные" plays one: its level is checked without AEC below.
    assert!(levels.iter().any(|level| level.others > 0.5), "{levels:?}");
}

#[test]
fn a_second_start_returns_the_same_id_and_opens_nothing() {
    let fx = Fixture::new();
    let starts: Vec<String> = thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| scope.spawn(|| fx.manager.start(&RecordingLinks::default()).unwrap()))
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect()
    });
    assert_eq!(starts[0], starts[1], "two windows at once");
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert_eq!(id, starts[0]);
    assert_eq!(fx.rig.open_count(), 2, "microphone and system audio once");
    assert_eq!(fx.recording_ids(), std::slice::from_ref(&id));
    fx.manager.stop(&id).unwrap();

    // The next start is a new recording.
    let next = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert_ne!(next, id);
    fx.manager.stop(&next).unwrap();
}

#[test]
fn no_microphone_access_is_an_error_and_stores_nothing() {
    let fx = Fixture::with(|rig| rig.permit(PermissionKind::Microphone, PermissionState::Denied));
    let error = fx.manager.start(&RecordingLinks::default()).unwrap_err();
    assert!(
        matches!(
            error,
            CommandError::External {
                reason: Some(CaptureFailure::NoAccess),
                ..
            }
        ),
        "{error:?}"
    );
    assert!(fx.recording_ids().is_empty());
    assert_eq!(fx.rig.open_count(), 0, "nothing opened");
    assert!(!fx.dir.path().join(RECORDINGS_DIR).exists());
    assert!(!fx.manager.is_recording());
    assert!(fx.changes().is_empty());

    // Not asked yet is no access either: never prompts by itself.
    fx.rig
        .permit(PermissionKind::Microphone, PermissionState::NotDetermined);
    assert!(fx.manager.start(&RecordingLinks::default()).is_err());
}

#[test]
fn a_microphone_that_does_not_open_stores_nothing() {
    let fx = Fixture::with(|rig| rig.mic_gone.store(true, Ordering::SeqCst));
    assert!(fx.manager.start(&RecordingLinks::default()).is_err());
    assert!(fx.recording_ids().is_empty());
}

#[test]
fn without_system_audio_only_me_is_live() {
    let fx = Fixture::with(|rig| rig.permit(PermissionKind::SystemAudio, PermissionState::Denied));
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert_eq!(
        fx.manager.status().channels,
        RecordingChannels {
            me: ChannelState::Ok,
            others: ChannelState::NoAccess
        }
    );
    assert_eq!(fx.rig.opened(AudioSource::Microphone), 1);
    assert_eq!(fx.rig.opened(AudioSource::System), 0, "never opened");
    thread::sleep(Duration::from_millis(400));
    assert_eq!(fx.manager.status().channels.others, ChannelState::NoAccess);
    let stats = fx.manager.stop_with_stats(&id).unwrap().unwrap();
    let levels = fx.seen.levels.lock().unwrap().clone();
    assert!(
        levels
            .iter()
            .any(|level| level.me > 0.5 && level.others == 0.0),
        "no AEC without system audio: {levels:?}"
    );

    // Both files exist and are as long: "Остальные" is silence.
    let me = opus_duration_ms(&fx.file(&id, ME_FILE));
    let others = opus_duration_ms(&fx.file(&id, OTHERS_FILE));
    assert!(me >= 300, "{me}");
    assert!(me.abs_diff(others) <= 20, "me {me} ms, others {others} ms");
    assert!(ms(stats[1].silence_inserted) + 20 >= others, "{stats:?}");
}

#[test]
fn stop_of_an_unknown_recording_is_not_found_and_a_second_stop_does_nothing() {
    let fx = Fixture::new();
    let missing = "0190d1a0-0000-7000-8000-000000000009";
    assert!(matches!(
        fx.manager.stop(missing),
        Err(CommandError::NotFound { .. })
    ));
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert!(matches!(
        fx.manager.stop(missing),
        Err(CommandError::NotFound { .. })
    ));
    assert!(fx.manager.is_recording(), "another id stops nothing");
    fx.manager.stop(&id).unwrap();
    let ended = fx.recording(&id);
    let changes = fx.changes().len();
    fx.manager.stop(&id).unwrap();
    assert_eq!(fx.recording(&id), ended, "unchanged");
    assert_eq!(fx.changes().len(), changes, "no event");
}

#[test]
fn a_recording_of_a_call_and_of_an_unknown_call() {
    let fx = Fixture::new();
    let error = fx
        .manager
        .start(&RecordingLinks::call(
            "0190d1a0-0000-7000-8000-000000000009",
        ))
        .unwrap_err();
    assert!(matches!(error, CommandError::NotFound { .. }), "{error:?}");
    assert!(fx.recording_ids().is_empty());
    assert_eq!(
        fx.rig.closed.load(Ordering::SeqCst),
        fx.rig.open_count(),
        "devices released"
    );

    let call = fx
        .storage
        .read_now(|connection| {
            let (project, _) = projects::create(
                connection,
                ProjectCreate {
                    name: "Телемедиа".to_owned(),
                    ..ProjectCreate::default()
                },
            )?;
            let (call, _) = calls::create(
                connection,
                CallCreate {
                    project_id: Some(project.id),
                    ..CallCreate::default()
                },
            )?;
            Ok(call)
        })
        .unwrap();
    let id = fx.manager.start(&RecordingLinks::call(&call.id)).unwrap();
    assert_eq!(fx.recording(&id).call_id.as_deref(), Some(call.id.as_str()));

    // The call is deleted while recording: the stop removes the files too.
    fx.storage
        .read_now(|connection| calls::delete(connection, &call.id).map(|_| ()))
        .unwrap();
    fx.manager.stop(&id).unwrap();
    assert!(fx.recording_ids().is_empty());
    assert!(!fx.dir.path().join(RECORDINGS_DIR).join(&id).exists());
}

#[test]
fn an_unplugged_microphone_reconnects_and_system_audio_has_no_gap() {
    let fx = Fixture::new();
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    thread::sleep(Duration::from_millis(300));

    fx.rig.unplug_mic();
    fx.wait_for("reconnecting", |status| {
        status.channels.me == ChannelState::Reconnecting
    });
    thread::sleep(Duration::from_millis(400));
    assert_eq!(
        fx.manager.status().channels.me,
        ChannelState::Reconnecting,
        "retries while it can't open"
    );
    fx.rig.plug_mic();
    fx.wait_for("back", |status| status.channels.me == ChannelState::Ok);
    thread::sleep(Duration::from_millis(300));
    let stats = fx.manager.stop_with_stats(&id).unwrap().unwrap();

    assert_eq!(fx.rig.opened(AudioSource::Microphone), 2, "reopened");
    let me_states: Vec<ChannelState> = fx
        .changes()
        .iter()
        .filter(|status| status.id.is_some())
        .map(|status| status.channels.me)
        .collect();
    assert_eq!(
        me_states,
        [
            ChannelState::Ok,
            ChannelState::Reconnecting,
            ChannelState::Ok
        ],
        "an event on every change"
    );
    let [me, others] = stats;
    // ~400 ms unplugged: silence in "Я", none in "Остальные" past its
    // start (the fake opens a few ms after t0).
    assert!(ms(me.silence_inserted) >= 300, "{me:?}");
    assert!(ms(others.silence_inserted) <= 30, "{others:?}");
    assert_eq!(others.samples_dropped, 0, "{others:?}");
    let me = opus_duration_ms(&fx.file(&id, ME_FILE));
    let others = opus_duration_ms(&fx.file(&id, OTHERS_FILE));
    assert!(me.abs_diff(others) <= 20, "me {me} ms, others {others} ms");
    assert!(others >= 900, "{others}");
}

#[test]
fn a_new_default_input_is_opened() {
    let fx = Fixture::new();
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    thread::sleep(Duration::from_millis(100));
    *fx.rig.default_input.lock().unwrap() = Some("airpods".to_owned());
    let deadline = Instant::now() + Duration::from_secs(2);
    while fx.rig.opened(AudioSource::Microphone) < 2 {
        assert!(Instant::now() < deadline, "not reopened");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fx.rig.opened(AudioSource::Microphone), 2, "once");
    assert_eq!(fx.manager.status().channels.me, ChannelState::Ok);
    assert!(
        fx.changes()
            .iter()
            .any(|status| status.channels.me == ChannelState::Reconnecting)
    );
    fx.manager.stop(&id).unwrap();
}

#[test]
fn a_default_input_switched_while_opening_is_noticed() {
    let fx = Fixture::with(|rig| {
        *rig.switch_on_open.lock().unwrap() = Some("airpods".to_owned());
    });
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while fx.rig.opened(AudioSource::Microphone) < 2 {
        assert!(Instant::now() < deadline, "the new default is never opened");
        thread::sleep(Duration::from_millis(5));
    }
    thread::sleep(Duration::from_millis(100));
    assert_eq!(fx.rig.opened(AudioSource::Microphone), 2, "once");
    fx.manager.stop(&id).unwrap();
}

#[test]
fn silent_system_audio_with_unknown_access_is_flagged() {
    let fx = Fixture::with(|rig| {
        rig.permit(PermissionKind::SystemAudio, PermissionState::Unknown);
        rig.system_silent.store(true, Ordering::SeqCst);
        rig.playing.store(true, Ordering::SeqCst);
    });
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert_eq!(fx.manager.status().channels.others, ChannelState::Ok);
    fx.wait_for("silent", |status| {
        status.channels.others == ChannelState::SilentUnknownAccess
    });
    // Playback ends: silence is just silence.
    fx.rig.playing.store(false, Ordering::SeqCst);
    fx.wait_for("ok", |status| status.channels.others == ChannelState::Ok);
    fx.manager.stop(&id).unwrap();
}

#[test]
fn sound_with_unknown_access_is_fine() {
    let fx = Fixture::with(|rig| {
        rig.permit(PermissionKind::SystemAudio, PermissionState::Unknown);
        rig.playing.store(true, Ordering::SeqCst);
    });
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    thread::sleep(Duration::from_millis(500));
    assert!(
        fx.changes()
            .iter()
            .all(|status| status.channels.others != ChannelState::SilentUnknownAccess)
    );
    fx.manager.stop(&id).unwrap();
}

#[test]
fn stop_running_closes_the_files() {
    let fx = Fixture::new();
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    thread::sleep(Duration::from_millis(200));
    fx.manager.stop_running();
    assert!(!fx.manager.is_recording());
    assert_eq!(
        fx.recording(&id).status,
        recordings::RecordingState::Finished
    );
    assert!(opus_duration_ms(&fx.file(&id, ME_FILE)) >= 100);
    fx.manager.stop_running();
}

/// A model that loads, then fails on its first pass.
struct BrokenInference;

impl crate::vad::worker::Detector for BrokenInference {
    fn probabilities(
        &mut self,
        _samples: &[f32],
    ) -> Result<&[f32], crate::vad::detector::VadError> {
        Err(crate::vad::detector::VadError::Detect)
    }
}

#[test]
fn an_inference_error_while_recording_reports_segmentation_unavailable() {
    let fx = Fixture::configured(
        |_| {},
        |config| {
            config.spawn_vad = |_, id, channel, phrases| {
                VadWorker::with_detector(Box::new(BrokenInference), id, channel, phrases)
            };
        },
    );
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    fx.wait_for("unavailable", |status| {
        status.segmentation == SegmentationStatus::Unavailable
    });
    let segmentation: Vec<SegmentationStatus> = fx
        .changes()
        .iter()
        .filter(|status| status.id.as_deref() == Some(id.as_str()))
        .map(|status| status.segmentation)
        .collect();
    assert_eq!(
        segmentation.last(),
        Some(&SegmentationStatus::Unavailable),
        "announced: {segmentation:?}"
    );
    assert!(fx.manager.is_recording(), "the recording goes on");
    thread::sleep(Duration::from_millis(100));
    fx.manager.stop(&id).unwrap();
    assert!(opus_duration_ms(&fx.file(&id, ME_FILE)) >= 300);
}

#[test]
fn segmentation_is_ok_with_the_model() {
    let fx = Fixture::new();
    // Same manager setup with the model from the source tree.
    let manager = RecordingManager::new(
        FakeDevices(Arc::clone(&fx.rig)),
        TestHost {
            storage: Arc::clone(&fx.storage),
            seen: Arc::clone(&fx.seen),
        },
        Config::new(
            crate::vad::dev_model_path(),
            crate::vad::worker::default_sink(),
        ),
    );
    let id = manager.start(&RecordingLinks::default()).unwrap();
    assert_eq!(manager.status().segmentation, SegmentationStatus::Ok);
    thread::sleep(Duration::from_millis(100));
    manager.stop(&id).unwrap();
}

/// The live pass as the recorder sees it: what it says at the start, and
/// that every recording is finished for it.
#[derive(Default)]
struct NoModelSink {
    finished: Mutex<Vec<String>>,
}

impl PhraseSink for NoModelSink {
    fn phrase(&self, _phrase: crate::vad::worker::Phrase) {}

    fn recording_started(&self, _recording_id: &str) -> TranscriptionStatus {
        TranscriptionStatus::new(
            TranscriptionState::NoModel,
            Some(crate::speech::models::ModelId::Turbo),
        )
    }

    fn recording_finished(&self, recording_id: &str) {
        self.finished.lock().unwrap().push(recording_id.to_owned());
    }
}

#[test]
fn without_a_model_the_recording_goes_on_and_the_status_says_no_model() {
    let sink = Arc::new(NoModelSink::default());
    let phrases = Arc::clone(&sink) as Arc<dyn PhraseSink>;
    let fx = Fixture::configured(|_| {}, move |config| config.phrases = phrases);
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    let status = fx.manager.status();
    assert_eq!(status.id.as_deref(), Some(id.as_str()));
    // No VAD model in the fixture either: segmentation wins.
    assert_eq!(
        status.transcription,
        TranscriptionStatus::new(
            TranscriptionState::SegmentationUnavailable,
            Some(crate::speech::models::ModelId::Turbo)
        )
    );
    assert!(fx.manager.is_recording(), "the recording goes on");

    // A change from the live pass reaches the status (and the windows).
    fx.manager.set_transcription(
        &id,
        TranscriptionStatus::new(TranscriptionState::ModelFailed, None),
    );
    assert_eq!(
        fx.manager.status().transcription.state,
        TranscriptionState::SegmentationUnavailable
    );
    thread::sleep(Duration::from_millis(100));
    fx.manager.stop(&id).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while sink.finished.lock().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "the sink hears the end");
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(*sink.finished.lock().unwrap(), std::slice::from_ref(&id));
    assert!(opus_duration_ms(&fx.file(&id, ME_FILE)) >= 50);
    assert_eq!(fx.manager.status(), RecordingStatus::idle());
}

#[test]
fn with_segmentation_the_live_pass_status_is_reported_as_it_changes() {
    let sink = Arc::new(NoModelSink::default());
    let phrases = Arc::clone(&sink) as Arc<dyn PhraseSink>;
    let fx = Fixture::configured(
        |_| {},
        move |config| {
            config.model = crate::vad::dev_model_path();
            config.phrases = phrases;
        },
    );
    let id = fx.manager.start(&RecordingLinks::default()).unwrap();
    assert_eq!(
        fx.manager.status().transcription.state,
        TranscriptionState::NoModel
    );
    let ok = TranscriptionStatus::new(
        TranscriptionState::Ok,
        Some(crate::speech::models::ModelId::Small),
    );
    fx.manager.set_transcription(&id, ok);
    fx.manager
        .set_transcription("another", TranscriptionStatus::idle());
    assert_eq!(fx.manager.status().transcription, ok);
    assert!(
        fx.changes().iter().any(|status| status.transcription == ok),
        "RecordingChanged carried it"
    );
    fx.manager.stop(&id).unwrap();
}
