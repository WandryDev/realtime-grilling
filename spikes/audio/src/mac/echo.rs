//! macOS command dispatch + item 4 experiments (VPIO vs raw mic, VPIO vs process tap).

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};

use super::au::{self, Capture, DuckingConfig, Mode};
use super::{hal, mic_watch, tap};
use crate::{Args, aec, dsp};

pub fn dispatch(cmd: &str, a: &Args) -> Result<()> {
    match cmd {
        "devices" => hal::list_devices(),
        "mic-watch" => mic_watch::run(mic_watch::Opts {
            secs: a.f64("--secs", 20.0)?,
            poll_ms: a.f64("--poll-ms", 0.0)? as u64,
            spawn: a.get("--spawn").map(String::from),
            spawn_at: a.f64("--spawn-at", 2.0)?,
            kill_after: a.get("--kill-after").map(str::parse).transpose()?,
            self_capture: a.get("--self-capture").map(str::parse).transpose()?,
            device: a.get("--device").map(String::from),
        }),
        "tap-record" => tap_record(a),
        "mic-record" => mic_record(a),
        "play" => play(a),
        "echo-test" => echo_test(a),
        "tap-vpio-test" => tap_vpio_test(a),
        _ => bail!("unknown mac command {cmd}"),
    }
}

fn spawn_sh(cmd: &str) -> Result<Child> {
    Ok(Command::new("/bin/sh").arg("-c").arg(format!("exec {cmd}")).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?)
}

fn self_exe() -> String {
    std::env::current_exe().unwrap().to_string_lossy().into_owned()
}

fn report_levels(label: &str, x: &[f32], rate: f64) {
    let track: Vec<String> = dsp::level_track(x, rate, 1.0).iter().map(|v| format!("{v:.0}")).collect();
    println!(
        "{label}: {:.2} s, rms {:.1} dBFS, peak {:.3}; per-second dBFS: [{}]",
        x.len() as f64 / rate,
        dsp::dbfs(dsp::rms(x)),
        dsp::peak(x),
        track.join(", ")
    );
}

fn tap_record(a: &Args) -> Result<()> {
    let secs = a.f64("--secs", 5.0)?;
    let out = a.str("--out", "runs/tap.wav");
    let tone = a.get("--self-tone").map(str::parse::<f64>).transpose()?;
    // Our own output must exist *before* the tap so our process object can be excluded.
    let tone_thread = tone.map(|hz| {
        let n = (48_000.0 * (secs + 2.0)) as usize;
        let sig: Vec<f32> = (0..n).map(|i| 0.2 * (2.0 * std::f32::consts::PI * hz as f32 * i as f32 / 48_000.0).sin()).collect();
        std::thread::spawn(move || au::play_blocking(sig, 48_000.0, None))
    });
    if tone.is_some() {
        std::thread::sleep(Duration::from_millis(400));
    }
    let spawn = a.get("--spawn").map(String::from);
    let mut child: Option<Child> = None;
    let child_ref = std::sync::Arc::new(std::sync::Mutex::new(None::<Child>));
    let cr = child_ref.clone();
    let res = tap::record(tap::TapOpts {
        secs,
        exclude_self: !a.flag("--include-self"),
        main_device: a.get("--main-device").map(String::from),
        on_running: spawn.map(|c| {
            Box::new(move || {
                *cr.lock().unwrap() = spawn_sh(&c).ok();
            }) as Box<dyn FnOnce() + Send>
        }),
    })?;
    if let Some(c) = child_ref.lock().unwrap().take() {
        child = Some(c);
    }
    if let Some(mut c) = child {
        c.kill().ok();
        c.wait().ok();
    }
    if let Some(t) = tone_thread {
        t.join().ok();
    }
    let mono = dsp::to_mono(&res.samples, res.channels as usize);
    report_levels(&format!("tap ({} Hz, {} ch)", res.rate, res.channels), &mono, res.rate);
    if let Some(hz) = tone {
        println!("share of energy at own tone {hz} Hz: {:.4} (≈0 => own process excluded, ≈1 => included)", dsp::tone_share(&mono, res.rate, hz));
    }
    let y = dsp::resample(&mono, res.rate, 16_000.0);
    dsp::write_wav(&out, &y, 16_000)?;
    println!("wrote {out} (16 kHz mono)");
    Ok(())
}

fn mic_record(a: &Args) -> Result<()> {
    let mode = match a.str("--mode", "raw").as_str() {
        "raw" => Mode::Raw,
        "vpio" => Mode::Vpio,
        "vpio-bypass" => Mode::VpioBypass,
        "vpio-input-only" => Mode::VpioInputOnly,
        m => bail!("bad mode {m}"),
    };
    let mic = a.get("--mic").map(|n| hal::find_device(n, hal::SCOPE_INPUT)).transpose()?;
    let secs = a.f64("--secs", 5.0)?;
    let out = a.str("--out", "runs/mic.wav");
    let t = Instant::now();
    let cap = Capture::start(mode, mic, None)?;
    println!("{mode:?} capture started in {:.1} ms at {} Hz", t.elapsed().as_secs_f64() * 1e3, cap.rate);
    std::thread::sleep(Duration::from_secs_f64(secs));
    let err = cap.render_error();
    let rate = cap.rate;
    let x = cap.stop();
    if err != 0 {
        println!("AudioUnitRender error: {err}");
    }
    report_levels(&format!("mic {mode:?}"), &x, rate);
    if !x.is_empty() && dsp::peak(&x) == 0.0 {
        println!("ALL ZEROS: input is running but delivers digital silence -> microphone TCC permission likely denied");
    }
    dsp::write_wav(&out, &dsp::resample(&x, rate, 16_000.0), 16_000)?;
    println!("wrote {out}");
    Ok(())
}

fn far_signal(a: &Args, rate: f64) -> Result<Vec<f32>> {
    if let Some(hz) = a.get("--tone") {
        let hz: f32 = hz.parse()?;
        let secs = a.f64("--secs", 10.0)?;
        return Ok((0..(rate * secs) as usize).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin()).collect());
    }
    Ok(match (a.get("--file").or(a.get("--far")), a.get("--synth")) {
        (Some(f), _) => {
            let (x, r) = dsp::read_wav(f)?;
            dsp::resample(&x, r, rate)
        }
        (None, Some(s)) => dsp::synth_farend(rate, s.parse()?),
        _ => dsp::synth_farend(rate, 10.0),
    })
}

fn play(a: &Args) -> Result<()> {
    let dev = a.get("--device").map(|n| hal::find_device(n, hal::SCOPE_OUTPUT)).transpose()?;
    let gain = a.f64("--gain", 0.5)? as f32;
    let mut x = far_signal(a, 48_000.0)?;
    x.iter_mut().for_each(|v| *v *= gain);
    au::play_blocking(x, 48_000.0, dev)
}

/// Echo experiment. Timeline (one process, raw mic captured the whole time):
///   phase A [0, P)        far-end playing, raw only
///   phase B [P, 2P)       far-end playing, raw + VPIO simultaneously (same mic)
///   phase C [2P, 3P)      far-end playing, raw only again (ducking released?)
///   phase D [3P, 3P+2)    far-end stopped: noise floor
/// Far-end is played by a *separate process* (like Zoom) on the speaker, unless --own-output,
/// in which case it is rendered through the VPIO unit's own output bus during phase B.
fn echo_test(a: &Args) -> Result<()> {
    let mic_name = a.str("--mic", "MacBook");
    let spk_name = a.str("--spk", "MacBook");
    let mic = hal::find_device(&mic_name, hal::SCOPE_INPUT)?;
    let spk = hal::find_device(&spk_name, hal::SCOPE_OUTPUT)?;
    let out_dir = a.str("--out-dir", "runs/echo");
    std::fs::create_dir_all(&out_dir)?;
    let phase = a.f64("--phase", 6.0)?;
    let own_output = a.flag("--own-output");
    let gain = a.f64("--gain", 0.5)?;
    let vol: f32 = hal::get(spk, hal::DEV_VOLUME_SCALAR, hal::SCOPE_OUTPUT).unwrap_or(-1.0);
    let mute: u32 = hal::get(spk, hal::DEV_MUTE, hal::SCOPE_OUTPUT).unwrap_or(0);
    println!(
        "mic: {} | speaker: {} (volume scalar {vol:.2}, mute {mute}) | far-end via {}",
        hal::device_name(mic),
        hal::device_name(spk),
        if own_output { "VPIO own output bus" } else { "separate process" }
    );
    let far_path = format!("{out_dir}/far.wav");
    let mut far = far_signal(a, 48_000.0)?;
    // loop the far-end to cover phases A..C
    let need = (48_000.0 * phase * 3.0) as usize;
    while far.len() < need {
        far.extend_from_within(..far.len().min(need - far.len()));
    }
    far.truncate(need);
    far.iter_mut().for_each(|v| *v *= gain as f32);
    dsp::write_wav(&far_path, &far, 48_000)?;

    let ducking = a.get("--ducking").map(|l| -> Result<DuckingConfig> {
        Ok(DuckingConfig { enable_advanced: a.flag("--advanced-ducking") as u8, level: l.parse()? })
    }).transpose()?;

    // System channel via process tap, recorded concurrently: the realistic AEC reference.
    let tap_secs = 3.0 * phase + 1.0;
    let spk_for_tap = spk_name.clone();
    let tap_thread = std::thread::spawn(move || {
        tap::record(tap::TapOpts { secs: tap_secs, exclude_self: true, on_running: None, main_device: Some(spk_for_tap) })
    });
    std::thread::sleep(Duration::from_millis(200));
    let raw = Capture::start(Mode::Raw, Some(mic), None)?;
    let raw_rate = raw.rate;
    let t0 = Instant::now();
    let mut player = if own_output {
        None
    } else {
        Some(Command::new(self_exe()).args(["play", "--device", &spk_name, "--file", &far_path, "--gain", "1.0"]).spawn()?)
    };
    let wait_until = |t: f64| {
        while t0.elapsed().as_secs_f64() < t {
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    wait_until(phase);
    let raw_a_len = raw.take();
    let own_play = if own_output { dsp::resample(&far, 48_000.0, 48_000.0) } else { Vec::new() };
    let vp = Capture::start_ex(Mode::Vpio, Some(mic), Some(spk), own_play, ducking).context("VPIO start")?;
    wait_until(2.0 * phase);
    let vpio_rate = vp.rate;
    let vpio_err = vp.render_error();
    let vpio = vp.stop();
    let raw_b = raw.take();
    wait_until(3.0 * phase);
    let raw_c = raw.take();
    if let Some(p) = player.as_mut() {
        p.kill().ok();
        p.wait().ok();
    }
    wait_until(3.0 * phase + 2.0);
    let raw_d = raw.take();
    drop(raw);
    if vpio_err != 0 {
        println!("VPIO AudioUnitRender error {vpio_err}");
    }

    let mut all = raw_a_len.clone();
    for p in [&raw_b, &raw_c, &raw_d] {
        all.extend_from_slice(p);
    }
    let raw16 = dsp::resample(&all, raw_rate, 16_000.0);
    let vpio16 = dsp::resample(&vpio, vpio_rate, 16_000.0);
    dsp::write_wav(&format!("{out_dir}/raw.wav"), &raw16, 16_000)?;
    dsp::write_wav(&format!("{out_dir}/vpio.wav"), &vpio16, 16_000)?;
    dsp::write_wav(&format!("{out_dir}/raw_phaseB.wav"), &dsp::resample(&raw_b, raw_rate, 16_000.0), 16_000)?;

    // Skip the first second of each phase (VPIO convergence / transitions).
    let tail = |x: &[f32], r: f64| -> f64 { dsp::dbfs(dsp::rms(&x[(r as usize).min(x.len())..])) };
    let (a_db, b_db, c_db, d_db) = (tail(&raw_a_len, raw_rate), tail(&raw_b, raw_rate), tail(&raw_c, raw_rate), dsp::dbfs(dsp::rms(&raw_d)));
    let v_db = tail(&vpio, vpio_rate);
    report_levels("raw (whole run)", &all, raw_rate);
    report_levels("vpio (phase B)", &vpio, vpio_rate);
    println!("raw  A (far-end, no VPIO)       {a_db:>7.1} dBFS");
    println!("raw  B (far-end, VPIO running)  {b_db:>7.1} dBFS   -> change vs A {:+.1} dB (ducking of the far-end on speaker)", b_db - a_db);
    println!("raw  C (far-end, VPIO stopped)  {c_db:>7.1} dBFS");
    println!("raw  D (silence, noise floor)   {d_db:>7.1} dBFS");
    println!("vpio B (far-end)                {v_db:>7.1} dBFS   -> echo reduction vs raw B: {:.1} dB", b_db - v_db);
    if dsp::peak(&all) == 0.0 {
        println!("RAW MIC IS ALL ZEROS -> microphone permission (TCC) not granted to the responsible app");
    }

    // Offline AEC3 on the raw capture with the known far-end as reference (phases A..C).
    let far16 = dsp::resample(&far, 48_000.0, 16_000.0);
    let raw_abc = &raw16[..raw16.len().min(far16.len())];
    let (lag, _) = dsp::best_lag(&far16, raw_abc, 16_000);
    let shift = lag.saturating_sub(320);
    let mut reference = vec![0.0; shift];
    reference.extend_from_slice(&far16);
    let rep = aec::process(raw_abc, &reference, 0, false, true);
    dsp::write_wav(&format!("{out_dir}/aec3.wav"), &rep.out, 16_000)?;
    println!(
        "AEC3 (sonora) on raw A..C with far-end reference (xcorr lag {:.0} ms): {:.1} -> {:.1} dBFS, ERLE {:.1} dB, delay_median {:?} ms",
        lag as f64 / 16.0,
        rep.in_db,
        rep.out_db,
        rep.erle_db,
        rep.delay_ms
    );
    match tap_thread.join() {
        Ok(Ok(t)) => {
            let tap16 = dsp::resample(&dsp::to_mono(&t.samples, t.channels as usize), t.rate, 16_000.0);
            dsp::write_wav(&format!("{out_dir}/tap.wav"), &tap16, 16_000)?;
            let (lag, _) = dsp::best_lag(&tap16, raw_abc, 16_000);
            let mut reference = vec![0.0; lag.saturating_sub(320)];
            reference.extend_from_slice(&tap16);
            let rep = aec::process(raw_abc, &reference, 0, false, true);
            dsp::write_wav(&format!("{out_dir}/aec3_tapref.wav"), &rep.out, 16_000)?;
            println!(
                "AEC3 (sonora) with the process TAP as reference (xcorr lag {:.0} ms): {:.1} -> {:.1} dBFS, ERLE {:.1} dB",
                lag as f64 / 16.0,
                rep.in_db,
                rep.out_db,
                rep.erle_db
            );
        }
        Ok(Err(e)) => println!("tap failed: {e:#}"),
        Err(_) => println!("tap thread panicked"),
    }
    println!("wrote {out_dir}/{{far,raw,raw_phaseB,vpio,aec3,tap,aec3_tapref}}.wav");
    Ok(())
}

/// Does VPIO in *our* process change what a process tap (in another process) captures?
/// A separate `play` process plays a steady signal on the default output for the whole run,
/// a separate `tap-record` process records it; we start VPIO in the middle third.
fn tap_vpio_test(a: &Args) -> Result<()> {
    let secs = a.f64("--secs", 12.0)?;
    let out_dir = a.str("--out-dir", "runs/tapvpio");
    std::fs::create_dir_all(&out_dir)?;
    let exe = self_exe();
    let tap_out = format!("{out_dir}/tap.wav");
    let out_dev = a.str("--spk", "default");
    let mut tap_args = vec!["tap-record".to_string(), "--secs".into(), format!("{secs}"), "--out".into(), tap_out.clone()];
    let mut play_args = vec!["play".to_string(), "--tone".into(), "440".into(), "--secs".into(), format!("{}", secs + 1.0), "--gain".into(), a.str("--gain", "0.3")];
    if out_dev != "default" {
        tap_args.extend(["--main-device".into(), out_dev.clone()]);
        play_args.extend(["--device".into(), out_dev.clone()]);
    }
    let mut tapper = Command::new(&exe).args(&tap_args).spawn()?;
    std::thread::sleep(Duration::from_millis(300));
    let mut player = Command::new(&exe).args(&play_args).spawn()?;
    let third = secs / 3.0;
    std::thread::sleep(Duration::from_secs_f64(third));
    println!(">>> starting VPIO in pid {} at ~{third:.1}s", std::process::id());
    let ducking = a.get("--ducking").map(|l| -> Result<DuckingConfig> {
        Ok(DuckingConfig { enable_advanced: a.flag("--advanced-ducking") as u8, level: l.parse()? })
    }).transpose()?;
    let mic = a.get("--mic").map(|n| hal::find_device(n, hal::SCOPE_INPUT)).transpose()?;
    let spk = (out_dev != "default").then(|| hal::find_device(&out_dev, hal::SCOPE_OUTPUT)).transpose()?;
    let mode = match a.str("--mode", "vpio").as_str() {
        "vpio-input-only" => Mode::VpioInputOnly,
        "vpio-bypass" => Mode::VpioBypass,
        _ => Mode::Vpio,
    };
    let vp = Capture::start_ex(mode, mic, spk, Vec::new(), ducking)?;
    std::thread::sleep(Duration::from_secs_f64(third));
    vp.stop();
    println!(">>> stopped VPIO at ~{:.1}s", 2.0 * third);
    tapper.wait()?;
    player.kill().ok();
    player.wait().ok();
    let (x, r) = dsp::read_wav(&tap_out)?;
    let n = x.len();
    let seg = |i: usize| dsp::dbfs(dsp::rms(&x[(n * i / 3 + r as usize / 2).min(n)..(n * (i + 1) / 3).min(n)]));
    println!("tap level before VPIO {:.1} dBFS | during VPIO {:.1} dBFS | after {:.1} dBFS", seg(0), seg(1), seg(2));
    println!("=> VPIO-induced change in tapped system audio: {:+.1} dB", seg(1) - seg(0));
    let track: Vec<String> = dsp::level_track(&x, r, 0.5).iter().map(|v| format!("{v:.1}")).collect();
    println!("tap level every 0.5 s (steady 440 Hz tone from another process): [{}]", track.join(", "));
    Ok(())
}
