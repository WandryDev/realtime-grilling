//! Item 4 (cross-platform option): offline WebRTC AEC3 via `sonora` (pure-Rust port of
//! webrtc-audio-processing). Mic = near-end capture (with echo), ref = far-end (system channel).

use anyhow::{Context, Result};
use sonora::config::{EchoCanceller, HighPassFilter, NoiseSuppression};
use sonora::{AudioProcessing, Config, StreamConfig};

use crate::{Args, dsp};

pub const RATE: f64 = 16_000.0;
const FRAME: usize = 160; // 10 ms @ 16 kHz

pub struct AecReport {
    pub out: Vec<f32>,
    pub erle_db: f64,
    pub in_db: f64,
    pub out_db: f64,
    pub frames_used: usize,
    pub delay_ms: Option<i32>,
    pub stats_erle: Option<f64>,
    pub elapsed_ms: f64,
}

/// mic and reference must be mono 16 kHz. `ns` enables noise suppression as well (off = pure AEC).
/// `hpf = false` disables both high-pass filters (only so that waveform SNR vs the clean
/// near-end is meaningful in the simulation; the HPF phase shift alone costs ~5 dB of "SNR").
pub fn process(mic: &[f32], reference: &[f32], delay_ms: i32, ns: bool, hpf: bool) -> AecReport {
    let config = Config {
        echo_canceller: Some(EchoCanceller { enforce_high_pass_filtering: hpf, ..Default::default() }),
        noise_suppression: ns.then(NoiseSuppression::default),
        high_pass_filter: hpf.then(HighPassFilter::default),
        ..Default::default()
    };
    let sc = StreamConfig::new(RATE as u32, 1);
    let mut apm = AudioProcessing::builder().config(config).capture_config(sc).render_config(sc).build();
    let n = mic.len() / FRAME;
    let mut out = vec![0.0f32; n * FRAME];
    let mut rbuf = vec![0.0f32; FRAME];
    let t = std::time::Instant::now();
    for i in 0..n {
        let r = i * FRAME;
        let refr: Vec<f32> = (0..FRAME).map(|k| reference.get(r + k).copied().unwrap_or(0.0)).collect();
        apm.process_render_f32(&[&refr], &mut [&mut rbuf]).ok();
        let _ = apm.set_stream_delay_ms(delay_ms);
        let (_, o) = out.split_at_mut(r);
        apm.process_capture_f32(&[&mic[r..r + FRAME]], &mut [&mut o[..FRAME]]).ok();
    }
    let elapsed_ms = t.elapsed().as_secs_f64() * 1e3;
    let stats = apm.statistics().clone();
    // ERLE on frames where the far end is active, skipping the first 2 s of convergence.
    let skip = (2.0 * RATE) as usize / FRAME;
    let (mut ein, mut eout, mut used) = (0.0f64, 0.0f64, 0usize);
    for i in skip..n {
        let r = i * FRAME;
        let refr = &reference[r.min(reference.len())..(r + FRAME).min(reference.len())];
        if dsp::dbfs(dsp::rms(refr)) < -45.0 {
            continue;
        }
        ein += mic[r..r + FRAME].iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
        eout += out[r..r + FRAME].iter().map(|v| (*v as f64).powi(2)).sum::<f64>();
        used += 1;
    }
    let norm = (used * FRAME).max(1) as f64;
    AecReport {
        erle_db: 10.0 * (ein.max(1e-12) / eout.max(1e-12)).log10(),
        in_db: 10.0 * (ein / norm).max(1e-12).log10(),
        out_db: 10.0 * (eout / norm).max(1e-12).log10(),
        frames_used: used,
        delay_ms: stats.delay_median_ms,
        stats_erle: stats.echo_return_loss_enhancement,
        out,
        elapsed_ms,
    }
}

pub fn load_16k(path: &str) -> Result<Vec<f32>> {
    let (x, rate) = dsp::read_wav(path).with_context(|| format!("read {path}"))?;
    Ok(dsp::resample(&x, rate, RATE))
}

pub fn run(a: &Args) -> Result<()> {
    let mic = load_16k(a.get("--mic").context("--mic")?)?;
    let mut reference = load_16k(a.get("--ref").context("--ref")?)?;
    let out = a.str("--out", "runs/aec3.wav");
    if a.flag("--align") {
        // Coarse alignment: shift reference so that it leads the mic by ~`margin` ms.
        let (lag, _) = dsp::best_lag(&reference, &mic, (RATE * 1.0) as usize);
        let margin = (0.02 * RATE) as usize;
        let shift = lag.saturating_sub(margin);
        println!("xcorr lag ref->mic: {:.1} ms; delaying reference by {:.1} ms", lag as f64 / RATE * 1e3, shift as f64 / RATE * 1e3);
        let mut r = vec![0.0; shift];
        r.extend_from_slice(&reference);
        reference = r;
    }
    let delay = a.f64("--delay-ms", 0.0)? as i32;
    let rep = process(&mic, &reference, delay, a.flag("--ns"), true);
    dsp::write_wav(&out, &rep.out, RATE as u32)?;
    println!(
        "AEC3 (sonora): {} far-end-active frames; mic {:.1} dBFS -> out {:.1} dBFS; ERLE {:.1} dB; \
         stats: delay_median={:?} ms, erle={:?}; processed {:.1} s of audio in {:.0} ms; wrote {out}",
        rep.frames_used,
        rep.in_db,
        rep.out_db,
        rep.erle_db,
        rep.delay_ms,
        rep.stats_erle,
        mic.len() as f64 / RATE,
        rep.elapsed_ms
    );
    Ok(())
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>()
}

/// Simulated "laptop without headphones": mic = near + room(far) + noise. Measures AEC3 ERLE on
/// far-only speech and how much of the near-end (manager) speech survives, incl. double talk.
pub fn sim(a: &Args) -> Result<()> {
    let far = load_16k(&a.str("--far", "data/far.wav"))?;
    let near_src = load_16k(&a.str("--near", "data/near.wav"))?;
    let delay_ms = a.f64("--delay-ms", 60.0)?;
    let erl_db = a.f64("--erl-db", 6.0)?; // echo this many dB below the far-end reference
    let drift_ppm = a.f64("--drift-ppm", 0.0)?;
    let nonlinear = a.flag("--nonlinear");
    let near_at = (a.f64("--near-at", 16.0)? * RATE) as usize;
    let total = (far.len()).max(near_at + near_src.len()) + RATE as usize;

    // Echo path: pure delay + exponentially decaying random reflections (RT60 ~ 250 ms).
    let d = (delay_ms / 1e3 * RATE) as usize;
    let tail = (0.25 * RATE) as usize;
    let mut seed = 0x2545_f491u32;
    let mut rnd = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed as f64 / u32::MAX as f64) * 2.0 - 1.0
    };
    let mut h = vec![0.0f64; d + tail];
    h[d] = 1.0;
    for (k, tap) in h.iter_mut().enumerate().skip(d + 1) {
        let t = (k - d) as f64 / RATE;
        *tap = 0.3 * rnd() * (-6.9 * t / 0.25).exp();
    }
    let hn = h.iter().map(|v| v * v).sum::<f64>().sqrt();
    let g = 10f64.powf(-erl_db / 20.0) / hn;
    let mut far_spk: Vec<f32> = far.clone();
    if nonlinear {
        far_spk.iter_mut().for_each(|v| *v = (2.0 * *v).tanh() / 2.0f32.tanh());
    }
    if drift_ppm != 0.0 {
        far_spk = dsp::resample(&far_spk, RATE, RATE * (1.0 + drift_ppm * 1e-6));
    }
    let mut echo = vec![0.0f32; total];
    for (n, e) in echo.iter_mut().enumerate() {
        let mut acc = 0.0f64;
        for (k, hk) in h.iter().enumerate() {
            if *hk == 0.0 || k > n {
                continue;
            }
            if let Some(x) = far_spk.get(n - k) {
                acc += *x as f64 * hk;
            }
        }
        *e = (acc * g) as f32;
    }
    let mut near = vec![0.0f32; total];
    near[near_at..near_at + near_src.len()].copy_from_slice(&near_src);
    let mic: Vec<f32> = (0..total).map(|i| near[i] + echo[i] + 0.002 * rnd() as f32).collect();
    let mut reference = far.clone();
    reference.resize(total, 0.0);

    let rep = process(&mic, &reference, 0, false, a.flag("--hpf"));
    let out = &rep.out;
    let n = out.len();
    let seg = |from: f64, to: f64| ((from * RATE) as usize).min(n)..((to * RATE) as usize).min(n);
    let far_end_s = far.len() as f64 / RATE;
    let near_s = near_at as f64 / RATE;
    let near_e = (near_at + near_src.len()) as f64 / RATE;
    // ERLE on far-only speech after 2 s of convergence.
    let fo = seg(2.0, near_s.min(far_end_s));
    let erle = 10.0 * (energy(&mic[fo.clone()]) / energy(&out[fo.clone()]).max(1e-12)).log10();
    // Near-end preservation: SNR of output vs clean near (higher = better), raw mic for reference.
    // Lag-aligned (0..20 ms), gain-optimal SNR of y against the clean near-end in range r.
    // Robust to the small delay/gain of the APM filters; still penalises HPF phase at low freqs.
    let snr = |r: std::ops::Range<usize>, y: &[f32]| {
        let mut best = f64::MIN;
        for lag in 0..=320usize {
            let pairs = r.clone().filter(|i| i + lag < y.len()).map(|i| (near[i] as f64, y[i + lag] as f64));
            let (xy, xx, yy) = pairs.fold((0.0, 0.0, 0.0), |(a, b, c), (x, y)| (a + x * y, b + x * x, c + y * y));
            if xx <= 0.0 {
                continue;
            }
            let g = xy / xx;
            let sig = g * g * xx;
            let err = (yy - 2.0 * g * xy + g * g * xx).max(1e-12);
            best = best.max(10.0 * (sig / err).log10());
        }
        best
    };
    let dt = seg(near_s, far_end_s.min(near_e));
    let no = seg(far_end_s.max(near_s), near_e);
    println!(
        "sim: echo delay {delay_ms} ms, ERL {erl_db} dB, drift {drift_ppm} ppm, nonlinear {nonlinear}\n  \
         far-only ERLE: {erle:.1} dB (AEC3 stats ERLE {:?}, delay est {:?} ms)\n  \
         double-talk ({:.1}-{:.1} s) near-end SNR: raw mic {:.1} dB -> AEC3 {:.1} dB\n  \
         near-only ({:.1}-{:.1} s) near-end SNR: raw mic {:.1} dB -> AEC3 {:.1} dB\n  \
         speed: {:.1} s audio in {:.0} ms ({:.0}x realtime)",
        rep.stats_erle,
        rep.delay_ms,
        near_s,
        far_end_s.min(near_e),
        snr(dt.clone(), &mic),
        snr(dt, out),
        far_end_s.max(near_s),
        near_e,
        snr(no.clone(), &mic),
        snr(no, out),
        n as f64 / RATE,
        rep.elapsed_ms,
        n as f64 / RATE * 1e3 / rep.elapsed_ms
    );
    let dir = a.str("--out-dir", "runs/aec-sim");
    dsp::write_wav(&format!("{dir}/mic.wav"), &mic, RATE as u32)?;
    dsp::write_wav(&format!("{dir}/aec3.wav"), out, RATE as u32)?;
    dsp::write_wav(&format!("{dir}/ref.wav"), &reference, RATE as u32)?;
    Ok(())
}
