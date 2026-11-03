//! One channel on the recording's timeline (audio-capture design.md,
//! decision 9).
//!
//! Capture blocks come in at the device's rate and channel count, stamped
//! with the host time of their first sample. The timeline mixes them down to
//! mono, resamples them to 16 kHz and places them by that time: sample `n` of
//! the output belongs `n / 16000` seconds after the recording started (`t0`).
//!
//! - A block that starts more than 20 ms after where the channel's cursor is
//!   gets silence in front of it (the tap started late, a gap, a reconnect).
//! - A block that starts more than 20 ms before the cursor loses its head
//!   (the device clock runs fast).
//!
//! Drift within ±20 ms is left alone; AEC3's delay estimator follows it.

use std::collections::VecDeque;

use rubato::{
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
    calculate_cutoff,
};

use super::{FRAME, SAMPLE_RATE};

/// How far a block may sit from the cursor before it is corrected.
pub const MAX_SKEW: f64 = 0.020;

const NANOS_PER_SECOND: f64 = 1e9;
const OUTPUT_RATE: f64 = SAMPLE_RATE as f64;
/// Length of the windowed sinc; 128 keeps the 16 kHz band clean at a few
/// percent of a core.
const SINC_LEN: usize = 128;
const WINDOW: WindowFunction = WindowFunction::BlackmanHarris2;

/// Captured audio as the device delivered it.
#[derive(Debug, Clone, Copy)]
pub struct InputBlock<'a> {
    /// Interleaved samples, `channels` per frame.
    pub samples: &'a [f32],
    pub channels: u16,
    pub sample_rate: u32,
    /// Host time of the first frame, in nanoseconds of the same monotonic
    /// clock as `t0`.
    pub host_time_ns: u64,
}

/// What the corrections did so far, for the log.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TimelineStats {
    /// 16 kHz samples of silence put in front of late blocks or filled in.
    pub silence_inserted: u64,
    /// 16 kHz samples cut from blocks that came early.
    pub samples_dropped: u64,
}

/// Turns one channel's capture blocks into 10 ms frames on the timeline.
pub struct Timeline {
    t0_ns: u64,
    /// Timeline position (16 kHz samples, fractional) of the next input
    /// sample.
    cursor: f64,
    stage: Option<Stage>,
    /// 16 kHz samples ready; the first one is at `popped`.
    output: VecDeque<f32>,
    popped: u64,
    mono: Vec<f32>,
    /// The last block was cut whole and the cursor is still ahead: keep
    /// cutting down to the block's time, not just to within 20 ms.
    catching_up: bool,
    stats: TimelineStats,
}

/// Rate conversion for one input rate.
enum Stage {
    Passthrough,
    Resample(Box<Resampling>),
}

struct Resampling {
    rate: u32,
    resampler: SincFixedIn<f32>,
    /// Input frames per `process` call (10 ms).
    chunk: usize,
    /// Mono input not resampled yet, from `start`.
    pending: Vec<f32>,
    start: usize,
    out: Vec<Vec<f32>>,
}

impl Resampling {
    fn new(rate: u32) -> Option<Self> {
        let chunk = usize::try_from(rate / 100).ok()?.max(1);
        let parameters = SincInterpolationParameters {
            sinc_len: SINC_LEN,
            f_cutoff: calculate_cutoff(SINC_LEN, WINDOW),
            oversampling_factor: 128,
            interpolation: SincInterpolationType::Linear,
            window: WINDOW,
        };
        let resampler =
            SincFixedIn::new(OUTPUT_RATE / f64::from(rate), 1.0, parameters, chunk, 1).ok()?;
        // `SincFixedIn` starts its read index half a filter back, so its
        // output is already aligned with its input: no delay to drop.
        let out = vec![vec![0.0; resampler.output_frames_max()]];
        Some(Self {
            rate,
            resampler,
            chunk,
            pending: Vec::with_capacity(chunk * 4),
            start: 0,
            out,
        })
    }

    /// Resamples every full chunk of `pending` into `output`.
    fn run(&mut self, output: &mut VecDeque<f32>) {
        while self.pending.len() - self.start >= self.chunk {
            let input = &self.pending[self.start..self.start + self.chunk];
            match self
                .resampler
                .process_into_buffer(&[input], &mut self.out, None)
            {
                Ok((_, produced)) => output.extend(&self.out[0][..produced]),
                // Only on wrong buffer sizes, which are fixed at creation.
                Err(error) => eprintln!("grill: resampling failed: {error}"),
            }
            self.start += self.chunk;
        }
        // Keep the unprocessed tail at the front without reallocating.
        if self.start > 0 {
            self.pending.drain(..self.start);
            self.start = 0;
        }
    }

    /// Pushes out what the resampler still holds (zero-padded: the filter's
    /// half length past the last input sample). The caller trims the
    /// padding back to the cursor.
    fn flush(&mut self, output: &mut VecDeque<f32>) {
        let held = self.pending.len() - self.start;
        let needed = held + SINC_LEN;
        let padded = needed.div_ceil(self.chunk) * self.chunk;
        self.pending.resize(self.start + padded, 0.0);
        self.run(output);
    }
}

impl Timeline {
    /// A channel of a recording that started at host time `t0_ns`.
    pub fn new(t0_ns: u64) -> Self {
        Self {
            t0_ns,
            cursor: 0.0,
            stage: None,
            output: VecDeque::with_capacity(SAMPLE_RATE as usize),
            popped: 0,
            mono: Vec::new(),
            catching_up: false,
            stats: TimelineStats::default(),
        }
    }

    /// Where the next input sample goes, in 16 kHz samples from `t0`.
    #[cfg_attr(not(test), allow(dead_code, reason = "used by the tests"))]
    pub fn cursor(&self) -> f64 {
        self.cursor
    }

    /// The timeline is ready up to here (16 kHz samples from `t0`): popped
    /// frames plus the samples waiting. Lags [`Self::cursor`] by what the
    /// resampler holds.
    pub fn ready_until(&self) -> u64 {
        self.popped + self.output.len() as u64
    }

    /// Samples waiting to be popped.
    pub fn available(&self) -> usize {
        self.output.len()
    }

    pub fn stats(&self) -> TimelineStats {
        self.stats
    }

    /// Where on the timeline a host time falls, in 16 kHz samples (negative
    /// before `t0`).
    pub fn position_of(&self, host_time_ns: u64) -> f64 {
        let delta = if host_time_ns >= self.t0_ns {
            (host_time_ns - self.t0_ns) as f64
        } else {
            -((self.t0_ns - host_time_ns) as f64)
        };
        delta * OUTPUT_RATE / NANOS_PER_SECOND
    }

    /// Adds a capture block. Blocks without samples, channels or rate are
    /// ignored.
    pub fn push(&mut self, block: InputBlock) {
        let channels = usize::from(block.channels);
        if channels == 0 || block.sample_rate == 0 || block.samples.len() < channels {
            return;
        }
        self.prepare_stage(block.sample_rate);
        let ratio = OUTPUT_RATE / f64::from(block.sample_rate);

        let mut mono = std::mem::take(&mut self.mono);
        mono.clear();
        let scale = 1.0 / channels as f32;
        mono.extend(
            block
                .samples
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() * scale),
        );

        let skew = self.position_of(block.host_time_ns) - self.cursor;
        let ahead_limit = if self.catching_up {
            0.5
        } else {
            MAX_SKEW * OUTPUT_RATE
        };
        let mut head = 0;
        if skew > MAX_SKEW * OUTPUT_RATE {
            self.insert_silence(skew);
        } else if skew < -ahead_limit {
            head = ((-skew / ratio).round() as usize).min(mono.len());
            self.stats.samples_dropped += (head as f64 * ratio).round() as u64;
        }
        self.catching_up = head > 0 && head == mono.len();
        self.feed(&mono[head..]);
        self.mono = mono;
    }

    /// Fills the timeline with silence up to `position` (16 kHz samples from
    /// `t0`) when the channel delivered nothing until then: the recorder calls
    /// it for a channel that is stalled, reconnecting or has no access, so
    /// the other channel's frames keep flowing. Nothing happens if the
    /// channel is already there.
    pub fn fill_silence_until(&mut self, position: u64) {
        let gap = position as f64 - self.cursor;
        if gap > 0.0 {
            self.insert_silence(gap);
        }
    }

    /// Takes the next 10 ms frame, if there is one.
    pub fn pop_frame(&mut self, frame: &mut [f32; FRAME]) -> bool {
        if self.output.len() < FRAME {
            return false;
        }
        for (slot, sample) in frame.iter_mut().zip(self.output.drain(..FRAME)) {
            *slot = sample;
        }
        self.popped += FRAME as u64;
        true
    }

    /// A new input rate (first block, or the device was reopened with
    /// another rate): what the old resampler holds is flushed, and the
    /// output is cut or padded to the cursor so the next block lands where
    /// its time says.
    fn prepare_stage(&mut self, rate: u32) {
        let current = match &self.stage {
            None => None,
            Some(Stage::Passthrough) => Some(SAMPLE_RATE),
            Some(Stage::Resample(resampling)) => Some(resampling.rate),
        };
        if current == Some(rate) {
            return;
        }
        if let Some(Stage::Resample(mut old)) = self.stage.take() {
            old.flush(&mut self.output);
            self.align_output_to_cursor();
        }
        self.stage = if rate == SAMPLE_RATE {
            Some(Stage::Passthrough)
        } else {
            match Resampling::new(rate) {
                Some(resampling) => Some(Stage::Resample(Box::new(resampling))),
                None => {
                    eprintln!("grill: no resampler for {rate} Hz");
                    None
                }
            }
        };
    }

    fn align_output_to_cursor(&mut self) {
        let target = self.cursor.round().max(0.0) as u64;
        let ready = self.ready_until();
        if ready < target {
            self.output
                .extend(std::iter::repeat_n(0.0, (target - ready) as usize));
        } else {
            let excess = usize::try_from(ready - target).unwrap_or(usize::MAX);
            let keep = self.output.len().saturating_sub(excess);
            self.output.truncate(keep);
        }
    }

    /// `amount` 16 kHz samples of silence at the cursor.
    fn insert_silence(&mut self, amount: f64) {
        match &mut self.stage {
            Some(Stage::Resample(resampling)) => {
                let ratio = OUTPUT_RATE / f64::from(resampling.rate);
                let count = (amount / ratio).round() as usize;
                // Through the resampler, chunk by chunk, so what it holds
                // comes out first.
                let mut left = count;
                while left > 0 {
                    let step = left.min(resampling.chunk * 50);
                    let end = resampling.pending.len() + step;
                    resampling.pending.resize(end, 0.0);
                    resampling.run(&mut self.output);
                    left -= step;
                }
                self.cursor += count as f64 * ratio;
                self.stats.silence_inserted += (count as f64 * ratio).round() as u64;
            }
            // Passthrough, or no block yet: straight to the output.
            _ => {
                let count = amount.round() as usize;
                self.output.extend(std::iter::repeat_n(0.0, count));
                self.cursor += count as f64;
                self.stats.silence_inserted += count as u64;
            }
        }
    }

    fn feed(&mut self, mono: &[f32]) {
        match &mut self.stage {
            Some(Stage::Passthrough) => {
                self.output.extend(mono);
                self.cursor += mono.len() as f64;
            }
            Some(Stage::Resample(resampling)) => {
                resampling.pending.extend_from_slice(mono);
                resampling.run(&mut self.output);
                self.cursor += mono.len() as f64 * OUTPUT_RATE / f64::from(resampling.rate);
            }
            None => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u64 = 1_000_000;
    const T0: u64 = 5_000 * MS;
    const SAMPLES_PER_MS: f64 = OUTPUT_RATE / 1000.0;

    /// Feeds `seconds` of `signal(t)` (t in true seconds since `start_ns`)
    /// in 10 ms blocks of `channels` identical channels. The device clock
    /// runs `ppm` fast: it delivers `rate * (1 + ppm)` frames per second.
    #[allow(clippy::too_many_arguments)]
    fn feed(
        timeline: &mut Timeline,
        rate: u32,
        channels: u16,
        start_ns: u64,
        seconds: f64,
        ppm: f64,
        signal: impl Fn(f64) -> f32,
        mut each: impl FnMut(&mut Timeline, f64),
    ) {
        let true_rate = f64::from(rate) * (1.0 + ppm * 1e-6);
        let block = (rate / 100) as usize;
        let total = (seconds * true_rate) as usize;
        let mut samples = Vec::with_capacity(block * usize::from(channels));
        let mut index = 0;
        while index < total {
            samples.clear();
            for k in index..(index + block).min(total) {
                let value = signal(k as f64 / true_rate);
                samples.extend(std::iter::repeat_n(value, usize::from(channels)));
            }
            let first_s = index as f64 / true_rate;
            let host_time_ns = start_ns + (first_s * NANOS_PER_SECOND).round() as u64;
            timeline.push(InputBlock {
                samples: &samples,
                channels,
                sample_rate: rate,
                host_time_ns,
            });
            index += block;
            let expected_next = timeline.position_of(
                start_ns + (index as f64 / true_rate * NANOS_PER_SECOND).round() as u64,
            );
            each(timeline, expected_next);
        }
    }

    fn drain(timeline: &mut Timeline) -> Vec<f32> {
        let mut out = Vec::new();
        let mut frame = [0.0; FRAME];
        while timeline.pop_frame(&mut frame) {
            out.extend_from_slice(&frame);
        }
        out
    }

    /// Index of the first sample louder than `threshold`.
    fn onset(samples: &[f32], threshold: f32) -> usize {
        samples
            .iter()
            .position(|sample| sample.abs() > threshold)
            .expect("no onset")
    }

    fn tone(t: f64) -> f32 {
        (0.5 * (2.0 * std::f64::consts::PI * 440.0 * t).sin()) as f32
    }

    #[test]
    fn late_start_gets_leading_silence() {
        for rate in [16_000, 44_100, 48_000] {
            let mut timeline = Timeline::new(T0);
            // The tap delivers its first sample 2 s after the recording began.
            feed(
                &mut timeline,
                rate,
                2,
                T0 + 2_000 * MS,
                1.0,
                0.0,
                tone,
                |_, _| {},
            );
            let out = drain(&mut timeline);

            let start = onset(&out, 0.05);
            let expected = 2.0 * OUTPUT_RATE;
            assert!(
                (start as f64 - expected).abs() <= SAMPLES_PER_MS,
                "{rate} Hz: sound starts at {start}, expected {expected}"
            );
            assert!(out[..start].iter().all(|sample| sample.abs() < 0.05));
            assert!(timeline.stats().silence_inserted >= 31_000);
        }
    }

    #[test]
    fn blocks_before_t0_lose_their_head() {
        let mut timeline = Timeline::new(T0);
        // Capture began 500 ms before the recording: a click at t0 + 100 ms.
        let click = |t: f64| if (0.6..0.601).contains(&t) { 1.0 } else { 0.0 };
        feed(
            &mut timeline,
            48_000,
            1,
            T0 - 500 * MS,
            1.0,
            0.0,
            click,
            |_, _| {},
        );
        let out = drain(&mut timeline);
        let at = onset(&out, 0.2);
        assert!(
            (at as f64 - 0.1 * OUTPUT_RATE).abs() <= SAMPLES_PER_MS,
            "click at {at}"
        );
        assert!(timeline.stats().samples_dropped >= 7_900);
    }

    #[test]
    fn gap_is_filled_with_silence() {
        for rate in [16_000, 48_000] {
            let mut timeline = Timeline::new(T0);
            feed(&mut timeline, rate, 1, T0, 1.0, 0.0, tone, |_, _| {});
            // 300 ms without blocks (device switch), then the sound resumes
            // with a click on its first sample.
            let click = |t: f64| if t < 0.001 { 1.0 } else { 0.0 };
            feed(
                &mut timeline,
                rate,
                1,
                T0 + 1_300 * MS,
                0.5,
                0.0,
                click,
                |_, _| {},
            );
            let out = drain(&mut timeline);

            let gap = &out[(1.02 * OUTPUT_RATE) as usize..(1.28 * OUTPUT_RATE) as usize];
            assert!(gap.iter().all(|sample| sample.abs() < 0.01), "{rate} Hz");
            let resumed =
                (1.25 * OUTPUT_RATE) as usize + onset(&out[(1.25 * OUTPUT_RATE) as usize..], 0.2);
            assert!(
                (resumed as f64 - 1.3 * OUTPUT_RATE).abs() <= SAMPLES_PER_MS,
                "{rate} Hz: resumed at {resumed}"
            );
            assert!(out.len() >= (1.75 * OUTPUT_RATE) as usize);
        }
    }

    #[test]
    fn small_jitter_is_left_alone() {
        let mut timeline = Timeline::new(T0);
        let block = vec![0.1; 160];
        for (index, jitter_ms) in [0_i64, 5, -5, 15, -15, 0].into_iter().enumerate() {
            let at = T0 as i64 + index as i64 * 10 * MS as i64 + jitter_ms * MS as i64;
            timeline.push(InputBlock {
                samples: &block,
                channels: 1,
                sample_rate: 16_000,
                host_time_ns: at as u64,
            });
        }
        assert_eq!(timeline.stats(), TimelineStats::default());
        assert_eq!(timeline.available(), 960);
    }

    /// 100 ppm over an hour is 360 ms; corrections keep every block within
    /// 20 ms of where its time puts it, and the output as long as the hour.
    #[test]
    fn clock_drift_over_an_hour_stays_within_20_ms() {
        for ppm in [100.0, -100.0] {
            let mut timeline = Timeline::new(T0);
            let mut worst: f64 = 0.0;
            let mut frame = [0.0; FRAME];
            // 10 ms blocks of a 16 kHz device whose clock runs `ppm` off;
            // the host clock is the truth.
            let block = [0.1_f32; FRAME];
            let true_rate = OUTPUT_RATE * (1.0 + ppm * 1e-6);
            let blocks = (3_600.0 * true_rate) as u64 / FRAME as u64;
            for index in 0..blocks {
                let at =
                    |n: u64| T0 + ((n * FRAME as u64) as f64 / true_rate * NANOS_PER_SECOND) as u64;
                timeline.push(InputBlock {
                    samples: &block,
                    channels: 1,
                    sample_rate: SAMPLE_RATE,
                    host_time_ns: at(index),
                });
                let expected = timeline.position_of(at(index + 1));
                worst = worst.max((timeline.cursor() - expected).abs());
                while timeline.pop_frame(&mut frame) {}
            }
            let limit = 20.0 * SAMPLES_PER_MS;
            assert!(
                worst <= limit + 1.0,
                "{ppm} ppm: worst skew {worst} samples"
            );
            let hour = 3_600.0 * OUTPUT_RATE;
            assert!(
                (timeline.ready_until() as f64 - hour).abs() <= limit + 160.0,
                "{ppm} ppm: {} samples for an hour",
                timeline.ready_until()
            );
            let stats = timeline.stats();
            let corrected = stats.samples_dropped + stats.silence_inserted;
            assert!(corrected as f64 > 0.3 * OUTPUT_RATE, "{ppm} ppm: {stats:?}");
        }
    }

    /// The same through the resampler, with clicks to see where the sound
    /// lands: 1000 ppm over 2 minutes (120 ms of drift).
    #[test]
    fn drift_through_the_resampler_keeps_clicks_in_place() {
        let mut timeline = Timeline::new(T0);
        let click = |t: f64| if t % 10.0 < 0.0005 { 1.0 } else { 0.0 };
        let mut out = Vec::new();
        let mut frame = [0.0; FRAME];
        feed(
            &mut timeline,
            48_000,
            2,
            T0,
            120.0,
            1000.0,
            click,
            |timeline, _| {
                while timeline.pop_frame(&mut frame) {
                    out.extend_from_slice(&frame);
                }
            },
        );
        for second in (10..120).step_by(10) {
            let expected = second as f64 * OUTPUT_RATE;
            let from = expected as usize - 800;
            let window = &out[from..from + 1600];
            let peak = window
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.abs().total_cmp(&b.1.abs()))
                .unwrap()
                .0;
            let error_ms = (from + peak) as f64 - expected;
            assert!(
                error_ms.abs() <= 20.0 * SAMPLES_PER_MS + SAMPLES_PER_MS,
                "click of {second} s off by {} ms",
                error_ms / SAMPLES_PER_MS
            );
        }
        assert!(timeline.stats().samples_dropped > 0);
    }

    #[test]
    fn fill_keeps_a_silent_channel_moving_and_a_late_block_in_place() {
        let mut timeline = Timeline::new(T0);
        timeline.fill_silence_until(1_600);
        assert_eq!(timeline.available(), 1_600);
        // Nothing to do when it is already there.
        timeline.fill_silence_until(800);
        assert_eq!(timeline.available(), 1_600);

        // The first block arrives for 50 ms (800 samples), already covered by
        // the silence: its first 50 ms are cut.
        let click = |t: f64| {
            if t < 0.0005 || (0.06..0.0605).contains(&t) {
                1.0
            } else {
                0.0
            }
        };
        feed(
            &mut timeline,
            48_000,
            1,
            T0 + 50 * MS,
            0.2,
            0.0,
            click,
            |_, _| {},
        );
        let out = drain(&mut timeline);
        let at = 1_600 + onset(&out[1_600..], 0.2);
        assert!(
            (at as f64 - 0.11 * OUTPUT_RATE).abs() <= SAMPLES_PER_MS,
            "second click at {at}"
        );
    }

    #[test]
    fn rate_change_keeps_the_position() {
        let mut timeline = Timeline::new(T0);
        feed(&mut timeline, 48_000, 1, T0, 1.0, 0.0, |_| 0.0, |_, _| {});
        // Reopened at 44.1 kHz right where it stopped, with a click.
        let click = |t: f64| if t < 0.0005 { 1.0 } else { 0.0 };
        feed(
            &mut timeline,
            44_100,
            1,
            T0 + 1_000 * MS,
            0.5,
            0.0,
            click,
            |_, _| {},
        );
        let out = drain(&mut timeline);
        let at = onset(&out, 0.2);
        assert!(
            (at as f64 - OUTPUT_RATE).abs() <= SAMPLES_PER_MS,
            "click at {at}"
        );
    }

    #[test]
    fn downmixes_to_mono() {
        let mut timeline = Timeline::new(T0);
        let stereo: Vec<f32> = (0..160).flat_map(|_| [0.5, -0.1]).collect();
        timeline.push(InputBlock {
            samples: &stereo,
            channels: 2,
            sample_rate: 16_000,
            host_time_ns: T0,
        });
        let mut frame = [0.0; FRAME];
        assert!(timeline.pop_frame(&mut frame));
        assert!(frame.iter().all(|sample| (sample - 0.2).abs() < 1e-6));
        assert!(!timeline.pop_frame(&mut frame));
    }

    #[test]
    fn ignores_empty_blocks() {
        let mut timeline = Timeline::new(T0);
        for (samples, channels, sample_rate) in [
            (&[][..], 1, 16_000),
            (&[0.1][..], 0, 16_000),
            (&[0.1][..], 1, 0),
        ] {
            timeline.push(InputBlock {
                samples,
                channels,
                sample_rate,
                host_time_ns: T0,
            });
        }
        assert_eq!(timeline.available(), 0);
        assert_eq!(timeline.cursor(), 0.0);
    }
}
