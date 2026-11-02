#!/usr/bin/env bash
# Full macOS reproduction (Apple Silicon). Real-time paced => ~2 h on M3; every step is bounded
# (per-request timeout 180 s, server killed after each run). Close heavy apps first: latency is
# sensitive to background load (each row records load1).
set -uo pipefail
cd "$(dirname "$0")"
PY=.venv/bin/python
P="clean:none call:none call:glossary"

# 1. Metal, full encoder window: latency + quality, no prompt / glossary
for m in large-v3-turbo:turbo-f16 large-v3-turbo-q8_0:turbo-q8 large-v3-turbo-q5_0:turbo-q5 medium:medium small:small; do
  $PY bench.py --model "models/ggml-${m%%:*}.bin" --tag "gpu-${m##*:}" --passes $P
done
# 2. speed lever: 768-frame (15.36 s) encoder window; beam search (post-call candidate); overloaded prompt
$PY bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag gpu-turbo-q5-ac768 --audio-ctx 768 --passes $P
$PY bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag gpu-turbo-q5-beam5 --beam-size 5 --passes call:none call:glossary
$PY bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag gpu-turbo-q5-overload --passes call:overload
# 3. hallucinations on no-speech clips, with/without VAD and prompts
for m in large-v3-turbo-q5_0:turbo-q5 large-v3-turbo:turbo-f16 small:small; do
  $PY halluc.py --model "models/ggml-${m%%:*}.bin" --tag "${m##*:}"
done
# 4. GigaAM v3 (ru, CPU via sherpa-onnx)
$PY gigaam.py --kind ctc --threads 4
$PY gigaam.py --kind rnnt --threads 4
$PY gigaam.py --kind rnnt --threads 1
# 5. CPU-only reference (no Metal), bounded to 3 phrases per language
$PY bench.py --model models/ggml-small.bin --tag cpu4-small --no-gpu --limit 3 --passes call:none
$PY bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag cpu4-turbo-q5 --no-gpu --limit 3 --passes call:none
$PY bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag cpu4-turbo-q5-ac768 --no-gpu --audio-ctx 768 --limit 3 --passes call:none
# 6. encoder-only CPU timings, comparable with whisper.cpp issue #89 (one 30 s window)
for m in small large-v3-turbo-q5_0 large-v3-turbo; do
  echo "== whisper-bench $m -t 4 -ng (load1 $(sysctl -n vm.loadavg | awk '{print $2}'))"
  whisper-bench -m "models/ggml-$m.bin" -t 4 -ng 2>&1 | grep -E "load time|encode time"
done
# 7. back-to-back stress (thermal throttling on fanless laptops) - not completed in the spike
$PY bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag stress-turbo-q5 --pace none --passes call:none call:none call:none
$PY score.py > /dev/null && echo "tables: runs/report.md"
