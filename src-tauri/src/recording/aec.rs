//! Echo cancellation of the "Я" channel (audio-capture design.md,
//! decision 10): WebRTC AEC3 through `sonora`, 16 kHz mono, 10 ms frames.
//! The reference (render) is the "Остальные" frame at the same timeline
//! position; AEC3 estimates the acoustic delay itself (up to ~500 ms).
//!
//! High-pass filter on, noise suppression and AGC off: they hurt
//! recognition. Bypassed when there is no system channel to cancel against,
//! or with `GRILL_AEC=off` for comparisons.

use sonora::{
    AudioProcessing, Config, StreamConfig,
    config::{EchoCanceller, HighPassFilter},
};

use super::{FRAME, SAMPLE_RATE};

/// Environment variable that turns AEC off when set to `off`.
pub const ENV: &str = "GRILL_AEC";

/// Whether the environment allows AEC (`GRILL_AEC` is not `off`).
pub fn allowed_by_env() -> bool {
    allows(std::env::var(ENV).ok().as_deref())
}

fn allows(value: Option<&str>) -> bool {
    value.is_none_or(|value| !value.trim().eq_ignore_ascii_case("off"))
}

/// AEC3 on the "Я" channel, or a pass-through.
pub struct Aec {
    apm: Option<Box<AudioProcessing>>,
    render_out: [f32; FRAME],
    capture_in: [f32; FRAME],
}

impl Aec {
    /// AEC for a recording: active when the system channel is there and the
    /// environment does not turn it off.
    pub fn for_recording(has_system_channel: bool) -> Self {
        Self::new(has_system_channel && allowed_by_env())
    }

    pub fn new(enabled: bool) -> Self {
        let apm = enabled.then(|| {
            let config = Config {
                echo_canceller: Some(EchoCanceller::default()),
                high_pass_filter: Some(HighPassFilter::default()),
                noise_suppression: None,
                gain_controller2: None,
                ..Default::default()
            };
            let stream = StreamConfig::new(SAMPLE_RATE, 1);
            Box::new(
                AudioProcessing::builder()
                    .config(config)
                    .capture_config(stream)
                    .render_config(stream)
                    .build(),
            )
        });
        Self {
            apm,
            render_out: [0.0; FRAME],
            capture_in: [0.0; FRAME],
        }
    }

    pub fn is_active(&self) -> bool {
        self.apm.is_some()
    }

    /// Removes the echo of `others` from `me`, in place. A pass-through
    /// leaves `me` as it is.
    pub fn process(&mut self, me: &mut [f32; FRAME], others: &[f32; FRAME]) {
        let Some(apm) = self.apm.as_mut() else {
            return;
        };
        if let Err(error) = apm.process_render_f32(&[others], &mut [&mut self.render_out]) {
            eprintln!("grill: AEC render frame failed: {error:?}");
        }
        // Channels are aligned by capture time: the remaining delay is the
        // acoustic path, which AEC3 estimates.
        let _ = apm.set_stream_delay_ms(0);
        self.capture_in = *me;
        if let Err(error) = apm.process_capture_f32(&[&self.capture_in], &mut [me]) {
            eprintln!("grill: AEC capture frame failed: {error:?}");
            *me = self.capture_in;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = SAMPLE_RATE as f64;

    struct Noise(u32);

    impl Noise {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 17;
            self.0 ^= self.0 << 5;
            (f64::from(self.0) / f64::from(u32::MAX)) * 2.0 - 1.0
        }
    }

    /// The spike's far end without TTS (`spikes/audio`, `synth_farend`):
    /// harmonic "vowels", 4 syllables a second, a pause every 2.5 s.
    fn far_end(seconds: f64) -> Vec<f32> {
        let mut noise = Noise(0x1234_5678);
        (0..(RATE * seconds) as usize)
            .map(|n| {
                let t = n as f64 / RATE;
                if t % 2.5 >= 1.8 {
                    return 0.0;
                }
                let envelope = (std::f64::consts::PI * ((t * 4.0) % 1.0)).sin().powi(2);
                let f0 = 140.0 + 30.0 * (t * 1.3).sin();
                let voiced: f64 = (1..=12)
                    .map(|h| {
                        let h = f64::from(h);
                        let formant = 1.0 / (1.0 + ((h * f0 - 700.0) / 400.0).powi(2));
                        formant * (2.0 * std::f64::consts::PI * h * f0 * t).sin()
                    })
                    .sum();
                (0.25 * envelope * voiced + 0.01 * noise.next() * envelope) as f32
            })
            .collect()
    }

    /// The spike's `aec-sim` room: the far end through a 60 ms delay and a
    /// decaying random tail (RT60 ~250 ms), 6 dB below the reference, plus
    /// a little noise. Nobody talks at the near end.
    fn mic_with_echo(far: &[f32], delay_ms: f64, erl_db: f64) -> Vec<f32> {
        let delay = (delay_ms / 1e3 * RATE) as usize;
        let tail = (0.25 * RATE) as usize;
        let mut noise = Noise(0x2545_f491);
        let mut taps = vec![0.0_f64; tail];
        taps[0] = 1.0;
        for (k, tap) in taps.iter_mut().enumerate().skip(1) {
            let t = k as f64 / RATE;
            *tap = 0.3 * noise.next() * (-6.9 * t / 0.25).exp();
        }
        let norm = taps.iter().map(|v| v * v).sum::<f64>().sqrt();
        let gain = 10_f64.powf(-erl_db / 20.0) / norm;
        // Direct convolution, scattering each far-end sample over the taps
        // (cheaper than gathering in a debug build).
        let mut echo = vec![0.0_f32; far.len()];
        let taps: Vec<f32> = taps.iter().map(|tap| (tap * gain) as f32).collect();
        for (n, &sample) in far.iter().enumerate() {
            if sample == 0.0 || n + delay >= echo.len() {
                continue;
            }
            let span = (echo.len() - n - delay).min(taps.len());
            for (out, tap) in echo[n + delay..n + delay + span]
                .iter_mut()
                .zip(&taps[..span])
            {
                *out += sample * tap;
            }
        }
        echo.iter()
            .map(|sample| sample + (0.002 * noise.next()) as f32)
            .collect()
    }

    fn energy(samples: &[f32]) -> f64 {
        samples.iter().map(|v| f64::from(*v).powi(2)).sum()
    }

    fn run(aec: &mut Aec, mic: &[f32], far: &[f32]) -> Vec<f32> {
        let mut out = Vec::with_capacity(mic.len());
        let (mic_frames, _) = mic.as_chunks::<FRAME>();
        let (far_frames, _) = far.as_chunks::<FRAME>();
        for (me, others) in mic_frames.iter().zip(far_frames) {
            let mut frame = *me;
            aec.process(&mut frame, others);
            out.extend_from_slice(&frame);
        }
        out
    }

    /// ERLE on frames where the far end talks, after `skip_s` of convergence.
    fn erle_db(mic: &[f32], out: &[f32], far: &[f32], skip_s: f64) -> f64 {
        let (mut before, mut after) = (0.0, 0.0);
        let skip = (skip_s * RATE) as usize / FRAME;
        for frame in skip..out.len() / FRAME {
            let range = frame * FRAME..(frame + 1) * FRAME;
            let level = (energy(&far[range.clone()]) / FRAME as f64).sqrt();
            if 20.0 * level.max(1e-12).log10() < -45.0 {
                continue;
            }
            before += energy(&mic[range.clone()]);
            after += energy(&out[range]);
        }
        10.0 * (before / after.max(1e-12)).log10()
    }

    #[test]
    fn cancels_the_echo_by_15_db_after_3_seconds() {
        let far = far_end(6.0);
        let mic = mic_with_echo(&far, 60.0, 6.0);
        let mut aec = Aec::new(true);
        assert!(aec.is_active());
        let out = run(&mut aec, &mic, &far);
        let erle = erle_db(&mic, &out, &far, 3.0);
        assert!(erle >= 15.0, "ERLE {erle:.1} dB");
    }

    #[test]
    fn bypass_leaves_the_frame_alone() {
        let far = far_end(1.0);
        let mic = mic_with_echo(&far, 60.0, 6.0);
        let mut aec = Aec::new(false);
        assert!(!aec.is_active());
        assert_eq!(run(&mut aec, &mic, &far), mic[..mic.len() / FRAME * FRAME]);
        assert!(!Aec::for_recording(false).is_active());
    }

    #[test]
    fn env_turns_it_off() {
        // The variable itself is not set here: tests run in parallel.
        assert!(!allows(Some("off")));
        assert!(!allows(Some(" OFF ")));
        assert!(allows(Some("on")));
        assert!(allows(None));
        assert_eq!(Aec::for_recording(true).is_active(), allowed_by_env());
    }
}
