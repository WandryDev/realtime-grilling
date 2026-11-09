//! Audio of any format into the pipeline's 16 kHz mono samples, one track
//! per channel (question-quality design.md, decision 2a). The app never
//! decodes foreign audio: `ffmpeg` is needed on the developer's machine
//! only, so it sits behind [`Decoder`] and the tests decode WAV fixtures.

use std::{
    io::Read as _,
    path::Path,
    process::{Command, Stdio},
};

use crate::vad::SAMPLE_RATE;

/// Which channel of a file to take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    /// All channels mixed down to one.
    Mix,
    /// One channel, 0 = left.
    Channel(u8),
}

/// Decodes audio files to 16 kHz mono f32 samples in [-1, 1].
pub trait Decoder {
    /// How many channels the file's first audio stream has.
    fn channels(&self, path: &Path) -> Result<u16, String>;
    fn decode(&self, path: &Path, pick: Pick) -> Result<Vec<f32>, String>;
}

/// The `ffmpeg` and `ffprobe` command-line tools.
pub struct Ffmpeg;

const MISSING: &str = "Нужен ffmpeg (с ffprobe) в PATH: brew install ffmpeg. \
                       Он нужен только для импорта, приложению не нужен";

fn run(command: &mut Command, what: &str, path: &Path) -> Result<Vec<u8>, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => MISSING.to_owned(),
            _ => format!("Не удалось запустить {what}: {error}"),
        })?;
    let mut stdout = Vec::new();
    // stderr is short (`-v error`): read after stdout without a deadlock.
    if let Some(mut out) = child.stdout.take() {
        out.read_to_end(&mut stdout)
            .map_err(|error| format!("{what} {}: {error}", path.display()))?;
    }
    let mut stderr = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut stderr);
    }
    let status = child
        .wait()
        .map_err(|error| format!("{what} {}: {error}", path.display()))?;
    if status.success() {
        Ok(stdout)
    } else {
        Err(format!(
            "{what} не прочитал {}: {}",
            path.display(),
            stderr.trim()
        ))
    }
}

impl Decoder for Ffmpeg {
    fn channels(&self, path: &Path) -> Result<u16, String> {
        let out = run(
            Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=channels",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                ])
                .arg(path),
            "ffprobe",
            path,
        )?;
        let text = String::from_utf8_lossy(&out);
        text.trim()
            .parse()
            .map_err(|_| format!("В {} нет аудиодорожки", path.display()))
    }

    fn decode(&self, path: &Path, pick: Pick) -> Result<Vec<f32>, String> {
        let filter = match pick {
            Pick::Mix => None,
            Pick::Channel(index) => Some(format!("pan=mono|c0=c{index}")),
        };
        let mut command = Command::new("ffmpeg");
        command
            .args(["-nostdin", "-v", "error", "-i"])
            .arg(path)
            .args(["-map", "0:a:0"]);
        if let Some(filter) = &filter {
            command.args(["-af", filter]);
        }
        command.args([
            "-ac",
            "1",
            "-ar",
            &SAMPLE_RATE.to_string(),
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-",
        ]);
        let bytes = run(&mut command, "ffmpeg", path)?;
        Ok(bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| f32::from(i16::from_le_bytes(*pair)) / 32_768.0)
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs ffmpeg, which CI has not: run by hand with `--ignored`.
    #[test]
    #[ignore = "needs ffmpeg in PATH"]
    fn ffmpeg_splits_a_stereo_file() {
        let dir = tempfile::tempdir().unwrap();
        let stereo = dir.path().join("stereo.wav");
        let fixture = crate::vad::detector::test_audio::fixture("two-phrases.wav");
        let status = Command::new("ffmpeg")
            .args(["-v", "error", "-i"])
            .arg(&fixture)
            .args(["-af", "pan=stereo|c0=c0|c1=0*c0", "-ar", "44100"])
            .arg(&stereo)
            .status()
            .unwrap();
        assert!(status.success());

        assert_eq!(Ffmpeg.channels(&stereo).unwrap(), 2);
        let left = Ffmpeg.decode(&stereo, Pick::Channel(0)).unwrap();
        let right = Ffmpeg.decode(&stereo, Pick::Channel(1)).unwrap();
        let expected = crate::vad::detector::test_audio::read_wav(&fixture).len();
        assert!(left.len().abs_diff(expected) < 200, "{}", left.len());
        assert!(left.iter().any(|sample| sample.abs() > 0.05));
        assert!(right.iter().all(|sample| sample.abs() < 0.001));
    }
}
