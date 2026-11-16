"""Hallucination check on no-speech clips (data/silence/*.wav) through whisper-server.

Configs differ in server flags (no-speech threshold, VAD) and request prompt. Each clip is sent
REPEATS times per config (temperature fallback makes output non-deterministic).
Also evaluates an app-side post-filter on the returned segments:
  drop segment if no_speech_prob > 0.6 or avg_logprob < -1.0 or it matches the phantom stop-list.

  python halluc.py --model models/ggml-large-v3-turbo-q5_0.bin --tag turbo-q5
"""

import argparse
import json
import re
import shutil
from pathlib import Path

from bench import DATA, OVERLOAD_PROMPT, RUNS, Server, join_segments, post_wav

ROOT = Path(__file__).resolve().parent
VAD_MODEL = ROOT / "models" / "ggml-silero-v5.1.2.bin"
REPEATS = 2
STOP_LIST = re.compile(
    r"продолжение следует|субтитр|редактор|корректор|спасибо за (?:просмотр|внимание)|подписывайтесь|"
    r"дякую за перегляд|підписуйтесь|музык|музик|аплодисмент|оплески|^\W*(?:конец|кінець)(?:\W+(?:конец|кінець))*\W*$|"
    r"dimatorzok|amara\.org|\[.*?\]|\(.*?\)",
    re.IGNORECASE,
)
CONFIGS = [
    # name, server extra flags, use VAD model, prompt kind
    ("no-filter", ["-nth", "1.0", "-lpt", "-10"], False, "none"),
    ("default", [], False, "none"),
    ("default+glossary", [], False, "glossary"),
    ("default+overload", [], False, "overload"),
    ("vad", ["--vad"], True, "none"),
    ("vad+glossary", ["--vad"], True, "glossary"),
]


def app_filter(segments: list[dict]) -> str:
    kept = []
    for s in segments:
        if (s.get("no_speech_prob") or 0) > 0.6 or (s.get("avg_logprob") or 0) < -1.0:
            continue
        text = s.get("text", "").strip(" .,!?…-")
        if text and not STOP_LIST.search(text):  # phantom phrases are whole segments -> drop the segment
            kept.append(text)
    return " ".join(kept)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--server-bin", default=shutil.which("whisper-server") or "whisper-server")
    ap.add_argument("--no-gpu", action="store_true")
    args = ap.parse_args()
    spec = json.loads((ROOT / "phrases.json").read_text())
    clips = sorted((DATA / "silence").glob("*.wav"))
    out = (RUNS / f"halluc-{args.tag}.jsonl").open("w")
    for name, extra, vad, prompt_kind in CONFIGS:
        srv = Server(args.server_bin, args.model, 4, args.no_gpu, VAD_MODEL if vad else None,
                     RUNS / f"halluc-{args.tag}.server.log", extra)
        try:
            for lang in ("ru", "uk"):
                for clip in clips:
                    for rep in range(REPEATS):
                        fields = {"language": lang, "response_format": "verbose_json", "temperature": "0.0"}
                        if prompt_kind == "glossary":
                            fields["prompt"] = spec["glossary"][lang]
                        elif prompt_kind == "overload":
                            fields["prompt"] = OVERLOAD_PROMPT[lang]
                        res = post_wav(srv.url(), clip, fields)
                        segs = res.get("segments", [])
                        text = join_segments(res)
                        row = {"tag": args.tag, "config": name, "lang": lang, "clip": clip.stem, "rep": rep,
                               "text": text, "filtered": app_filter(segs),
                               "segments": [s.get("text", "") for s in segs],
                               "no_speech_prob": [s.get("no_speech_prob") for s in segs],
                               "avg_logprob": [s.get("avg_logprob") for s in segs]}
                        out.write(json.dumps(row, ensure_ascii=False) + "\n")
                        print(name, lang, clip.stem, repr(text)[:80], "->", repr(row["filtered"])[:40], flush=True)
        finally:
            srv.stop()
    out.close()


if __name__ == "__main__":
    main()
