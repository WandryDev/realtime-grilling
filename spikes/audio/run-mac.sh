#!/bin/sh
# Reproduces the macOS measurements from docs/spikes/audio.md. Every step is time-bounded.
# Logs go to runs/ (gitignored). Usage: ./run-mac.sh [mic-name] [speaker-name]
set -eu
cd "$(dirname "$0")"
MIC="${1:-MacBook}"
SPK="${2:-MacBook}"
cargo build --release
B="$PWD/target/release/audio-spike"
mkdir -p runs data

echo "== devices"; "$B" devices | tee runs/devices.log

echo "== 1. mic-in-use detection: another process captures the mic for 2 s"
"$B" mic-watch --secs 5 --poll-ms 5 --device "$MIC" \
  --spawn "$B mic-record --mode raw --mic $MIC --secs 2 --out /tmp/spike-child.wav" --spawn-at 1 | tee runs/1-watch-child.log
echo "== 1. same, child is SIGKILLed after 1.5 s"
"$B" mic-watch --secs 5 --poll-ms 5 --device "$MIC" \
  --spawn "$B mic-record --mode raw --mic $MIC --secs 10 --out /tmp/spike-child.wav" --spawn-at 1 --kill-after 1.5 | tee runs/1-watch-kill.log
echo "== 1. our own capture must not count as 'others'"
"$B" mic-watch --secs 4 --poll-ms 5 --device "$MIC" --self-capture 2 | tee runs/1-watch-self.log

echo "== 2. process tap: other process speaks, our own 1 kHz tone must be excluded"
"$B" tap-record --secs 4 --self-tone 1000 --out runs/2-tap.wav --spawn "say 'one two three four five six seven'" 2>&1 | tee runs/2-tap.log
"$B" tap-record --secs 4 --self-tone 1000 --include-self --out runs/2-tap-incl.wav --spawn "say 'one two three four five six seven'" 2>&1 | tee runs/2-tap-incl.log

echo "== 4. VPIO side effect on other apps' audio (steady 440 Hz tone, VPIO in the middle third)"
"$B" tap-vpio-test --secs 12 --mic "$MIC" --spk "$SPK" --gain 0.05 2>&1 | tee runs/4-tap-vpio.log

echo "== 4. AEC3 (sonora) simulation"
[ -f data/far.wav ] || { say -v Milena -o data/far.aiff "Добрый день. Мы посмотрели ваш бриф и хотим уточнить несколько моментов по срокам. Первый этап нужно закончить до пятнадцатого марта, а бюджет не должен превышать пятьдесят тысяч. Кроме того, нам не нужна интеграция с CRM на старте. Скажите, пожалуйста, кто будет отвечать за дизайн и сколько времени займёт тестирование?"; ffmpeg -nostdin -loglevel error -y -i data/far.aiff -ac 1 -ar 16000 data/far.wav; }
[ -f data/near.wav ] || { say -v Lesya -o data/near.aiff "Так, зрозумів. Дизайн буде робити наша команда, тестування займе приблизно два тижні. Давайте я ще уточню щодо інтеграцій."; ffmpeg -nostdin -loglevel error -y -i data/near.aiff -ac 1 -ar 16000 data/near.wav; }
for a in "--erl-db 6" "--erl-db 0" "--delay-ms 200" "--drift-ppm 100" "--nonlinear --erl-db 0"; do
  # shellcheck disable=SC2086
  "$B" aec-sim $a
done | tee runs/4-aec-sim.log

echo "== 4. REAL echo test (needs microphone permission for the app that runs this shell; plays speech on $SPK)"
"$B" echo-test --mic "$MIC" --spk "$SPK" --far data/far.wav --phase 6 --out-dir runs/echo 2>&1 | tee runs/4-echo.log
