//! The recording in one place (audio-capture design.md, decisions 7, 14,
//! 15): [`RecordingManager`] starts and stops it, keeps its status and runs
//! two threads while it goes.
//!
//! ```text
//! devices ─RingSink─▶ RingSource ─▶ recorder thread (10 ms tick) ─▶ me.opus / others.opus
//!    ▲      (rtrb)                    timeline → AEC on "Я" → Opus      └─▶ VAD workers
//!    └── supervisor thread (500 ms): reopens broken or switched devices,
//!        hands the new ring to the recorder, watches for silent system audio
//! ```
//!
//! A channel that delivers nothing (no access, reconnecting, the tap idle
//! while nothing plays) is filled with silence by the recorder, so both
//! files stay as long as the recording and aligned.
//!
//! Start and stop serialize on one lock, so two windows starting at once
//! get the same id and the devices open once. Status reads never wait for
//! a start.

use std::{
    io,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, PoisonError,
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use rusqlite::Connection;

use super::{
    FRAME,
    aec::Aec,
    ogg_opus::OggOpusWriter,
    status::{ChannelState, RecordingChannels, RecordingLevels, RecordingStatus, SilenceWatch},
    store::{ChannelSink, RecordingStore},
    timeline::{InputBlock, Timeline, TimelineStats},
};
use crate::{
    audio::{
        AudioSource, clock,
        level::Accumulator,
        levels::Opened,
        sink::{self, Breakdown, RingSink, RingSource},
        sources::ensure_access,
    },
    error::{CaptureFailure, CommandError, CommandResult},
    permissions::{PermissionKind, PermissionState, PermissionStatus},
    speech::status::TranscriptionStatus,
    storage::{
        self,
        recordings::{self, RecordingLinks},
        transcript::TranscriptChannel,
    },
    vad::worker::{PhraseSink, SegmentationStatus, VadWorker},
};

/// The devices behind the recording: real ones in the app, fakes in tests.
pub trait CaptureDevices: Send + Sync + 'static {
    fn permission(&self, kind: PermissionKind) -> PermissionStatus;

    /// Opens the device of `source` into `sink`; dropping
    /// [`Opened::capture`] releases it. A later breakdown goes to the sink's
    /// [`Breakdown`]. The access is checked before.
    fn open(&self, source: AudioSource, sink: RingSink) -> CommandResult<Opened>;

    /// An id of the default input now (to notice it changed); `None`
    /// without one.
    fn default_input(&self) -> Option<String>;
}

/// The database plus the files' store as the recorder sees them.
pub type DbWork<'a> = &'a mut dyn FnMut(&Connection) -> CommandResult<()>;

/// Where the recording reports and stores: the app, or a recorder in tests.
pub trait RecordingHost: Send + Sync + 'static {
    /// To every window.
    fn changed(&self, status: &RecordingStatus);
    /// ~10 Hz while recording. Called on the recorder thread: must not
    /// wait for anything (the main thread least of all).
    fn levels(&self, levels: &RecordingLevels);
    /// Runs `work` on the database (blocking).
    fn database(&self, work: DbWork<'_>) -> CommandResult<()>;
    /// The recordings' files; `None` without a data folder.
    fn store(&self) -> Option<Arc<dyn RecordingStore>>;
}

/// Starts the VAD worker of a channel: [`VadWorker::spawn`] in the app.
pub type SpawnVad = fn(&Path, &str, TranscriptChannel, Arc<dyn PhraseSink>) -> VadWorker;

pub struct Config {
    /// Silero model for the VAD workers; a missing one leaves
    /// segmentation `unavailable`.
    pub model: PathBuf,
    pub phrases: Arc<dyn PhraseSink>,
    pub spawn_vad: SpawnVad,
    /// Recorder period.
    pub tick: Duration,
    /// Levels go out every this many ticks.
    pub levels_every: u32,
    /// Supervisor period.
    pub supervise: Duration,
    /// Silence while something plays before `silentUnknownAccess`.
    pub silent_for: Duration,
    /// A channel that delivered nothing up to `now − stall_margin` is
    /// filled with silence up to there. Larger than any callback period,
    /// so a live device never gets silence in front of its samples.
    pub stall_margin: Duration,
}

impl Config {
    pub fn new(model: PathBuf, phrases: Arc<dyn PhraseSink>) -> Self {
        Self {
            model,
            phrases,
            spawn_vad: |model, id, channel, phrases| VadWorker::spawn(model, id, channel, phrases),
            tick: Duration::from_millis(10),
            levels_every: 10,
            supervise: Duration::from_millis(500),
            silent_for: Duration::from_secs(3),
            stall_margin: Duration::from_millis(250),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    Me,
    Others,
}

impl Channel {
    const fn source(self) -> AudioSource {
        match self {
            Self::Me => AudioSource::Microphone,
            Self::Others => AudioSource::System,
        }
    }

    const fn permission(self) -> (PermissionKind, &'static str) {
        match self {
            Self::Me => (PermissionKind::Microphone, "микрофону"),
            Self::Others => (PermissionKind::SystemAudio, "записи системного звука"),
        }
    }
}

fn new_ring() -> (RingSink, RingSource) {
    sink::ring(sink::RING_SAMPLES, sink::RING_BLOCKS)
}

fn reason(error: &CommandError) -> Option<CaptureFailure> {
    match error {
        CommandError::External { reason, .. } => *reason,
        _ => None,
    }
}

fn storage_error(what: &str, error: &io::Error) -> CommandError {
    CommandError::storage(format!("{what}: {error}"))
}

/// Set by `stop` for the recorder thread.
#[derive(Default)]
struct Finish {
    /// No more levels: the windows may be going away (app exit).
    quiet: AtomicBool,
    requested: AtomicBool,
    /// Host time the recording ends at.
    end_ns: AtomicU64,
}

/// A running recording.
struct Session {
    id: String,
    store: Arc<dyn RecordingStore>,
    /// Dropped to stop the supervisor, which releases the devices.
    stop_devices: Option<Sender<()>>,
    supervisor: Option<JoinHandle<()>>,
    finish: Arc<Finish>,
    recorder: Option<JoinHandle<Finished>>,
}

struct Shared {
    devices: Box<dyn CaptureDevices>,
    host: Box<dyn RecordingHost>,
    config: Config,
    /// Start and stop hold it for their whole run.
    control: Mutex<Option<Session>>,
    status: Mutex<RecordingStatus>,
    /// Keeps `RecordingChanged` in the order of the changes.
    events: Mutex<()>,
    recording: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    fn update(&self, change: impl FnOnce(&mut RecordingStatus)) {
        let _order = lock(&self.events);
        let changed = {
            let mut status = lock(&self.status);
            let before = status.clone();
            change(&mut status);
            (*status != before).then(|| status.clone())
        };
        if let Some(status) = changed {
            self.host.changed(&status);
        }
    }

    fn set_channel(&self, channel: Channel, state: ChannelState) {
        self.update(|status| {
            if status.id.is_none() {
                return;
            }
            match channel {
                Channel::Me => status.channels.me = state,
                Channel::Others => status.channels.others = state,
            }
        });
    }

    /// A VAD worker of the recording `id` stopped scoring.
    fn segmentation_failed(&self, id: &str) {
        self.update(|status| {
            if status.id.as_deref() == Some(id) {
                status.segmentation = SegmentationStatus::Unavailable;
                let transcription = status.transcription;
                status.set_transcription(transcription);
            }
        });
    }

    fn database<T>(&self, work: impl FnOnce(&Connection) -> CommandResult<T>) -> CommandResult<T> {
        let mut work = Some(work);
        let mut output = None;
        self.host.database(&mut |connection| {
            if let Some(work) = work.take() {
                output = Some(work(connection)?);
            }
            Ok(())
        })?;
        output.ok_or_else(|| CommandError::storage("База данных не ответила"))
    }

    /// Removes a recording whose start failed after the row was inserted.
    fn abandon(&self, id: &str, store: &dyn RecordingStore) {
        if let Err(error) = store.delete(id) {
            eprintln!("grill: could not remove the files of {id}: {error}");
        }
        if let Err(error) = self.database(|connection| recordings::delete(connection, id)) {
            eprintln!("grill: could not remove the recording row {id}: {error}");
        }
    }

    /// Opens the devices, the row, the files and the threads.
    fn begin(self: &Arc<Self>, links: &RecordingLinks) -> CommandResult<Session> {
        let devices = &*self.devices;
        let (kind, what) = Channel::Me.permission();
        ensure_access(&devices.permission(kind), what)?;
        let (kind, what) = Channel::Others.permission();
        let system = devices.permission(kind);
        let system_allowed = ensure_access(&system, what).is_ok();
        let store = self.host.store().ok_or_else(|| {
            CommandError::storage("Папка данных приложения недоступна: записывать некуда")
        })?;

        let t0_ns = clock::now_ns();
        let started_at = storage::now_ms();
        let (sink, me_source) = new_ring();
        // Read before opening: a switch while the device opens shows up as
        // a different default on the next check, not as the one opened.
        let me_input = devices.default_input();
        let me_device = Device {
            breakdown: me_source.breakdown(),
            opened: Some(devices.open(AudioSource::Microphone, sink)?),
            input: me_input,
        };
        let mut others_device = Device::closed();
        let mut others_source = None;
        let others_state = if system_allowed {
            let (sink, source) = new_ring();
            match devices.open(AudioSource::System, sink) {
                Ok(opened) => {
                    others_device.breakdown = source.breakdown();
                    others_device.opened = Some(opened);
                    others_source = Some(source);
                    ChannelState::Ok
                }
                Err(error) => {
                    eprintln!("grill: recording starts without system audio: {error}");
                    ChannelState::after_failure(reason(&error))
                }
            }
        } else {
            ChannelState::NoAccess
        };

        // The row first: a sweep removes every folder without one.
        let id = self.database(|connection| {
            recordings::create(connection, links, started_at, |id| store.files(id))
        })?;
        let writers = match store.create(&id) {
            Ok(writers) => writers,
            Err(error) => {
                self.abandon(&id, store.as_ref());
                return Err(storage_error("Не удалось создать файлы записи", &error));
            }
        };
        let opened = OggOpusWriter::new(writers.me)
            .and_then(|me| Ok((me, OggOpusWriter::new(writers.others)?)));
        let (me_writer, others_writer) = match opened {
            Ok(writers) => writers,
            Err(error) => {
                self.abandon(&id, store.as_ref());
                return Err(storage_error("Не удалось начать файлы записи", &error));
            }
        };

        let config = &self.config;
        let me_vad = (config.spawn_vad)(
            &config.model,
            id.as_str(),
            TranscriptChannel::Me,
            Arc::clone(&config.phrases),
        );
        let others_vad = (config.spawn_vad)(
            &config.model,
            id.as_str(),
            TranscriptChannel::Others,
            Arc::clone(&config.phrases),
        );
        let segmentation = if me_vad.status() == SegmentationStatus::Ok
            && others_vad.status() == SegmentationStatus::Ok
        {
            SegmentationStatus::Ok
        } else {
            SegmentationStatus::Unavailable
        };
        // Inference that fails mid-recording is reported too. The flag
        // covers a failure before the status below has the id.
        let segmentation_failed = Arc::new(AtomicBool::new(false));
        for vad in [&me_vad, &others_vad] {
            let shared = Arc::downgrade(self);
            let failed = Arc::clone(&segmentation_failed);
            let id = id.clone();
            vad.on_failure(move || {
                failed.store(true, Ordering::SeqCst);
                if let Some(shared) = shared.upgrade() {
                    shared.segmentation_failed(&id);
                }
            });
        }

        let (rings, ring_handoffs) = mpsc::channel();
        let (stop_devices, stopped) = mpsc::channel::<()>();
        let finish = Arc::new(Finish::default());
        let others_peak = Arc::new(AtomicU32::new(0));
        let aec = Aec::for_recording(system_allowed);
        if !aec.is_active() {
            eprintln!("grill: recording {id} without echo cancellation");
        }
        let recorder = Recorder {
            shared: Arc::clone(self),
            me: Lane::new(Some(me_source), t0_ns, me_writer, me_vad),
            others: Lane::new(others_source, t0_ns, others_writer, others_vad),
            aec,
            rings: ring_handoffs,
            finish: Arc::clone(&finish),
            others_peak: Arc::clone(&others_peak),
            buffer: Vec::with_capacity(8_192),
            jump: ClockJump::new(config.tick),
        };
        let recorder = match thread::Builder::new()
            .name("grill-recorder".to_owned())
            .spawn(move || recorder.run())
        {
            Ok(thread) => thread,
            Err(error) => {
                self.abandon(&id, store.as_ref());
                return Err(CommandError::external(format!(
                    "Не удалось запустить запись: {error}"
                )));
            }
        };
        let transcription = config.phrases.recording_started(&id);
        // The status first: the supervisor reports changes against it.
        self.recording.store(true, Ordering::SeqCst);
        self.update(|status| {
            *status = RecordingStatus {
                id: Some(id.clone()),
                started_at: Some(started_at),
                channels: RecordingChannels {
                    me: ChannelState::Ok,
                    others: others_state,
                },
                segmentation: if segmentation_failed.load(Ordering::SeqCst) {
                    SegmentationStatus::Unavailable
                } else {
                    segmentation
                },
                transcription,
            };
            status.set_transcription(transcription);
        });
        let supervisor = Supervisor {
            shared: Arc::clone(self),
            rings,
            me: me_device,
            others: others_device,
            others_allowed: system_allowed,
            others_unknown: system.state == PermissionState::Unknown,
            silence: SilenceWatch::new(config.silent_for),
            others_peak,
            started: Instant::now(),
        };
        let supervisor = match thread::Builder::new()
            .name("grill-recording-devices".to_owned())
            .spawn(move || supervisor.run(&stopped))
        {
            Ok(thread) => thread,
            Err(error) => {
                finish.quiet.store(true, Ordering::SeqCst);
                finish.requested.store(true, Ordering::SeqCst);
                drop(recorder.join());
                self.abandon(&id, store.as_ref());
                self.config.phrases.recording_finished(&id);
                self.recording.store(false, Ordering::SeqCst);
                self.update(|status| *status = RecordingStatus::idle());
                return Err(CommandError::external(format!(
                    "Не удалось запустить запись: {error}"
                )));
            }
        };
        Ok(Session {
            id,
            store,
            stop_devices: Some(stop_devices),
            supervisor: Some(supervisor),
            finish,
            recorder: Some(recorder),
        })
    }

    /// Stops a session: devices first (released before the files close),
    /// then the recorder writes what is left and closes the files, then the
    /// row. Returns the VAD workers, still finishing their last phrases.
    fn end(&self, mut session: Session) -> Ended {
        let end_ns = clock::now_ns();
        let ended_at = storage::now_ms();
        session.finish.quiet.store(true, Ordering::SeqCst);
        drop(session.stop_devices.take());
        if let Some(supervisor) = session.supervisor.take()
            && supervisor.join().is_err()
        {
            eprintln!("grill: the recording's device thread panicked");
        }
        session.finish.end_ns.store(end_ns, Ordering::SeqCst);
        session.finish.requested.store(true, Ordering::SeqCst);
        let finished = session.recorder.take().map(JoinHandle::join);
        let id = session.id.as_str();
        let ended = match finished {
            Some(Ok(finished)) => {
                finished.log(id);
                Ended {
                    id: id.to_owned(),
                    vads: finished.vads,
                    stats: Some([finished.me.stats, finished.others.stats]),
                }
            }
            _ => {
                eprintln!("grill: the recorder thread of {id} panicked");
                Ended {
                    id: id.to_owned(),
                    vads: Vec::new(),
                    stats: None,
                }
            }
        };
        if let Err(error) = session.store.finish(id) {
            eprintln!("grill: could not finish the files of {id}: {error}");
        }
        match self.database(|connection| recordings::finish(connection, id, ended_at)) {
            Ok(_) => {}
            // The call was deleted while recording: its files go too.
            Err(CommandError::NotFound { .. }) => {
                if let Err(error) = session.store.delete(id) {
                    eprintln!("grill: could not remove the files of {id}: {error}");
                }
            }
            Err(error) => eprintln!("grill: could not mark {id} finished: {error}"),
        }
        self.recording.store(false, Ordering::SeqCst);
        self.update(|status| *status = RecordingStatus::idle());
        ended
    }
}

/// What a stopped session leaves.
struct Ended {
    id: String,
    vads: Vec<VadWorker>,
    /// Timeline corrections of "Я" and "Остальные".
    stats: Option<[TimelineStats; 2]>,
}

/// Lets the VAD workers score their last audio without holding up `stop`,
/// then tells the phrase sink the recording's phrases are all out.
fn finish_in_background(ended: Ended, phrases: Arc<dyn PhraseSink>) {
    let Ended { id, vads, .. } = ended;
    if vads.is_empty() {
        phrases.recording_finished(&id);
        return;
    }
    let spawned = thread::Builder::new()
        .name("grill-vad-finish".to_owned())
        .spawn(move || {
            for vad in vads {
                vad.finish();
            }
            phrases.recording_finished(&id);
        });
    if let Err(error) = spawned {
        eprintln!("grill: could not finish segmentation in the background: {error}");
    }
}

/// The recorder of the app, in the Tauri state. Cheap to clone.
#[derive(Clone)]
pub struct RecordingManager(Arc<Shared>);

impl RecordingManager {
    pub fn new(devices: impl CaptureDevices, host: impl RecordingHost, config: Config) -> Self {
        Self(Arc::new(Shared {
            devices: Box::new(devices),
            host: Box::new(host),
            config,
            control: Mutex::new(None),
            status: Mutex::new(RecordingStatus::idle()),
            events: Mutex::new(()),
            recording: AtomicBool::new(false),
        }))
    }

    /// Starts a recording, optionally of a call, a project and its people,
    /// and returns its id. While one runs, returns its id and opens nothing
    /// (`links` are not checked then). No microphone access (or
    /// microphone), or `links` that `recordings::create` refuses, is an
    /// error and leaves no row. Blocks while the devices open: call it off
    /// the main thread.
    pub fn start(&self, links: &RecordingLinks) -> CommandResult<String> {
        let mut control = lock(&self.0.control);
        if let Some(session) = control.as_ref() {
            return Ok(session.id.clone());
        }
        let session = self.0.begin(links)?;
        let id = session.id.clone();
        *control = Some(session);
        Ok(id)
    }

    /// Stops the recording `id`, closes its files and releases the devices.
    /// An ended recording stays as it is; an unknown id is `NotFound`.
    pub fn stop(&self, id: &str) -> CommandResult<()> {
        self.stop_with_stats(id).map(|_| ())
    }

    fn stop_with_stats(&self, id: &str) -> CommandResult<Option<[TimelineStats; 2]>> {
        let mut control = lock(&self.0.control);
        if let Some(session) = control.take_if(|session| session.id == id) {
            let ended = self.0.end(session);
            drop(control);
            let stats = ended.stats;
            finish_in_background(ended, Arc::clone(&self.0.config.phrases));
            return Ok(stats);
        }
        drop(control);
        self.0
            .database(|connection| recordings::get(connection, id))
            .map(|_| None)
    }

    /// Stops whatever is recording (app exit).
    pub fn stop_running(&self) {
        let mut control = lock(&self.0.control);
        if let Some(session) = control.take() {
            let ended = self.0.end(session);
            drop(control);
            finish_in_background(ended, Arc::clone(&self.0.config.phrases));
        }
    }

    pub fn status(&self) -> RecordingStatus {
        lock(&self.0.status).clone()
    }

    pub fn is_recording(&self) -> bool {
        self.0.recording.load(Ordering::SeqCst)
    }

    /// The live pass of the recording `id` changed; ignored once it stopped.
    pub fn set_transcription(&self, id: &str, transcription: TranscriptionStatus) {
        self.0.update(|status| {
            if status.id.as_deref() == Some(id) {
                status.set_transcription(transcription);
            }
        });
    }
}

/// One channel in the recorder thread.
struct Lane {
    source: Option<RingSource>,
    /// Blocks the rings of earlier devices dropped.
    dropped: u64,
    timeline: Timeline,
    writer: Option<OggOpusWriter<Box<dyn ChannelSink>>>,
    write_failed: bool,
    vad: VadWorker,
    level: Accumulator,
    frame: [f32; FRAME],
}

impl Lane {
    fn new(
        source: Option<RingSource>,
        t0_ns: u64,
        writer: OggOpusWriter<Box<dyn ChannelSink>>,
        vad: VadWorker,
    ) -> Self {
        Self {
            source,
            dropped: 0,
            timeline: Timeline::new(t0_ns),
            writer: Some(writer),
            write_failed: false,
            vad,
            level: Accumulator::default(),
            frame: [0.0; FRAME],
        }
    }

    /// The device was reopened: what the old ring holds goes first.
    fn replace_source(&mut self, source: RingSource, buffer: &mut Vec<f32>) {
        self.drain(buffer);
        if let Some(old) = self.source.replace(source) {
            self.dropped += old.dropped();
        }
    }

    fn drain(&mut self, buffer: &mut Vec<f32>) {
        let Some(source) = self.source.as_mut() else {
            return;
        };
        while let Some(header) = source.pop(buffer) {
            self.timeline.push(InputBlock {
                samples: buffer,
                channels: header.format.channels,
                sample_rate: header.format.sample_rate,
                host_time_ns: header.host_time_ns,
            });
        }
    }

    /// Writes the popped frame and hands it to the VAD and the meter.
    fn emit(&mut self) {
        if let Some(writer) = self.writer.as_mut()
            && let Err(error) = writer.write(&self.frame)
            && !self.write_failed
        {
            eprintln!("grill: writing a recording channel failed: {error}");
            self.write_failed = true;
        }
        self.vad.push(&self.frame);
        self.level.add(self.frame.iter().copied());
    }

    fn dropped_blocks(&self) -> u64 {
        self.dropped + self.source.as_ref().map_or(0, RingSource::dropped)
    }

    fn close(mut self) -> (LaneSummary, VadWorker) {
        let written = self.writer.take().map(|writer| {
            let samples = writer.samples_written();
            writer.finish().map(|_| samples)
        });
        let summary = LaneSummary {
            stats: self.timeline.stats(),
            dropped_blocks: self.dropped_blocks(),
            written: written.unwrap_or(Ok(0)),
        };
        (summary, self.vad)
    }
}

struct LaneSummary {
    stats: TimelineStats,
    dropped_blocks: u64,
    /// 16 kHz samples in the file, or why it could not be closed.
    written: io::Result<u64>,
}

/// What the recorder thread leaves.
struct Finished {
    me: LaneSummary,
    others: LaneSummary,
    vads: Vec<VadWorker>,
}

impl Finished {
    fn log(&self, id: &str) {
        for (name, lane) in [("me", &self.me), ("others", &self.others)] {
            match &lane.written {
                Ok(samples) => eprintln!(
                    "grill: recording {id} {name}: {} ms written, {} ms of silence filled in, {} ms cut, {} blocks dropped",
                    samples / 16,
                    lane.stats.silence_inserted / 16,
                    lane.stats.samples_dropped / 16,
                    lane.dropped_blocks
                ),
                Err(error) => {
                    eprintln!("grill: recording {id} {name}: the file did not close: {error}");
                }
            }
        }
    }
}

/// A host clock that moved on further than this between two recorder
/// steps (10 ms apart) jumped: the machine slept or the process was
/// suspended. Longer than any scheduling hiccup, longer than the rings
/// hold (~3 s), so no captured audio falls in the skipped part.
const MAX_STEP_NS: u64 = 5_000_000_000;

/// Notices a jump of the host clock between recorder steps.
struct ClockJump {
    last_ns: Option<u64>,
    /// How far a step may move on without being a jump.
    max_ns: u64,
    /// What a skipped jump still counts as: one tick.
    tick_ns: u64,
}

impl ClockJump {
    fn new(tick: Duration) -> Self {
        Self {
            last_ns: None,
            max_ns: MAX_STEP_NS,
            tick_ns: u64::try_from(tick.as_nanos()).unwrap_or(u64::MAX),
        }
    }

    /// How much of the time up to `until_ns` to leave out of the recording.
    fn skip(&mut self, until_ns: u64) -> u64 {
        let jump = self.last_ns.map_or(0, |last| until_ns.saturating_sub(last));
        self.last_ns = Some(until_ns);
        if jump > self.max_ns {
            jump - self.tick_ns.min(jump)
        } else {
            0
        }
    }
}

/// The recorder thread: rings → timelines → AEC → files, VAD, levels.
struct Recorder {
    shared: Arc<Shared>,
    me: Lane,
    others: Lane,
    aec: Aec,
    rings: Receiver<(Channel, RingSource)>,
    finish: Arc<Finish>,
    /// The loudest "Остальные" level since the supervisor last looked.
    others_peak: Arc<AtomicU32>,
    buffer: Vec<f32>,
    jump: ClockJump,
}

impl Recorder {
    fn run(mut self) -> Finished {
        let config = &self.shared.config;
        let tick = config.tick;
        let margin = u64::try_from(config.stall_margin.as_nanos()).unwrap_or(u64::MAX);
        let levels_every = config.levels_every.max(1);
        let mut next = Instant::now();
        let mut ticks: u32 = 0;
        while !self.finish.requested.load(Ordering::SeqCst) {
            self.step(clock::now_ns().saturating_sub(margin));
            ticks = ticks.wrapping_add(1);
            if ticks.is_multiple_of(levels_every) {
                self.levels();
            }
            next += tick;
            let now = Instant::now();
            if next > now {
                thread::sleep(next - now);
            } else {
                next = now;
            }
        }
        // The devices are closed: take what they left, then fill both
        // channels up to the end.
        self.step(self.finish.end_ns.load(Ordering::SeqCst));
        let (me, me_vad) = self.me.close();
        let (others, others_vad) = self.others.close();
        Finished {
            me,
            others,
            vads: vec![me_vad, others_vad],
        }
    }

    /// Takes every captured block, fills stalled channels with silence up
    /// to `until_ns` and writes every frame both channels have. A jump of
    /// the host clock is skipped on both channels first, so the step never
    /// fills (and encodes) more than a few seconds.
    fn step(&mut self, until_ns: u64) {
        let skipped = self.jump.skip(until_ns);
        if skipped > 0 {
            eprintln!(
                "grill: the host clock jumped {} ms while recording; that time is left out",
                skipped / 1_000_000
            );
            self.me.timeline.skip(skipped);
            self.others.timeline.skip(skipped);
        }
        while let Ok((channel, source)) = self.rings.try_recv() {
            match channel {
                Channel::Me => self.me.replace_source(source, &mut self.buffer),
                Channel::Others => self.others.replace_source(source, &mut self.buffer),
            }
        }
        self.me.drain(&mut self.buffer);
        self.others.drain(&mut self.buffer);
        let until = self.me.timeline.position_of(until_ns).floor().max(0.0);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let until = until as u64;
        self.me.timeline.fill_silence_until(until);
        self.others.timeline.fill_silence_until(until);
        while self.me.timeline.available() >= FRAME && self.others.timeline.available() >= FRAME {
            self.me.timeline.pop_frame(&mut self.me.frame);
            self.others.timeline.pop_frame(&mut self.others.frame);
            self.aec.process(&mut self.me.frame, &self.others.frame);
            self.me.emit();
            self.others.emit();
        }
    }

    fn levels(&mut self) {
        let levels = RecordingLevels {
            me: self.me.level.take_level(),
            others: self.others.level.take_level(),
        };
        // Levels are ≥ 0, where the bits of an f32 order as its value.
        self.others_peak
            .fetch_max(levels.others.to_bits(), Ordering::Relaxed);
        if !self.finish.quiet.load(Ordering::SeqCst) {
            self.shared.host.levels(&levels);
        }
    }
}

/// An open (or closed) device of a channel in the supervisor.
struct Device {
    /// `None` while reconnecting or without access.
    opened: Option<Opened>,
    breakdown: Breakdown,
    /// The default input it was opened on (microphone).
    input: Option<String>,
}

impl Device {
    fn closed() -> Self {
        Self {
            opened: None,
            breakdown: Breakdown::default(),
            input: None,
        }
    }
}

/// The supervisor thread: owns the devices while recording.
struct Supervisor {
    shared: Arc<Shared>,
    rings: Sender<(Channel, RingSource)>,
    me: Device,
    others: Device,
    /// `false`: no system audio access, "Остальные" stays silence.
    others_allowed: bool,
    others_unknown: bool,
    silence: SilenceWatch,
    others_peak: Arc<AtomicU32>,
    started: Instant,
}

impl Supervisor {
    /// Checks the devices every period until `stop` is dropped; the devices
    /// are released when it returns.
    fn run(mut self, stop: &Receiver<()>) {
        // A message or the sender dropped ends it.
        while let Err(RecvTimeoutError::Timeout) = stop.recv_timeout(self.shared.config.supervise) {
            self.step();
        }
    }

    fn step(&mut self) {
        self.check_microphone();
        self.check_system();
    }

    fn check_microphone(&mut self) {
        let failure = self.me.breakdown.take();
        if self.me.opened.is_some() {
            let switched = self.shared.devices.default_input() != self.me.input;
            if failure.is_none() && !switched {
                return;
            }
            match &failure {
                Some(failure) => eprintln!(
                    "grill: the microphone broke while recording, reopening: {}",
                    failure.message
                ),
                None => eprintln!("grill: the default microphone changed, reopening"),
            }
            self.me.opened = None;
            self.shared
                .set_channel(Channel::Me, ChannelState::Reconnecting);
        }
        self.reopen(Channel::Me);
    }

    fn check_system(&mut self) {
        if !self.others_allowed {
            return;
        }
        let failure = self.others.breakdown.take();
        if self.others.opened.is_some()
            && let Some(failure) = failure
        {
            eprintln!(
                "grill: system audio broke while recording, reopening: {}",
                failure.message
            );
            self.others.opened = None;
            self.shared
                .set_channel(Channel::Others, ChannelState::Reconnecting);
        }
        if self.others.opened.is_none() {
            self.reopen(Channel::Others);
        }
        let Some(opened) = self.others.opened.as_ref() else {
            return;
        };
        let peak = f32::from_bits(self.others_peak.swap(0, Ordering::Relaxed));
        if !self.others_unknown {
            return;
        }
        let playing = opened.playing.as_ref().is_some_and(|playing| playing());
        let suspicious = self.silence.observe(self.started.elapsed(), playing, peak);
        self.shared.set_channel(
            Channel::Others,
            if suspicious {
                ChannelState::SilentUnknownAccess
            } else {
                ChannelState::Ok
            },
        );
    }

    /// Opens the default device of a closed channel again and hands its
    /// ring to the recorder.
    fn reopen(&mut self, channel: Channel) {
        let devices = &*self.shared.devices;
        let (kind, what) = channel.permission();
        if ensure_access(&devices.permission(kind), what).is_err() {
            self.shared.set_channel(channel, ChannelState::NoAccess);
            return;
        }
        let (sink, source) = new_ring();
        let breakdown = source.breakdown();
        // Before opening, as in `begin`.
        let input = devices.default_input();
        match devices.open(channel.source(), sink) {
            Ok(opened) => {
                let device = match channel {
                    Channel::Me => &mut self.me,
                    Channel::Others => &mut self.others,
                };
                device.opened = Some(opened);
                device.breakdown = breakdown;
                if channel == Channel::Me {
                    device.input = input;
                } else {
                    self.silence = SilenceWatch::new(self.shared.config.silent_for);
                }
                // The recorder is gone only after this thread.
                let _ = self.rings.send((channel, source));
                self.shared.set_channel(channel, ChannelState::Ok);
            }
            Err(error) => {
                self.shared
                    .set_channel(channel, ChannelState::after_failure(reason(&error)));
            }
        }
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;
