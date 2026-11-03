#!/usr/bin/env bash
# Builds the bundled hardware-check phrases (speech-recognition design.md,
# decision 14) in src-tauri/resources/speech-check/.
#
# macOS only: `say` (voices Milena and Lesya), ffmpeg and python3.
#
#   say → 0.2 s padding → light pink noise → 300–3400 Hz → 16 kHz mono WAV
#   (a temp dir) → Ogg Opus through the app's own `OggOpusWriter` (an ignored
#   Rust test) → <id>.opus
#
# The phrases and their references come from spikes/stt/phrases.json; the
# selection is IDS below. Only the .opus files and phrases.json are committed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/src-tauri/resources/speech-check"
SOURCE="$ROOT/spikes/stt/phrases.json"
# ~4, ~6 and ~12 s per language (the spike set has no 3-s ru phrase without
# a trap; these are the closest).
IDS="ru05 ru11 ru18 uk02 uk07 uk12"
RATE=16000
PAD_MS=200
# Same call chain as spikes/stt/make_dataset.py (SNR ~20 dB), seeded so a
# rebuild gives the same audio.
NOISE="anoisesrc=color=pink:amplitude=0.07:seed=7:sample_rate=$RATE"
BAND="highpass=f=300:poles=2,highpass=f=300:poles=2,lowpass=f=3400:poles=2,lowpass=f=3400:poles=2"

for tool in say ffmpeg python3; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"

# phrases.json (references) and a TSV for the loop below.
python3 -I - "$SOURCE" "$OUT/phrases.json" "$WORK/phrases.tsv" $IDS <<'PY'
import json, sys
source, out, tsv, *ids = sys.argv[1:]
data = json.load(open(source, encoding="utf-8"))
by_id = {p["id"]: p for p in data["phrases"]}
phrases = [
    {"id": i, "lang": by_id[i]["lang"], "voice": by_id[i]["voice"],
     "file": f"{i}.opus", "tts": by_id[i]["tts"], "ref": by_id[i]["ref"]}
    for i in ids
]
doc = {
    "_comment": "Hardware-check phrases (speech-recognition design.md decision 14). "
                "Built by scripts/make-speech-check.sh from spikes/stt/phrases.json: "
                "macOS `say`, pink noise, 300-3400 Hz, 16 kHz mono Ogg Opus. "
                "ref = reference transcript; glossary = the spike's per-language prompt.",
    "glossary": data["glossary"],
    "phrases": phrases,
}
with open(out, "w", encoding="utf-8") as f:
    json.dump(doc, f, ensure_ascii=False, indent=2)
    f.write("\n")
with open(tsv, "w", encoding="utf-8") as f:
    for p in phrases:
        f.write(f"{p['id']}\t{p['voice']}\t{p['tts']}\n")
PY

while IFS=$'\t' read -r id voice text; do
  say -v "$voice" -o "$WORK/$id.aiff" "$text"
  ffmpeg -loglevel error -y -i "$WORK/$id.aiff" -f lavfi -i "$NOISE" \
    -filter_complex "[0]aresample=$RATE,aformat=channel_layouts=mono,adelay=$PAD_MS,apad=pad_dur=0.$PAD_MS[s];[1]aformat=channel_layouts=mono[n];[s][n]amix=inputs=2:duration=first:normalize=0,$BAND" \
    -ar "$RATE" -ac 1 -c:a pcm_s16le "$WORK/$id.wav"
done <"$WORK/phrases.tsv"

SPEECH_CHECK_WAV_DIR="$WORK" SPEECH_CHECK_OUT_DIR="$OUT" \
  cargo test --manifest-path "$ROOT/src-tauri/Cargo.toml" --lib \
  speech::check::tests::encode_check_phrases -- --ignored --exact

ls -l "$OUT"
du -ch "$OUT"/*.opus | tail -1
