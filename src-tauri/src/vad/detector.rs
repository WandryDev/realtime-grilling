//! Silero v5 through whisper.cpp's VAD API (design.md decision 16).
//!
//! `whisper_vad_detect_speech` is a batch call: every call starts the LSTM
//! from a clean state and scores 512-sample windows from the first sample
//! passed. The worker therefore re-runs a short pass that ends at the newest
//! complete step and keeps only that step's probabilities; the earlier windows
//! of the pass are context that warms the LSTM up. Passes start on the window
//! grid of the stream, so a window's probability is always computed over the
//! same 512 samples as in one pass over the whole recording.

use std::path::Path;

use whisper_rs::{WhisperVadContext, WhisperVadContextParams};

use super::WINDOW_SAMPLES;

/// New windows per pass: 8 × 32 ms = 256 ms.
pub const STEP_WINDOWS: usize = 8;
/// Windows per pass, the step included: 250 × 32 ms = 8 s. Measured against a
/// whole-file pass in `tests::experiment` (5.1, design.md decision 16):
/// a 3-s pass is off by up to 0.25 on speech windows, an 8-s one by 0.07.
pub const PASS_WINDOWS: usize = 250;

#[derive(Debug, thiserror::Error)]
pub enum VadError {
    #[error("VAD model {0} could not be loaded")]
    Load(String),
    #[error("VAD inference failed")]
    Detect,
}

/// A loaded Silero model.
pub struct SileroVad {
    context: WhisperVadContext,
}

impl SileroVad {
    pub fn load(path: &Path) -> Result<Self, VadError> {
        // Route whisper.cpp / ggml logging away from stderr (no log backend
        // is enabled, so it is dropped). Only the first call has an effect.
        whisper_rs::install_logging_hooks();

        let failed = || VadError::Load(path.display().to_string());
        // `WhisperVadContext::new` panics on an interior NUL; whisper.cpp
        // returns NULL for a missing file or a bad magic.
        let text = path.to_str().filter(|text| !text.contains('\0'));
        let Some(text) = text.filter(|_| path.is_file()) else {
            return Err(failed());
        };
        let mut params = WhisperVadContextParams::new();
        params.set_n_threads(1);
        params.set_use_gpu(false);
        let context = WhisperVadContext::new(text, params).map_err(|_| failed())?;
        Ok(Self { context })
    }

    /// Speech probability of each 512-sample window of `samples`, from a
    /// clean LSTM state. A partial last window is zero-padded.
    pub fn probabilities(&mut self, samples: &[f32]) -> Result<&[f32], VadError> {
        if samples.is_empty() {
            return Ok(&[]);
        }
        self.context
            .detect_speech(samples)
            .map_err(|_| VadError::Detect)?;
        Ok(self.context.probabilities())
    }
}

/// First sample of the pass that ends at `step_end`: up to `pass_windows`
/// windows back, never before the stream's `origin`. On the window grid when
/// `step_end` is.
pub fn pass_start(origin: u64, step_end: u64, pass_windows: usize) -> u64 {
    step_end
        .saturating_sub((pass_windows * WINDOW_SAMPLES) as u64)
        .max(origin)
}

/// The worker's sliding detection replayed over a whole buffer: one pass of
/// `pass_windows` per step of `STEP_WINDOWS`, the new windows kept. Returns
/// one probability per complete window.
pub fn sliding_probabilities(
    vad: &mut SileroVad,
    samples: &[f32],
    pass_windows: usize,
) -> Result<Vec<f32>, VadError> {
    let windows = samples.len() / WINDOW_SAMPLES;
    let mut probabilities = Vec::with_capacity(windows);
    let mut next = 0;
    while next < windows {
        let step = STEP_WINDOWS.min(windows - next);
        let end = (next + step) * WINDOW_SAMPLES;
        let start = pass_start(0, end as u64, pass_windows) as usize;
        let pass = vad.probabilities(&samples[start..end])?;
        probabilities.extend_from_slice(&pass[pass.len() - step..]);
        next += step;
    }
    Ok(probabilities)
}

#[cfg(test)]
pub(crate) mod test_audio {
    use std::path::{Path, PathBuf};

    use crate::vad::SAMPLE_RATE;

    pub fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    /// A 16 kHz mono 16-bit WAV as samples in [-1, 1].
    pub fn read_wav(path: &Path) -> Vec<f32> {
        let mut reader = hound::WavReader::open(path).expect("open WAV");
        let spec = reader.spec();
        assert_eq!(spec.sample_rate, SAMPLE_RATE, "{}", path.display());
        assert_eq!(spec.channels, 1, "{}", path.display());
        reader
            .samples::<i16>()
            .map(|sample| f32::from(sample.expect("WAV sample")) / 32_768.0)
            .collect()
    }

    /// Pink-ish noise (Paul Kellet's filter over a seeded white source) at
    /// roughly `rms`.
    pub fn pink_noise(samples: usize, rms: f32) -> Vec<f32> {
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut white = move || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((seed >> 11) as f64 / (1u64 << 53) as f64) * 2.0 - 1.0
        };
        let mut b = [0.0f64; 7];
        let mut noise: Vec<f32> = (0..samples)
            .map(|_| {
                let w = white();
                b[0] = 0.99886 * b[0] + w * 0.0555179;
                b[1] = 0.99332 * b[1] + w * 0.0750759;
                b[2] = 0.96900 * b[2] + w * 0.1538520;
                b[3] = 0.86650 * b[3] + w * 0.3104856;
                b[4] = 0.55000 * b[4] + w * 0.5329522;
                b[5] = -0.7616 * b[5] - w * 0.0168980;
                let pink = b.iter().sum::<f64>() + w * 0.5362;
                b[6] = w * 0.115926;
                pink as f32
            })
            .collect();
        let actual = (noise.iter().map(|s| s * s).sum::<f32>() / samples as f32).sqrt();
        for sample in &mut noise {
            *sample *= rms / actual;
        }
        noise
    }
}

#[cfg(test)]
mod tests {
    use super::test_audio::{fixture, read_wav};
    use super::*;
    use crate::vad::dev_model_path;

    fn model() -> SileroVad {
        SileroVad::load(&dev_model_path()).expect("bundled model loads")
    }

    struct Difference {
        speech_windows: usize,
        speech_max: f32,
        speech_mean: f32,
        all_max: f32,
        flips: usize,
    }

    /// Sliding vs whole-file probabilities. Speech windows are those the
    /// whole-file pass scores ≥ 0.5; flips are windows on the other side of
    /// 0.5 in the sliding run.
    fn compare(vad: &mut SileroVad, samples: &[f32], pass_windows: usize) -> Difference {
        let whole = vad.probabilities(samples).expect("whole pass").to_vec();
        let sliding = sliding_probabilities(vad, samples, pass_windows).expect("sliding");
        let pairs = || whole.iter().zip(&sliding);
        let speech: Vec<f32> = pairs()
            .filter(|(w, _)| **w >= 0.5)
            .map(|(w, s)| (w - s).abs())
            .collect();
        Difference {
            speech_windows: speech.len(),
            speech_max: speech.iter().copied().fold(0.0, f32::max),
            speech_mean: speech.iter().sum::<f32>() / speech.len().max(1) as f32,
            all_max: pairs().map(|(w, s)| (w - s).abs()).fold(0.0, f32::max),
            flips: pairs()
                .filter(|(w, s)| (**w >= 0.5) != (**s >= 0.5))
                .count(),
        }
    }

    #[test]
    fn a_missing_model_does_not_load() {
        assert!(SileroVad::load(Path::new("/nonexistent/silero.bin")).is_err());
    }

    #[test]
    fn a_corrupt_model_does_not_load() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        std::fs::write(file.path(), b"not a ggml model at all").expect("write");
        assert!(SileroVad::load(file.path()).is_err());
    }

    #[test]
    fn one_probability_per_window() {
        let mut vad = model();
        let probabilities = vad.probabilities(&[0.0; WINDOW_SAMPLES * 3 + 10]).unwrap();
        assert_eq!(probabilities.len(), 4);
        assert!(probabilities.iter().all(|p| *p < 0.1), "{probabilities:?}");
    }

    #[test]
    fn passes_stay_on_the_window_grid() {
        assert_eq!(pass_start(0, 4_096, PASS_WINDOWS), 0);
        assert_eq!(
            pass_start(0, 1_000 * 512, PASS_WINDOWS),
            (1_000 - PASS_WINDOWS as u64) * 512
        );
        assert_eq!(pass_start(8_000, 9_024, PASS_WINDOWS), 8_000);
    }

    /// The chosen pass keeps the sliding run within 0.1 of a whole-file pass
    /// on the speech windows of the committed fixtures.
    #[test]
    fn sliding_detection_matches_a_whole_pass_on_speech() {
        let mut vad = model();
        for name in ["two-phrases.wav", "da.wav"] {
            let samples = read_wav(&fixture(name));
            let difference = compare(&mut vad, &samples, PASS_WINDOWS);
            assert!(difference.speech_windows > 0, "{name}: no speech");
            assert!(
                difference.speech_max <= 0.1,
                "{name}: max {} on speech windows",
                difference.speech_max
            );
            assert_eq!(difference.flips, 0, "{name}");
        }
    }

    /// Experiment 5.1: sliding passes of several lengths against a whole-file
    /// pass. Runs over the committed fixtures and every WAV (16 kHz mono) in
    /// `$GRILL_VAD_FIXTURES`:
    ///
    /// `GRILL_VAD_FIXTURES=… cargo test --lib vad::detector::tests::experiment -- --ignored --nocapture`
    #[test]
    #[ignore = "experiment; prints a table"]
    fn experiment() {
        let mut files = vec![fixture("two-phrases.wav"), fixture("da.wav")];
        if let Ok(dir) = std::env::var("GRILL_VAD_FIXTURES") {
            let mut extra: Vec<_> = std::fs::read_dir(dir)
                .expect("fixtures dir")
                .map(|entry| entry.expect("entry").path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "wav"))
                .collect();
            extra.sort();
            files.extend(extra);
        }
        let mut vad = model();
        println!(
            "file\tpass_ms\tspeech_windows\tspeech_max\tspeech_mean\tall_max\tflips@0.5\tsliding_time"
        );
        for pass_windows in [94, 125, 188, 250, 313] {
            let mut total = Difference {
                speech_windows: 0,
                speech_max: 0.0,
                speech_mean: 0.0,
                all_max: 0.0,
                flips: 0,
            };
            for file in &files {
                let samples = read_wav(file);
                let started = std::time::Instant::now();
                let d = compare(&mut vad, &samples, pass_windows);
                let elapsed = started.elapsed();
                println!(
                    "{}\t{}\t{}\t{:.4}\t{:.4}\t{:.4}\t{}\t{elapsed:.0?}",
                    file.file_name().unwrap().to_string_lossy(),
                    pass_windows * 32,
                    d.speech_windows,
                    d.speech_max,
                    d.speech_mean,
                    d.all_max,
                    d.flips
                );
                total.speech_mean += d.speech_mean * d.speech_windows as f32;
                total.speech_windows += d.speech_windows;
                total.speech_max = total.speech_max.max(d.speech_max);
                total.all_max = total.all_max.max(d.all_max);
                total.flips += d.flips;
            }
            println!(
                "TOTAL\t{}\t{}\t{:.4}\t{:.4}\t{:.4}\t{}",
                pass_windows * 32,
                total.speech_windows,
                total.speech_max,
                total.speech_mean / total.speech_windows.max(1) as f32,
                total.all_max,
                total.flips
            );
        }
    }
}
