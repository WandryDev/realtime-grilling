//! Signal level for the meters (design.md, decision 12): RMS over ~100 ms
//! mapped to 0–1 on a dBFS scale with a −60 dB floor.

use std::sync::{Arc, Mutex, PoisonError};

use super::sink::Breakdown;
use crate::error::CaptureFailure;

/// Level 0 is this quiet or quieter.
pub const FLOOR_DB: f32 = -60.0;

/// RMS → 0–1: −60 dBFS and below is 0, full scale (and above) is 1.
pub fn level_from_rms(rms: f32) -> f32 {
    // NaN is silence too.
    if rms.is_nan() || rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db - FLOOR_DB) / -FLOOR_DB).clamp(0.0, 1.0)
}

/// Sum of squares since the last read.
#[derive(Debug, Default)]
pub struct Accumulator {
    sum: f64,
    count: u64,
}

impl Accumulator {
    pub fn add(&mut self, samples: impl IntoIterator<Item = f32>) {
        for sample in samples {
            if sample.is_finite() {
                self.sum += f64::from(sample) * f64::from(sample);
                self.count += 1;
            }
        }
    }

    fn rms(&self) -> f32 {
        if self.count == 0 {
            return 0.0;
        }
        #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
        let rms = (self.sum / self.count as f64).sqrt() as f32;
        rms
    }

    /// The level of what came since the last call, then starts over.
    /// Nothing came (the device is idle) is silence.
    pub fn take_level(&mut self) -> f32 {
        let level = level_from_rms(self.rms());
        *self = Self::default();
        level
    }
}

/// Why a running capture stopped on its own (device unplugged, stream
/// invalidated…): reported to the subscribers instead of zeros.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub reason: CaptureFailure,
    pub message: String,
}

#[derive(Debug, Default)]
struct Shared {
    levels: Mutex<Accumulator>,
    failure: Breakdown,
}

/// Where a capture callback puts its samples; the meter reads it every
/// tick. A callback never waits for the meter: a block that meets a held
/// lock is skipped, which a meter doesn't notice.
#[derive(Debug, Clone, Default)]
pub struct Feed(Arc<Shared>);

impl Feed {
    pub fn push(&self, samples: impl IntoIterator<Item = f32>) {
        if let Ok(mut accumulator) = self.0.levels.try_lock() {
            accumulator.add(samples);
        }
    }

    pub fn take_level(&self) -> f32 {
        self.0
            .levels
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take_level()
    }

    /// The capture broke; the first failure is kept until the meter reads it.
    #[cfg(test)]
    pub fn fail(&self, reason: CaptureFailure, message: impl Into<String>) {
        self.0.failure.fail(reason, message);
    }

    pub fn take_failure(&self) -> Option<Failure> {
        self.0.failure.take()
    }

    /// The failure slot, for the capture's error callback.
    pub fn breakdown_handle(&self) -> Breakdown {
        self.0.failure.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::f32::consts::TAU;

    use super::*;

    fn rms(samples: &[f32]) -> f32 {
        let mut sum = Accumulator::default();
        sum.add(samples.iter().copied());
        sum.rms()
    }

    /// 100 ms of a sine at 48 kHz.
    fn sine(amplitude: f32) -> Vec<f32> {
        (0..4800)
            .map(|index| {
                #[allow(clippy::cast_precision_loss)]
                let time = index as f32 / 48_000.0;
                amplitude * (TAU * 440.0 * time).sin()
            })
            .collect()
    }

    #[test]
    fn silence_is_zero() {
        assert_eq!(level_from_rms(rms(&[0.0; 4800])), 0.0);
        assert_eq!(level_from_rms(rms(&[])), 0.0);
        let mut accumulator = Accumulator::default();
        assert_eq!(accumulator.take_level(), 0.0, "no samples");
    }

    #[test]
    fn a_full_scale_sine_is_near_the_top() {
        let rms = rms(&sine(1.0));
        assert!(
            (rms - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.01,
            "{rms}"
        );
        // −3 dBFS → 57/60.
        let level = level_from_rms(rms);
        assert!((level - 0.95).abs() < 0.01, "{level}");
    }

    #[test]
    fn a_quiet_sine_is_low_and_below_the_floor_is_zero() {
        // −40 dBFS peak, −43 dBFS RMS → ≈ 0.28.
        let level = level_from_rms(rms(&sine(0.01)));
        assert!((level - 0.283).abs() < 0.01, "{level}");
        assert_eq!(level_from_rms(rms(&sine(0.0005))), 0.0);
    }

    #[test]
    fn clipping_is_one() {
        let square: Vec<f32> = (0..4800)
            .map(|index| if index % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        assert_eq!(level_from_rms(rms(&square)), 1.0);
        assert_eq!(
            level_from_rms(rms(&[1.7, -2.0, 1.5])),
            1.0,
            "over full scale"
        );
    }

    #[test]
    fn the_feed_starts_over_after_a_read() {
        let feed = Feed::default();
        feed.push(sine(1.0));
        assert!(feed.take_level() > 0.9);
        assert_eq!(feed.take_level(), 0.0);
        feed.push([f32::NAN, 0.0]);
        assert_eq!(feed.take_level(), 0.0, "NaN is dropped");
    }

    #[test]
    fn the_first_failure_is_kept_until_read() {
        let feed = Feed::default();
        assert_eq!(feed.take_failure(), None);
        feed.fail(CaptureFailure::NoDevice, "Микрофон отключён");
        feed.fail(CaptureFailure::Busy, "later");
        assert_eq!(
            feed.take_failure(),
            Some(Failure {
                reason: CaptureFailure::NoDevice,
                message: "Микрофон отключён".to_owned()
            })
        );
        assert_eq!(feed.take_failure(), None);
    }
}
