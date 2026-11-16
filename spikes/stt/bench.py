"""Per-phrase latency + transcripts through a warm whisper-server (model loaded once).

Cross-platform (macOS / Windows / Linux). Only stdlib + psutil.

  python bench.py --model models/ggml-large-v3-turbo-q5_0.bin --tag turbo-q5 \
      --conditions clean call --prompts none glossary

For each model it:
  1. starts whisper-server, measures time until HTTP is up (= model load time);
  2. sends 2 warm-up requests (discarded);
  3. POSTs every phrase WAV (already VAD-sized, 2-15 s) and measures wall-clock latency;
  4. tracks peak RSS of the server process (psutil; on Windows peak working set; on macOS also
     `/usr/bin/time -l` "peak memory footprint", which includes Metal buffers);
  5. kills the server (always, also on Ctrl+C / error).
Writes runs/<tag>.jsonl (one row per request) and runs/<tag>.meta.json.
"""

import argparse
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import uuid
from pathlib import Path

import psutil

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RUNS = ROOT / "runs"
REQUEST_TIMEOUT_S = 180
# Onboarding "can this machine do real time" thresholds (see docs/spikes/stt.md)
MAX_P95_LATENCY_S = 3.0  # phrase result no later than 3 s after the pause
MAX_TOTAL_RTF = 0.5  # sum(compute) <= half of sum(audio) -> headroom for throttling, other apps, bursts
LOAD_TIMEOUT_S = 180

# ~220 tokens of glossary-style text: deliberately at/over Whisper's 224-token prompt budget.
OVERLOAD_PROMPT = {
    "ru": (
        "Глоссарий звонка: Техноком, Олег Ковальчук, Марина Швец, Андрей Литвиненко, Bitrix24, ClickUp, amoCRM, "
        "Binotel, Ringostat, Asterisk, FreePBX, Zadarma, KeyCRM, Salesforce, HubSpot, Pipedrive, Zapier, Make, n8n, "
        "Google Таблицы, Google Sheets, Slack, Telegram, Viber, WhatsApp Business, CRM, ERP, API, REST API, webhook, "
        "OAuth, SIP, SIP-транк, IVR, ACD, SLA, KPI, NPS, CSAT, MVP, PoC, BPMN, Jira, Confluence, Outline, GitHub, "
        "Сергей Бондаренко, Наталья Кравченко, Виктор Мельник, Юлия Ткаченко, Павел Шевченко, Ольга Коваленко. "
        "Темы: интеграция телефонии, маршрутизация звонков, пропущенные звонки, записи разговоров, отчётность, "
        "мобильное приложение, бюджет, сроки запуска, первая фаза, вторая фаза."
    ),
    "uk": (
        "Глосарій дзвінка: АгроСвіт, Велнес Клаб, Ірина Дорошенко, Тарас Гнатюк, Bitrix24, KeyCRM, ClickUp, Binotel, "
        "Ringostat, Asterisk, FreePBX, Zadarma, amoCRM, Salesforce, HubSpot, Pipedrive, Zapier, Make, n8n, "
        "Google Sheets, Google Таблиці, Slack, Telegram, Viber, WhatsApp Business, CRM, ERP, API, REST API, webhook, "
        "OAuth, SIP, SIP-транк, IVR, ACD, SLA, KPI, NPS, CSAT, MVP, PoC, BPMN, Jira, Confluence, Outline, GitHub, "
        "Сергій Бондаренко, Наталія Кравченко, Віктор Мельник, Юлія Ткаченко, Павло Шевченко, Ольга Коваленко. "
        "Теми: інтеграція телефонії, маршрутизація дзвінків, пропущені дзвінки, записи розмов, звітність, "
        "мобільний застосунок, бюджет, терміни запуску, перша фаза, друга фаза."
    ),
}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def post_wav(url: str, wav: Path, fields: dict[str, str]) -> dict:
    boundary = uuid.uuid4().hex
    parts = []
    for k, v in fields.items():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{wav.name}"\r\n'
        "Content-Type: audio/wav\r\n\r\n".encode() + wav.read_bytes() + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(url, data=b"".join(parts), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_S) as r:
        return json.loads(r.read().decode())


def join_segments(res: dict) -> str:
    """Segments can split mid-word; each segment text carries its own leading space, so concatenate as-is."""
    segs = res.get("segments")
    text = "".join(s.get("text", "") for s in segs) if segs else res.get("text", "")
    return " ".join(text.split())


class Server:
    def __init__(self, binary: str, model: Path, threads: int, no_gpu: bool, vad_model: Path | None, log: Path,
                 extra: list[str] | None = None):
        self.port = free_port()
        # -nlp: otherwise verbose_json runs an extra language-detection encoder pass (~2x latency)
        cmd = [binary, "-m", str(model), "--host", "127.0.0.1", "--port", str(self.port), "-t", str(threads), "-nlp"]
        if no_gpu:
            cmd.append("-ng")
        if vad_model:
            cmd += ["-vm", str(vad_model)]
        cmd += extra or []
        self.use_time = platform.system() == "Darwin" and Path("/usr/bin/time").exists()
        if self.use_time:
            cmd = ["/usr/bin/time", "-l", *cmd]
        self.log = log
        self.logf = log.open("w")
        t0 = time.perf_counter()
        self.proc = subprocess.Popen(cmd, stdout=self.logf, stderr=subprocess.STDOUT)
        self.peak_rss = 0
        self._stop = threading.Event()
        self.load_s = self._wait_ready(t0)
        self.ps = self._server_ps()
        threading.Thread(target=self._poll_mem, daemon=True).start()

    def _server_ps(self) -> psutil.Process:
        p = psutil.Process(self.proc.pid)
        if self.use_time:
            for _ in range(50):
                kids = p.children()
                if kids:
                    return kids[0]
                time.sleep(0.05)
        return p

    def _wait_ready(self, t0: float) -> float:
        while time.perf_counter() - t0 < LOAD_TIMEOUT_S:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited, see {self.log}")
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/", timeout=1)
                return time.perf_counter() - t0
            except OSError:
                time.sleep(0.05)
        self.stop()
        raise TimeoutError("server did not come up")

    def _poll_mem(self) -> None:
        while not self._stop.is_set():
            try:
                mi = self.ps.memory_info()
                self.peak_rss = max(self.peak_rss, getattr(mi, "peak_wset", 0) or 0, mi.rss)
            except psutil.Error:
                return
            time.sleep(0.1)

    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/inference"

    def stop(self) -> dict:
        self._stop.set()
        try:
            self.ps.send_signal(signal.SIGINT if os.name != "nt" else signal.SIGTERM)
            self.ps.wait(5)
        except (psutil.Error, subprocess.TimeoutExpired):
            pass
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            pass
        for p in (self.ps, psutil.Process(self.proc.pid) if self.proc.poll() is None else None):
            if p is not None:
                try:
                    p.kill()
                except psutil.Error:
                    pass
        self.logf.close()
        out = {"peak_rss_mb": round(self.peak_rss / 2**20)}
        if self.use_time:
            for line in self.log.read_text(errors="replace").splitlines():
                if "peak memory footprint" in line:
                    out["peak_footprint_mb"] = round(int(line.split()[0]) / 2**20)
                if "maximum resident set size" in line:
                    out["max_rss_time_mb"] = round(int(line.split()[0]) / 2**20)
        return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--server-bin", default=shutil.which("whisper-server") or "whisper-server")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--no-gpu", action="store_true")
    ap.add_argument("--conditions", nargs="+", default=["clean", "call"])
    ap.add_argument("--prompts", nargs="+", default=["none", "glossary"], choices=["none", "glossary", "overload"])
    ap.add_argument("--langs", nargs="+", default=["ru", "uk"])
    ap.add_argument("--limit", type=int, default=0, help="first N phrases per language (quick onboarding-style check)")
    ap.add_argument("--beam-size", type=int, default=-1, help="-1 = greedy (server default)")
    ap.add_argument("--pace", choices=["realtime", "none"], default="realtime",
                    help="realtime: send the next phrase no earlier than dur_s after the previous one (live-call load);"
                         " none: back-to-back (max load, shows thermal throttling)")
    ap.add_argument("--audio-ctx", type=int, default=0,
                    help="encoder window in frames (1500 = 30 s, default). 768 = 15.36 s covers a VAD-capped 15 s phrase"
                         " at ~half the encoder cost; much smaller values break large-v3-turbo")
    ap.add_argument("--passes", nargs="+", default=None,
                    help="explicit cond:prompt pairs, e.g. clean:none call:none call:glossary (overrides the product)")
    args = ap.parse_args()

    spec = json.loads((ROOT / "phrases.json").read_text())
    manifest = json.loads((DATA / "manifest.json").read_text())
    phrases = [p for p in spec["phrases"] if p["lang"] in args.langs]
    if args.limit:
        phrases = [p for lang in args.langs for p in [q for q in phrases if q["lang"] == lang][: args.limit]]
    RUNS.mkdir(exist_ok=True)
    out = RUNS / f"{args.tag}.jsonl"
    srv = Server(args.server_bin, args.model, args.threads, args.no_gpu, None, RUNS / f"{args.tag}.server.log")
    print(f"[{args.tag}] loaded in {srv.load_s:.2f}s", flush=True)
    rows = 0
    try:
        warm = DATA / "clean" / f"{phrases[0]['id']}.wav"
        for _ in range(2):
            post_wav(srv.url(), warm, {"language": phrases[0]["lang"], "response_format": "json"})
        passes = [tuple(x.split(":")) for x in args.passes] if args.passes else \
            [(c, pk) for c in args.conditions for pk in args.prompts]
        t_run = time.perf_counter()
        with out.open("w") as f:
            for cond, prompt_kind in passes:
                for p in phrases:
                    wav = DATA / cond / f"{p['id']}.wav"
                    fields = {"language": p["lang"], "response_format": "verbose_json", "temperature": "0.0"}
                    if args.beam_size > 0:
                        fields["beam_size"] = str(args.beam_size)
                    dur = manifest["phrases"][p["id"]]["duration_s"]
                    if args.audio_ctx:
                        fields["audio_ctx"] = str(args.audio_ctx)
                    if prompt_kind == "glossary":
                        fields["prompt"] = spec["glossary"][p["lang"]]
                    elif prompt_kind == "overload":
                        fields["prompt"] = OVERLOAD_PROMPT[p["lang"]]
                    t0 = time.perf_counter()
                    res = post_wav(srv.url(), wav, fields)
                    dt = time.perf_counter() - t0
                    segs = res.get("segments", [])
                    f.write(json.dumps({
                        "tag": args.tag, "id": p["id"], "lang": p["lang"], "cond": cond, "prompt": prompt_kind,
                        "dur_s": dur, "latency_s": round(dt, 3), "rtf": round(dt / dur, 3),
                        "t_s": round(t0 - t_run, 1), "audio_ctx": args.audio_ctx or 1500,
                        "load1": round(psutil.getloadavg()[0], 1),
                        "text": join_segments(res),
                        "avg_logprob": [s.get("avg_logprob") for s in segs],
                        "no_speech_prob": [s.get("no_speech_prob") for s in segs],
                    }, ensure_ascii=False) + "\n")
                    rows += 1
                    print(f"  {cond}/{prompt_kind}/{p['id']} {dt:.2f}s", flush=True)
                    if args.pace == "realtime":
                        time.sleep(max(0.0, dur - dt))
    finally:
        mem = srv.stop()
    meta = {"tag": args.tag, "model": args.model.name, "model_mb": round(args.model.stat().st_size / 2**20),
            "load_s": round(srv.load_s, 2), "threads": args.threads, "no_gpu": args.no_gpu,
            "beam_size": args.beam_size, "pace": args.pace, "audio_ctx": args.audio_ctx, "rows": rows, "platform": platform.platform(),
            "cpu": platform.processor() or platform.machine(), "cpu_count": psutil.cpu_count(logical=False), **mem}
    rows_all = [json.loads(line) for line in out.read_text().splitlines()]
    lat = sorted(r["latency_s"] for r in rows_all)
    rtf = sorted(r["rtf"] for r in rows_all)
    p95 = lambda xs: xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]  # noqa: E731
    meta["p95_latency_s"], meta["p95_rtf"] = p95(lat), p95(rtf)
    meta["total_rtf"] = round(sum(lat) / sum(r["dur_s"] for r in rows_all), 3)
    meta["realtime_ok"] = meta["p95_latency_s"] <= MAX_P95_LATENCY_S and meta["total_rtf"] <= MAX_TOTAL_RTF
    (RUNS / f"{args.tag}.meta.json").write_text(json.dumps(meta, indent=1))
    print(json.dumps(meta))


if __name__ == "__main__":
    sys.exit(main())
