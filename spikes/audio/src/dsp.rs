//! Small DSP helpers: downmix, resample, levels, WAV IO, alignment.

use anyhow::Result;

pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|f| f.iter().sum::<f32>() / channels as f32)
        .collect()
}

/// Windowed-sinc resampler (offline, O(n*taps)). Good enough for 48k -> 16k speech.
pub fn resample(x: &[f32], from: f64, to: f64) -> Vec<f32> {
    if (from - to).abs() < 0.5 {
        return x.to_vec();
    }
    let ratio = to / from;
    let cutoff = ratio.min(1.0) * 0.95;
    let half = (16.0 / cutoff).ceil() as isize;
    let n_out = (x.len() as f64 * ratio).floor() as usize;
    let mut y = Vec::with_capacity(n_out);
    for n in 0..n_out {
        let t = n as f64 / ratio;
        let c = t.floor() as isize;
        let mut acc = 0.0f64;
        for k in (c - half + 1)..=(c + half) {
            if k < 0 || k as usize >= x.len() {
                continue;
            }
            let d = t - k as f64;
            let arg = std::f64::consts::PI * d * cutoff;
            let sinc = if arg.abs() < 1e-9 { 1.0 } else { arg.sin() / arg };
            let w = 0.5 + 0.5 * (std::f64::consts::PI * d / (half as f64 + 1.0)).cos(); // Hann
            acc += x[k as usize] as f64 * sinc * cutoff * w;
        }
        y.push(acc as f32);
    }
    y
}

pub fn rms(x: &[f32]) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt()
}

pub fn dbfs(r: f64) -> f64 {
    20.0 * r.max(1e-10).log10()
}

pub fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

/// Per-window RMS in dBFS.
pub fn level_track(x: &[f32], rate: f64, win_s: f64) -> Vec<f64> {
    let w = (rate * win_s) as usize;
    x.chunks(w.max(1)).map(|c| dbfs(rms(c))).collect()
}

/// Goertzel power of `freq` normalised by total power (0..1): share of energy at that tone.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn tone_share(x: &[f32], rate: f64, freq: f64) -> f64 {
    if x.is_empty() {
        return 0.0;
    }
    let w = 2.0 * std::f64::consts::PI * freq / rate;
    let coeff = 2.0 * w.cos();
    let (mut s1, mut s2) = (0.0f64, 0.0f64);
    for v in x {
        let s = *v as f64 + coeff * s1 - s2;
        s2 = s1;
        s1 = s;
    }
    let p = s1 * s1 + s2 * s2 - coeff * s1 * s2;
    let total: f64 = x.iter().map(|v| (*v as f64).powi(2)).sum();
    if total <= 0.0 {
        return 0.0;
    }
    // A pure sine of amplitude A over N samples gives p ~= (A*N/2)^2 and total ~= A^2*N/2.
    (2.0 * p / (x.len() as f64 * total)).min(1.0)
}

pub fn write_wav(path: &str, x: &[f32], rate: u32) -> Result<()> {
    if let Some(dir) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let spec = hound::WavSpec { channels: 1, sample_rate: rate, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(path, spec)?;
    for v in x {
        w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16)?;
    }
    w.finalize()?;
    Ok(())
}

/// Reads any PCM WAV as mono f32.
pub fn read_wav(path: &str) -> Result<(Vec<f32>, f64)> {
    let mut r = hound::WavReader::open(path)?;
    let spec = r.spec();
    let ch = spec.channels as usize;
    let data: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => r.samples::<f32>().collect::<std::result::Result<_, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample - 1)) as f32;
            r.samples::<i32>().map(|s| s.map(|v| v as f32 / scale)).collect::<std::result::Result<_, _>>()?
        }
    };
    Ok((to_mono(&data, ch), spec.sample_rate as f64))
}

/// Lag (in samples) of `y` relative to `x` maximising cross-correlation, searched in [0, max_lag].
/// Positive lag = `y` is delayed vs `x`. Coarse-to-fine on a decimated envelope would be faster;
/// brute force is fine for a few seconds at 16 kHz.
pub fn best_lag(x: &[f32], y: &[f32], max_lag: usize) -> (usize, f64) {
    let n = x.len().min(y.len());
    let mut best = (0usize, f64::MIN);
    for lag in (0..=max_lag).step_by(4) {
        if lag >= n {
            break;
        }
        let mut acc = 0.0f64;
        for i in (0..n - lag).step_by(2) {
            acc += x[i] as f64 * y[i + lag] as f64;
        }
        if acc > best.1 {
            best = (lag, acc);
        }
    }
    let (coarse, _) = best;
    for lag in coarse.saturating_sub(4)..=(coarse + 4).min(max_lag) {
        if lag >= n {
            break;
        }
        let acc: f64 = (0..n - lag).map(|i| x[i] as f64 * y[i + lag] as f64).sum();
        if acc > best.1 {
            best = (lag, acc);
        }
    }
    best
}

/// Speech-like test signal without TTS: amplitude-modulated harmonic "vowels" with pauses.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn synth_farend(rate: f64, secs: f64) -> Vec<f32> {
    let n = (rate * secs) as usize;
    let mut seed = 0x1234_5678u32;
    let mut noise = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed as f32 / u32::MAX as f32) * 2.0 - 1.0
    };
    (0..n)
        .map(|i| {
            let t = i as f64 / rate;
            let syll = (t * 4.0) % 1.0; // 4 syllables/s
            let phrase_on = (t % 2.5) < 1.8; // pause 0.7 s every 2.5 s
            if !phrase_on {
                return 0.0;
            }
            let env = (std::f64::consts::PI * syll).sin().powi(2);
            let f0 = 140.0 + 30.0 * (t * 1.3).sin();
            let mut v = 0.0;
            for h in 1..=12 {
                let formant = 1.0 / (1.0 + ((h as f64 * f0 - 700.0) / 400.0).powi(2));
                v += formant * (2.0 * std::f64::consts::PI * h as f64 * f0 * t).sin();
            }
            ((0.25 * env * v) as f32) + 0.01 * noise() * env as f32
        })
        .collect()
}
