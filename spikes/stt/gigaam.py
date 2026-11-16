"""GigaAM v3 (ru only) via sherpa-onnx, CPU (onnxruntime). Same row schema as bench.py.

  python gigaam.py --kind ctc   --threads 4
  python gigaam.py --kind rnnt  --threads 4      # rnnt = transducer with punctuation ("punct")

Models: https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
  sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16
  sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16
"""

import argparse
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
import psutil
import sherpa_onnx

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RUNS = ROOT / "runs"
MODELS = ROOT / "models" / "gigaam"
CTC = MODELS / "sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16"
RNNT = MODELS / "sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16"


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def build(kind: str, threads: int) -> sherpa_onnx.OfflineRecognizer:
    if kind == "ctc":
        return sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
            model=str(CTC / "model.int8.onnx"), tokens=str(CTC / "tokens.txt"),
            num_threads=threads, sample_rate=16000, feature_dim=64, decoding_method="greedy_search")
    return sherpa_onnx.OfflineRecognizer.from_transducer(
        encoder=str(RNNT / "encoder.int8.onnx"), decoder=str(RNNT / "decoder.onnx"), joiner=str(RNNT / "joiner.onnx"),
        tokens=str(RNNT / "tokens.txt"), num_threads=threads, sample_rate=16000, feature_dim=64,
        model_type="nemo_transducer", decoding_method="greedy_search")


def transcribe(rec: sherpa_onnx.OfflineRecognizer, samples: np.ndarray) -> str:
    s = rec.create_stream()
    s.accept_waveform(16000, samples)
    rec.decode_stream(s)
    return s.result.text


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", choices=["ctc", "rnnt"], default="ctc")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--conditions", nargs="+", default=["clean", "call"])
    args = ap.parse_args()
    tag = f"cpu{args.threads}-gigaam3-{args.kind}"
    spec = json.loads((ROOT / "phrases.json").read_text())
    manifest = json.loads((DATA / "manifest.json").read_text())
    phrases = [p for p in spec["phrases"] if p["lang"] == "ru"]
    t0 = time.perf_counter()
    rec = build(args.kind, args.threads)
    load_s = time.perf_counter() - t0
    for _ in range(2):
        transcribe(rec, read_wav(DATA / "clean" / f"{phrases[0]['id']}.wav"))
    RUNS.mkdir(exist_ok=True)
    with (RUNS / f"{tag}.jsonl").open("w") as f:
        for cond in args.conditions:
            for p in phrases:
                x = read_wav(DATA / cond / f"{p['id']}.wav")
                t = time.perf_counter()
                text = transcribe(rec, x)
                dt = time.perf_counter() - t
                dur = manifest["phrases"][p["id"]]["duration_s"]
                f.write(json.dumps({"tag": tag, "id": p["id"], "lang": "ru", "cond": cond, "prompt": "none",
                                    "dur_s": dur, "latency_s": round(dt, 3), "rtf": round(dt / dur, 3),
                                    "text": text}, ensure_ascii=False) + "\n")
                print(f"{cond}/{p['id']} {dt:.2f}s {text}", flush=True)
        sil = []
        for clip in sorted((DATA / "silence").glob("*.wav")):
            sil.append({"clip": clip.stem, "text": transcribe(rec, read_wav(clip))})
    if sys.platform == "win32":
        maxrss_mb = round(psutil.Process().memory_info().peak_wset / 2**20)
    else:
        import resource  # noqa: PLC0415  (Unix only)
        maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        maxrss_mb = round(maxrss / 2**20) if sys.platform == "darwin" else round(maxrss / 2**10)
    model_dir = CTC if args.kind == "ctc" else RNNT
    meta = {"tag": tag, "model": model_dir.name, "model_mb": round(sum(x.stat().st_size for x in model_dir.glob("*.onnx")) / 2**20),
            "load_s": round(load_s, 2), "threads": args.threads, "no_gpu": True, "peak_rss_mb": maxrss_mb,
            "silence": sil}
    (RUNS / f"{tag}.meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == "__main__":
    main()
