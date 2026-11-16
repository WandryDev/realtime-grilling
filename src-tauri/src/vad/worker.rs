//! One VAD thread per recording channel (design.md decisions 7 and 18).
//!
//! The recorder pushes 16 kHz mono frames (10 ms) into a bounded queue and
//! never waits for the detector: `push` takes a short lock, copies the frame,
//! and returns. The worker scores the stream every 256 ms with a sliding pass
//! (`detector`), feeds the probabilities to the phrase state machine
//! (`segmenter`), and cuts each closed phrase out of a ring of recent audio
//! for the `PhraseSink`. The worker takes the queue in batches of a second,
//! and more than 30 s of backlog (the batch it scores included) is dropped
//! from the old end and logged. Without a model the worker reports
//! `Unavailable` and `push` does nothing; an inference error later does the
//! same and tells [`VadWorker::on_failure`].

use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::detector::{PASS_WINDOWS, STEP_WINDOWS, SileroVad, VadError, pass_start};
use super::segmenter::{Segmenter, SegmenterParams, Span};
use super::{SAMPLE_RATE, SAMPLES_PER_MS, WINDOW_SAMPLES};
use crate::{speech::status::TranscriptionStatus, storage::transcript::TranscriptChannel};

/// Queued audio beyond this is dropped from the old end.
const MAX_BACKLOG_SAMPLES: usize = 30 * SAMPLE_RATE as usize;
/// The worker takes at most this much of the queue at once, so what it is
/// scoring stays a small part of the backlog.
const BATCH_SAMPLES: usize = SAMPLE_RATE as usize;
/// Recent audio kept to cut phrases: the 15-s cap, a pass and some slack.
const RING_SAMPLES: usize = 20 * SAMPLE_RATE as usize;
const STEP_SAMPLES: u64 = (STEP_WINDOWS * WINDOW_SAMPLES) as u64;

/// Whether phrases come out of a channel; part of the recording status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SegmentationStatus {
    Ok,
    /// The model did not load (or inference failed): recording goes on
    /// without phrases.
    Unavailable,
}

/// A phrase of one channel.
#[derive(Debug, Clone, PartialEq)]
pub struct Phrase {
    pub recording_id: String,
    pub channel: TranscriptChannel,
    /// Offsets from the start of the recording, as in the channel's file.
    pub start_ms: u64,
    pub end_ms: u64,
    /// 16 kHz mono, `start_ms..end_ms`.
    pub samples: Vec<f32>,
}

/// Where phrases go: speech recognition (`speech::live`). Called on the
/// worker thread; a slow sink delays segmentation, never recording.
pub trait PhraseSink: Send + Sync {
    fn phrase(&self, phrase: Phrase);

    /// The recording `recording_id` starts; its phrases follow. Returns how
    /// its transcription starts out (part of the recording status).
    fn recording_started(&self, _recording_id: &str) -> TranscriptionStatus {
        TranscriptionStatus::idle()
    }

    /// The recording stopped and its last phrase was delivered.
    fn recording_finished(&self, _recording_id: &str) {}
}

/// Prints phrase boundaries to stderr in debug builds; drops them in release.
#[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
pub struct StderrSink;

impl PhraseSink for StderrSink {
    fn phrase(&self, phrase: Phrase) {
        if cfg!(debug_assertions) {
            eprintln!(
                "grill: phrase {} {:?} {}–{} ms ({} ms)",
                phrase.recording_id,
                phrase.channel,
                phrase.start_ms,
                phrase.end_ms,
                phrase.end_ms - phrase.start_ms
            );
        }
    }
}

#[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
pub fn default_sink() -> Arc<dyn PhraseSink> {
    Arc::new(StderrSink)
}

struct Frame {
    /// Sample offset of the frame's first sample from the recording start.
    position: u64,
    samples: Vec<f32>,
}

#[derive(Default)]
struct Queue {
    frames: VecDeque<Frame>,
    queued_samples: usize,
    /// The batch the worker is scoring: part of the backlog, but no longer
    /// in `frames`.
    scoring_samples: usize,
    next_position: u64,
    closed: bool,
}

impl Queue {
    /// Queues the next frame and drops the oldest queued ones while the
    /// backlog (queued plus scoring) is over `max_backlog`.
    fn push(&mut self, frame: &[f32], max_backlog: usize) {
        let position = self.next_position;
        self.next_position += frame.len() as u64;
        self.queued_samples += frame.len();
        self.frames.push_back(Frame {
            position,
            samples: frame.to_vec(),
        });
        // The worker notices the hole in positions and logs it.
        while self.queued_samples + self.scoring_samples > max_backlog {
            let Some(old) = self.frames.pop_front() else {
                break;
            };
            self.queued_samples -= old.samples.len();
        }
    }

    /// The oldest frames, up to `limit` samples (at least one frame), now
    /// being scored; and whether they are the last ones.
    fn take_batch(&mut self, limit: usize) -> (Vec<Frame>, bool) {
        let mut batch = Vec::new();
        let mut samples = 0;
        while let Some(frame) = self.frames.front() {
            if !batch.is_empty() && samples + frame.samples.len() > limit {
                break;
            }
            samples += frame.samples.len();
            batch.extend(self.frames.pop_front());
        }
        self.queued_samples -= samples;
        self.scoring_samples = samples;
        (batch, self.closed && self.frames.is_empty())
    }

    #[cfg(any(test, feature = "eval"))]
    fn backlog(&self) -> usize {
        self.queued_samples + self.scoring_samples
    }
}

type FailureCallback = Box<dyn FnOnce() + Send>;

struct Shared {
    queue: Mutex<Queue>,
    ready: Condvar,
    available: AtomicBool,
    max_backlog_samples: usize,
    /// Set (under `on_failure`'s lock) when inference failed.
    failed: AtomicBool,
    on_failure: Mutex<Option<FailureCallback>>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Inference failed: no more phrases, and whoever asked is told.
    fn fail(&self) {
        self.available.store(false, Ordering::Release);
        let callback = {
            let mut slot = self
                .on_failure
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            self.failed.store(true, Ordering::Release);
            slot.take()
        };
        if let Some(callback) = callback {
            callback();
        }
    }
}

/// Scores 512-sample windows: [`SileroVad`] in the app, fakes in tests.
pub trait Detector: Send {
    /// Speech probability of each window of `samples`, from a clean state.
    fn probabilities(&mut self, samples: &[f32]) -> Result<&[f32], VadError>;
}

impl Detector for SileroVad {
    fn probabilities(&mut self, samples: &[f32]) -> Result<&[f32], VadError> {
        Self::probabilities(self, samples)
    }
}

/// The VAD thread of one channel.
pub struct VadWorker {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl VadWorker {
    /// Loads the model and starts the thread. Never fails: without a model
    /// (or a thread) the status is `Unavailable` and frames are ignored.
    pub fn spawn(
        model: &Path,
        recording_id: impl Into<String>,
        channel: TranscriptChannel,
        sink: Arc<dyn PhraseSink>,
    ) -> Self {
        Self::spawn_with_backlog(model, recording_id, channel, sink, MAX_BACKLOG_SAMPLES)
    }

    fn spawn_with_backlog(
        model: &Path,
        recording_id: impl Into<String>,
        channel: TranscriptChannel,
        sink: Arc<dyn PhraseSink>,
        max_backlog_samples: usize,
    ) -> Self {
        match SileroVad::load(model) {
            Ok(vad) => Self::start(
                Box::new(vad),
                recording_id.into(),
                channel,
                sink,
                max_backlog_samples,
            ),
            Err(error) => {
                eprintln!("grill: speech segmentation unavailable ({channel:?}): {error}");
                Self {
                    shared: Self::shared(max_backlog_samples),
                    thread: None,
                }
            }
        }
    }

    /// Starts the thread over a loaded `detector`.
    #[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
    pub fn with_detector(
        detector: Box<dyn Detector>,
        recording_id: impl Into<String>,
        channel: TranscriptChannel,
        sink: Arc<dyn PhraseSink>,
    ) -> Self {
        Self::start(
            detector,
            recording_id.into(),
            channel,
            sink,
            MAX_BACKLOG_SAMPLES,
        )
    }

    fn shared(max_backlog_samples: usize) -> Arc<Shared> {
        Arc::new(Shared {
            queue: Mutex::new(Queue::default()),
            ready: Condvar::new(),
            available: AtomicBool::new(false),
            max_backlog_samples,
            failed: AtomicBool::new(false),
            on_failure: Mutex::new(None),
        })
    }

    fn start(
        detector: Box<dyn Detector>,
        recording_id: String,
        channel: TranscriptChannel,
        sink: Arc<dyn PhraseSink>,
        max_backlog_samples: usize,
    ) -> Self {
        let shared = Self::shared(max_backlog_samples);
        let pipeline = Pipeline::new(detector, recording_id, channel, sink);
        let thread_shared = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name(format!("grill-vad-{channel:?}").to_lowercase())
            .spawn(move || pipeline.run(&thread_shared));
        match thread {
            Ok(thread) => {
                shared.available.store(true, Ordering::Release);
                Self {
                    shared,
                    thread: Some(thread),
                }
            }
            Err(error) => {
                eprintln!("grill: speech segmentation unavailable ({channel:?}): {error}");
                Self {
                    shared,
                    thread: None,
                }
            }
        }
    }

    /// Calls `callback` once, on the worker thread, when inference fails
    /// after the start (at once if it already did). A worker that never
    /// started (no model) never calls it: its status says so from the start.
    pub fn on_failure(&self, callback: impl FnOnce() + Send + 'static) {
        let mut slot = self
            .shared
            .on_failure
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if self.shared.failed.load(Ordering::Acquire) {
            drop(slot);
            callback();
        } else {
            *slot = Some(Box::new(callback));
        }
    }

    pub fn status(&self) -> SegmentationStatus {
        if self.shared.available.load(Ordering::Acquire) {
            SegmentationStatus::Ok
        } else {
            SegmentationStatus::Unavailable
        }
    }

    /// Queues the next frame of the channel (16 kHz mono, any length; the
    /// recorder sends 10 ms). Frames follow each other without gaps: the
    /// recorder's timeline already fills them with silence.
    pub fn push(&self, frame: &[f32]) {
        if frame.is_empty() || !self.shared.available.load(Ordering::Acquire) {
            return;
        }
        {
            let mut queue = self.shared.lock();
            if queue.closed {
                return;
            }
            queue.push(frame, self.shared.max_backlog_samples);
        }
        self.shared.ready.notify_one();
    }

    /// Audio waiting for the worker or being scored, in milliseconds.
    #[cfg(any(test, feature = "eval"))]
    pub fn backlog_ms(&self) -> u64 {
        self.shared.lock().backlog() as u64 / SAMPLES_PER_MS
    }

    /// Ends the channel: scores what is queued, closes the open phrase and
    /// joins the thread. Dropping the worker does the same.
    pub fn finish(mut self) {
        self.stop();
    }

    fn stop(&mut self) {
        self.shared.lock().closed = true;
        self.shared.ready.notify_one();
        if let Some(thread) = self.thread.take()
            && thread.join().is_err()
        {
            eprintln!("grill: speech segmentation thread panicked");
        }
    }
}

impl Drop for VadWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Recent audio of the channel, addressed by sample offset.
struct Ring {
    start: u64,
    samples: VecDeque<f32>,
}

impl Ring {
    fn end(&self) -> u64 {
        self.start + self.samples.len() as u64
    }

    /// Samples `[from, to)`, clamped to what is kept.
    fn slice(&self, from: u64, to: u64) -> Vec<f32> {
        let from = from.clamp(self.start, self.end());
        let to = to.clamp(from, self.end());
        let index = |position: u64| (position - self.start) as usize;
        self.samples
            .range(index(from)..index(to))
            .copied()
            .collect()
    }

    fn keep_last(&mut self, samples: usize) {
        let excess = self.samples.len().saturating_sub(samples);
        self.samples.drain(..excess);
        self.start += excess as u64;
    }

    fn restart(&mut self, at: u64) {
        self.samples.clear();
        self.start = at;
    }
}

/// The worker thread's state.
struct Pipeline {
    vad: Box<dyn Detector>,
    recording_id: String,
    channel: TranscriptChannel,
    sink: Arc<dyn PhraseSink>,
    ring: Ring,
    /// Start of the window grid (0, or where audio resumed after a drop).
    origin: u64,
    /// Start of the first window not scored yet.
    next_window: u64,
    segmenter: Segmenter,
}

impl Pipeline {
    fn new(
        vad: Box<dyn Detector>,
        recording_id: String,
        channel: TranscriptChannel,
        sink: Arc<dyn PhraseSink>,
    ) -> Self {
        Self {
            vad,
            recording_id,
            channel,
            sink,
            ring: Ring {
                start: 0,
                samples: VecDeque::with_capacity(RING_SAMPLES + STEP_SAMPLES as usize),
            },
            origin: 0,
            next_window: 0,
            segmenter: Segmenter::new(SegmenterParams::default(), 0),
        }
    }

    fn run(mut self, shared: &Shared) {
        loop {
            let (frames, closed) = {
                let mut queue = shared.lock();
                while queue.frames.is_empty() && !queue.closed {
                    queue = shared
                        .ready
                        .wait(queue)
                        .unwrap_or_else(PoisonError::into_inner);
                }
                queue.take_batch(BATCH_SAMPLES)
            };
            let result = frames
                .into_iter()
                .try_for_each(|frame| self.feed(frame))
                .and_then(|()| if closed { self.flush() } else { Ok(()) });
            {
                let mut queue = shared.lock();
                queue.scoring_samples = 0;
                if result.is_err() {
                    // Nothing scores it any more; closed under the same lock,
                    // so a frame pushed before `fail` is not queued either.
                    queue.frames.clear();
                    queue.queued_samples = 0;
                    queue.closed = true;
                }
            }
            if let Err(error) = result {
                eprintln!(
                    "grill: speech segmentation stopped ({:?}): {error}",
                    self.channel
                );
                shared.fail();
                return;
            }
            if closed {
                return;
            }
        }
    }

    fn feed(&mut self, frame: Frame) -> Result<(), VadError> {
        let expected = self.ring.end();
        if frame.position != expected {
            eprintln!(
                "grill: speech segmentation ({:?}) fell behind; skipped {} ms of audio",
                self.channel,
                (frame.position.saturating_sub(expected)) / SAMPLES_PER_MS
            );
            self.flush()?;
            self.ring.restart(frame.position);
            self.origin = frame.position;
            self.next_window = frame.position;
            self.segmenter = Segmenter::new(SegmenterParams::default(), frame.position);
        }
        self.ring.samples.extend(&frame.samples);
        while self.ring.end() - self.next_window >= STEP_SAMPLES {
            self.score(STEP_WINDOWS)?;
        }
        self.ring.keep_last(RING_SAMPLES);
        Ok(())
    }

    /// Scores what is left (the last window zero-padded) and closes the
    /// open phrase at the end of the audio.
    fn flush(&mut self) -> Result<(), VadError> {
        let left = self.ring.end() - self.next_window;
        if left > 0 {
            self.score(left.div_ceil(WINDOW_SAMPLES as u64) as usize)?;
        }
        if let Some(span) = self.segmenter.finish(self.ring.end()) {
            self.emit(span);
        }
        Ok(())
    }

    /// One pass ending `windows` windows after `next_window`.
    fn score(&mut self, windows: usize) -> Result<(), VadError> {
        let step_end = self.next_window + (windows * WINDOW_SAMPLES) as u64;
        let start = pass_start(self.origin, step_end, PASS_WINDOWS);
        let audio = self.ring.slice(start, step_end);
        let probabilities = self.vad.probabilities(&audio)?;
        let fresh = &probabilities[probabilities.len().saturating_sub(windows)..];
        let spans: Vec<Span> = fresh
            .iter()
            .filter_map(|probability| self.segmenter.push(*probability))
            .collect();
        self.next_window = step_end;
        for span in spans {
            self.emit(span);
        }
        Ok(())
    }

    fn emit(&self, span: Span) {
        self.sink.phrase(Phrase {
            recording_id: self.recording_id.clone(),
            channel: self.channel,
            start_ms: span.start_ms(),
            end_ms: span.end_ms(),
            samples: self.ring.slice(span.start, span.end),
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::vad::detector::test_audio::{fixture, pink_noise, read_wav};
    use crate::vad::dev_model_path;

    const FRAME: usize = 160;

    #[derive(Default)]
    struct Collect(Mutex<Vec<Phrase>>);

    impl PhraseSink for Collect {
        fn phrase(&self, phrase: Phrase) {
            self.0.lock().unwrap().push(phrase);
        }
    }

    fn worker(sink: &Arc<Collect>) -> VadWorker {
        VadWorker::spawn(
            &dev_model_path(),
            "rec-1",
            TranscriptChannel::Others,
            Arc::clone(sink) as Arc<dyn PhraseSink>,
        )
    }

    /// Pushes 10-ms frames, waiting whenever the worker is half a second
    /// behind so the backlog limit never kicks in.
    fn push_paced(worker: &VadWorker, samples: &[f32]) {
        for (index, frame) in samples.chunks(FRAME).enumerate() {
            worker.push(frame);
            if index % 10 == 0 {
                while worker.backlog_ms() > 500 {
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
        }
    }

    fn phrases_of(samples: &[f32]) -> Vec<Phrase> {
        let sink = Arc::new(Collect::default());
        let worker = worker(&sink);
        assert_eq!(worker.status(), SegmentationStatus::Ok);
        push_paced(&worker, samples);
        worker.finish();
        sink.0.lock().unwrap().clone()
    }

    fn bounds(phrases: &[Phrase]) -> Vec<(u64, u64)> {
        phrases.iter().map(|p| (p.start_ms, p.end_ms)).collect()
    }

    fn assert_near(actual: u64, expected: u64, what: &str) {
        assert!(
            actual.abs_diff(expected) <= 100,
            "{what}: {actual} ms, expected {expected} ± 100 ms"
        );
    }

    /// `two-phrases.wav`: 0.8 s silence, phrase 1 (4061 ms), 1 s silence,
    /// phrase 2 (2354 ms), 0.7 s silence. Generated with `say -v Milena`
    /// and ffmpeg (`silenceremove` at -60 dB, 16 kHz mono, s16).
    const PHRASE_1_MS: (u64, u64) = (800, 4_861);
    const PHRASE_2_MS: (u64, u64) = (5_861, 8_215);

    fn assert_two_phrases(phrases: &[Phrase], offset_ms: u64) {
        assert_eq!(phrases.len(), 2, "{:?}", bounds(phrases));
        for (phrase, (start, end)) in phrases.iter().zip([PHRASE_1_MS, PHRASE_2_MS]) {
            // The phrase is the speech plus 100 ms on each side.
            assert_near(phrase.start_ms, offset_ms + start - 100, "start");
            assert_near(phrase.end_ms, offset_ms + end + 100, "end");
            assert_eq!(
                phrase.samples.len() as u64,
                (phrase.end_ms - phrase.start_ms) * SAMPLES_PER_MS
            );
            assert_eq!(phrase.recording_id, "rec-1");
            assert_eq!(phrase.channel, TranscriptChannel::Others);
        }
    }

    #[test]
    fn two_phrases_from_the_fixture() {
        let samples = read_wav(&fixture("two-phrases.wav"));
        let phrases = phrases_of(&samples);
        assert_two_phrases(&phrases, 0);
        // The cut audio is the fixture's audio at those times.
        let first = &phrases[0];
        let start = (first.start_ms * SAMPLES_PER_MS) as usize;
        assert_eq!(
            first.samples[..],
            samples[start..start + first.samples.len()]
        );
    }

    #[test]
    fn a_short_yes_is_one_phrase() {
        let phrases = phrases_of(&read_wav(&fixture("da.wav")));
        assert_eq!(phrases.len(), 1, "{:?}", bounds(&phrases));
    }

    #[test]
    fn a_minute_of_digital_silence_has_no_phrases() {
        let phrases = phrases_of(&vec![0.0; 60 * SAMPLE_RATE as usize]);
        assert!(phrases.is_empty(), "{:?}", bounds(&phrases));
    }

    #[test]
    fn a_minute_of_pink_noise_has_no_phrases() {
        for rms in [0.003, 0.03] {
            let phrases = phrases_of(&pink_noise(60 * SAMPLE_RATE as usize, rms));
            assert!(phrases.is_empty(), "rms {rms}: {:?}", bounds(&phrases));
        }
    }

    #[test]
    fn the_default_sink_takes_phrases() {
        default_sink().phrase(Phrase {
            recording_id: "rec-1".into(),
            channel: TranscriptChannel::Me,
            start_ms: 100,
            end_ms: 400,
            samples: vec![0.0; 4_800],
        });
    }

    #[test]
    fn a_broken_model_leaves_segmentation_unavailable() {
        let corrupt = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(corrupt.path(), b"definitely not ggml").unwrap();
        for path in [Path::new("/nonexistent/ggml-silero.bin"), corrupt.path()] {
            let sink = Arc::new(Collect::default());
            let worker = VadWorker::spawn(
                path,
                "rec-1",
                TranscriptChannel::Me,
                Arc::clone(&sink) as Arc<dyn PhraseSink>,
            );
            assert_eq!(worker.status(), SegmentationStatus::Unavailable);
            for frame in read_wav(&fixture("two-phrases.wav")).chunks(FRAME) {
                worker.push(frame);
            }
            assert_eq!(worker.backlog_ms(), 0);
            worker.finish();
            assert!(sink.0.lock().unwrap().is_empty());
        }
    }

    /// A detector whose inference always fails, as a broken runtime would.
    struct Failing;

    impl Detector for Failing {
        fn probabilities(&mut self, _samples: &[f32]) -> Result<&[f32], VadError> {
            Err(VadError::Detect)
        }
    }

    #[test]
    fn an_inference_error_makes_segmentation_unavailable_and_says_so() {
        let sink = Arc::new(Collect::default());
        let worker = VadWorker::with_detector(
            Box::new(Failing),
            "rec-1",
            TranscriptChannel::Me,
            Arc::clone(&sink) as Arc<dyn PhraseSink>,
        );
        assert_eq!(worker.status(), SegmentationStatus::Ok, "loaded");
        let (failed_tx, failed_rx) = mpsc::channel();
        worker.on_failure(move || failed_tx.send(()).unwrap());
        for frame in vec![0.0; SAMPLE_RATE as usize].chunks(FRAME) {
            worker.push(frame);
        }
        failed_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("told about the failure");
        assert_eq!(worker.status(), SegmentationStatus::Unavailable);
        // A late subscriber hears it at once; frames are ignored from now on.
        let (late_tx, late_rx) = mpsc::channel();
        worker.on_failure(move || late_tx.send(()).unwrap());
        late_rx.try_recv().expect("called at once");
        worker.push(&[0.0; FRAME]);
        assert_eq!(worker.backlog_ms(), 0);
        worker.finish();
        assert!(sink.0.lock().unwrap().is_empty());
    }

    #[test]
    fn the_backlog_counts_the_batch_being_scored() {
        let max = 2 * SAMPLE_RATE as usize;
        let mut queue = Queue::default();
        let frame = [0.0; FRAME];
        let push = |queue: &mut Queue, seconds: usize| {
            for _ in 0..seconds * SAMPLE_RATE as usize / FRAME {
                queue.push(&frame, max);
            }
        };
        push(&mut queue, 2);
        assert_eq!(queue.backlog(), max);

        // The worker takes one batch, not the whole queue.
        let (batch, last) = queue.take_batch(BATCH_SAMPLES);
        assert!(!last);
        let taken: usize = batch.iter().map(|frame| frame.samples.len()).sum();
        assert_eq!(taken, BATCH_SAMPLES);
        assert_eq!(batch[0].position, 0);

        // While it scores (slower than real time), more audio comes: the
        // oldest queued audio goes, and the lag stays within the limit.
        push(&mut queue, 3);
        assert_eq!(queue.backlog(), max);
        let newest = queue.next_position;
        let oldest_queued = queue.frames.front().unwrap().position;
        assert_eq!(
            newest - oldest_queued,
            (max - BATCH_SAMPLES) as u64,
            "queued + scoring ≤ 2 s"
        );

        // The batch is done: the next one starts after the hole.
        queue.scoring_samples = 0;
        let (batch, _) = queue.take_batch(BATCH_SAMPLES);
        assert_eq!(batch[0].position, oldest_queued);
        assert!(queue.backlog() <= max);
    }

    #[test]
    fn the_last_batch_is_marked_once_the_queue_is_closed() {
        let mut queue = Queue::default();
        for _ in 0..(3 * BATCH_SAMPLES / 2) / FRAME {
            queue.push(&[0.0; FRAME], MAX_BACKLOG_SAMPLES);
        }
        queue.closed = true;
        assert!(!queue.take_batch(BATCH_SAMPLES).1, "more is queued");
        assert!(queue.take_batch(BATCH_SAMPLES).1, "the rest");
        assert!(queue.frames.is_empty());
    }

    /// A sink that holds the worker on its first phrase until released.
    struct Stall {
        entered: Mutex<Option<mpsc::Sender<()>>>,
        release: Mutex<mpsc::Receiver<()>>,
        phrases: Mutex<Vec<Phrase>>,
    }

    impl PhraseSink for Stall {
        fn phrase(&self, phrase: Phrase) {
            self.phrases.lock().unwrap().push(phrase);
            if let Some(entered) = self.entered.lock().unwrap().take() {
                entered.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
            }
        }
    }

    #[test]
    fn a_stalled_worker_drops_old_audio_and_keeps_times() {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let sink = Arc::new(Stall {
            entered: Mutex::new(Some(entered_tx)),
            release: Mutex::new(release_rx),
            phrases: Mutex::new(Vec::new()),
        });
        let backlog = 2 * SAMPLE_RATE as usize;
        let worker = VadWorker::spawn_with_backlog(
            &dev_model_path(),
            "rec-1",
            TranscriptChannel::Others,
            Arc::clone(&sink) as Arc<dyn PhraseSink>,
            backlog,
        );
        let speech = read_wav(&fixture("two-phrases.wav"));
        let silence = vec![0.0; 10 * SAMPLE_RATE as usize];

        // The first phrase stalls the worker; the rest of the fixture and ten
        // more seconds pile up.
        let mut stalled = false;
        for frame in speech.chunks(FRAME) {
            worker.push(frame);
            while !stalled && worker.backlog_ms() > 500 {
                stalled = entered_rx.recv_timeout(Duration::from_millis(1)).is_ok();
            }
        }
        if !stalled {
            entered_rx
                .recv_timeout(Duration::from_secs(30))
                .expect("first phrase");
        }
        for frame in silence.chunks(FRAME) {
            worker.push(frame);
            assert!(worker.backlog_ms() <= 2_000);
        }
        release_tx.send(()).unwrap();
        // Back on time: the fixture again, after the skipped audio.
        let offset_ms = (speech.len() + silence.len()) as u64 / SAMPLES_PER_MS;
        push_paced(&worker, &speech);
        worker.finish();

        let phrases = sink.phrases.lock().unwrap().clone();
        assert_near(phrases[0].start_ms, PHRASE_1_MS.0 - 100, "stalled phrase");
        let replayed: Vec<Phrase> = phrases
            .into_iter()
            .filter(|p| p.start_ms >= offset_ms)
            .collect();
        assert_two_phrases(&replayed, offset_ms);
    }
}
