"""Build the SYNTHETIC STT test set (macOS only: needs `say` + ffmpeg with libopus).

data/clean/<id>.wav  - TTS phrase, 16 kHz mono s16, 0.2 s padding each side
data/call/<id>.wav   - call-like: light pink noise -> 300-3400 Hz -> Opus 16 kbps -> 16 kHz WAV
data/silence/<id>.wav - 5 no-speech clips for the hallucination check
data/manifest.json   - durations + SNR

On Windows: run this on a Mac and copy data/ over (TTS voices differ per OS).
"""

import json
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
SR = 16000
PAD_S = 0.2
NOISE_AMP = 0.07  # pink noise amplitude for the call variant (~ -37 dBFS RMS, SNR ~20 dB vs TTS speech)
OPUS_BITRATE = "16k"

SILENCE_CLIPS = [
    # id, seconds, lavfi source (None = digital silence), through call chain
    ("sil01_digital", 5.0, None, False),
    ("sil02_white_low", 6.0, "anoisesrc=color=white:amplitude=0.001", False),
    ("sil03_pink_room", 8.0, "anoisesrc=color=pink:amplitude=0.05", False),
    ("sil04_brown_call", 10.0, "anoisesrc=color=brown:amplitude=0.3", True),
    ("sil05_pink_short_call", 3.0, "anoisesrc=color=pink:amplitude=0.07", True),
]


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, timeout=120, capture_output=True)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def rms_db(x: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-12))


def call_chain(src: Path, dst: Path, noise: str | None) -> None:
    """Optional noise -> band-limit -> Opus round-trip -> 16 kHz mono WAV."""
    with tempfile.TemporaryDirectory() as tmp:
        opus = Path(tmp) / "x.opus"
        band = "highpass=f=300:poles=2,highpass=f=300:poles=2,lowpass=f=3400:poles=2,lowpass=f=3400:poles=2"
        if noise:
            graph = f"[1]aformat=sample_rates={SR}:channel_layouts=mono[n];[0][n]amix=inputs=2:duration=first:normalize=0,{band}"
            inputs = ["-i", str(src), "-f", "lavfi", "-i", f"{noise}:sample_rate={SR}"]
            run(["ffmpeg", "-y", *inputs, "-filter_complex", graph, "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-ar", str(SR), str(opus)])
        else:
            run(["ffmpeg", "-y", "-i", str(src), "-af", band, "-c:a", "libopus", "-b:a", OPUS_BITRATE, "-ar", str(SR), str(opus)])
        run(["ffmpeg", "-y", "-i", str(opus), "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", str(dst)])


def main() -> None:
    if not shutil.which("say"):
        sys.exit("`say` not found: build the dataset on macOS and copy data/ to this machine")
    phrases = json.loads((ROOT / "phrases.json").read_text())["phrases"]
    for sub in ("clean", "call", "silence", "raw"):
        (DATA / sub).mkdir(parents=True, exist_ok=True)
    manifest = {"phrases": {}, "silence": {}}
    noise_ref = DATA / "raw" / "noise_ref.wav"
    run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude={NOISE_AMP}:sample_rate={SR}:duration=5",
         "-ac", "1", "-c:a", "pcm_s16le", str(noise_ref)])
    noise_db = rms_db(read_wav(noise_ref))
    manifest["call_noise_rms_db"] = round(noise_db, 1)
    for p in phrases:
        raw = DATA / "raw" / f"{p['id']}.aiff"
        clean = DATA / "clean" / f"{p['id']}.wav"
        call = DATA / "call" / f"{p['id']}.wav"
        subprocess.run(["say", "-v", p["voice"], "-o", str(raw), p["tts"]], check=True, timeout=60)
        run(["ffmpeg", "-y", "-i", str(raw), "-af", f"adelay={int(PAD_S * 1000)},apad=pad_dur={PAD_S}",
             "-ar", str(SR), "-ac", "1", "-c:a", "pcm_s16le", str(clean)])
        call_chain(clean, call, f"anoisesrc=color=pink:amplitude={NOISE_AMP}")
        x = read_wav(clean)
        speech = x[int(PAD_S * SR): len(x) - int(PAD_S * SR)]
        manifest["phrases"][p["id"]] = {
            "lang": p["lang"],
            "duration_s": round(len(x) / SR, 2),
            "speech_rms_db": round(rms_db(speech), 1),
            "approx_snr_db": round(rms_db(speech) - noise_db, 1),
        }
        print(p["id"], manifest["phrases"][p["id"]])
    for sid, secs, src, through_call in SILENCE_CLIPS:
        dst = DATA / "silence" / f"{sid}.wav"
        tmp = DATA / "raw" / f"{sid}.wav"
        lavfi = f"{src}:sample_rate={SR}:duration={secs}" if src else f"anullsrc=r={SR}:cl=mono:d={secs}"
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", lavfi, "-ac", "1", "-c:a", "pcm_s16le", str(tmp)])
        if through_call:
            call_chain(tmp, dst, None)
        else:
            shutil.copy(tmp, dst)
        manifest["silence"][sid] = {"duration_s": secs, "rms_db": round(rms_db(read_wav(dst)), 1)}
        print(sid, manifest["silence"][sid])
    (DATA / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
