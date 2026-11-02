//! audio-spike: prototype CLI for the audio tech risks (see docs/spikes/audio.md).

mod aec;
mod dsp;
#[cfg(target_os = "macos")]
mod mac;
#[cfg(windows)]
mod win;

use anyhow::{Context, Result, bail};

/// Minimal `--key value` / `--flag` parser.
pub struct Args(Vec<String>);

impl Args {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.iter().position(|a| a == key).and_then(|i| self.0.get(i + 1)).map(String::as_str)
    }
    pub fn flag(&self, key: &str) -> bool {
        self.0.iter().any(|a| a == key)
    }
    pub fn f64(&self, key: &str, default: f64) -> Result<f64> {
        self.get(key).map_or(Ok(default), |v| v.parse().with_context(|| format!("{key}: bad number")))
    }
    pub fn str(&self, key: &str, default: &str) -> String {
        self.get(key).unwrap_or(default).to_string()
    }
}

const USAGE: &str = "\
usage: audio-spike <command> [options]

cross-platform:
  aec-offline --mic MIC.wav --ref REF.wav --out OUT.wav [--delay-ms N]   WebRTC AEC3 (sonora, pure Rust)
  aec-sim [--far data/far.wav] [--near data/near.wav] [--delay-ms 60] [--erl-db 6] [--drift-ppm 0] [--nonlinear]
  level FILE.wav [--win 0.5]                                              RMS track in dBFS

macOS:
  devices
  mic-watch [--secs 20] [--poll-ms 10] [--spawn CMD] [--spawn-at 2] [--kill-after S] [--self-capture S]
  tap-record [--secs 5] [--out runs/tap.wav] [--include-self] [--self-tone HZ] [--spawn CMD]
  mic-record [--mode raw|vpio|vpio-bypass] [--mic NAME] [--secs 5] [--out runs/mic.wav]
  play [--device NAME] (--file F.wav | --synth SECS) [--gain 0.5]
  echo-test [--mic NAME] [--spk NAME] [--far F.wav] [--out-dir runs/echo] [--own-output] [--ducking LEVEL] [--advanced-ducking]
  tap-vpio-test [--secs 12] [--out-dir runs/tapvpio]

Windows:
  win-loopback [--secs 5] [--out runs/loopback.wav] [--legacy] [--spawn CMD]
  win-mic-sessions [--secs 0] [--poll-ms 200] [--registry]
";

fn main() -> Result<()> {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = argv.first().cloned() else {
        print!("{USAGE}");
        return Ok(());
    };
    let a = Args(argv[1..].to_vec());
    match cmd.as_str() {
        "aec-offline" => aec::run(&a),
        "aec-sim" => aec::sim(&a),
        "level" => {
            let path = argv.get(1).context("level FILE.wav")?;
            let (x, rate) = dsp::read_wav(path)?;
            let win = a.f64("--win", 0.5)?;
            println!("{path}: {:.2} s @ {rate} Hz, rms {:.1} dBFS, peak {:.3}", x.len() as f64 / rate, dsp::dbfs(dsp::rms(&x)), dsp::peak(&x));
            for (i, l) in dsp::level_track(&x, rate, win).iter().enumerate() {
                println!("  {:>6.2}s {:>7.1} dBFS", i as f64 * win, l);
            }
            Ok(())
        }
        #[cfg(target_os = "macos")]
        "devices" | "mic-watch" | "tap-record" | "mic-record" | "play" | "echo-test" | "tap-vpio-test" => mac::echo::dispatch(&cmd, &a),
        #[cfg(windows)]
        "win-loopback" => win::loopback::run(&a),
        #[cfg(windows)]
        "win-mic-sessions" => win::mic_sessions::run(&a),
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        other => bail!("unknown or unsupported-on-this-OS command '{other}'\n{USAGE}"),
    }
}
