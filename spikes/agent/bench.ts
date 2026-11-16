// Latency/usage benchmark for independent `claude -p` calls (fast loop).
// Usage: bun spikes/agent/bench.ts --label NAME [--model sonnet] [--mode min|default]
//          [--out schema|prompt] [--sys replace|append] [--effort low] [--n 10]
//          [--start 0] [--window 10] [--trivial] [--settings JSON] [--exclude-dynamic]
// Each call is a fresh CLI process run sequentially from a temp dir outside the repo.
import { mkdirSync, appendFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNS,
  SCHEDULE_MIN,
  loadTranscript,
  read,
  stablePrefix,
  userMessage,
} from "./lib.ts";

const TIMEOUT_MS = 90_000;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const cfg = {
  label: arg("label", "adhoc"),
  model: arg("model", "sonnet"),
  mode: arg("mode", "min"), // min | default
  out: arg("out", "schema"), // schema | prompt
  sys: arg("sys", "replace"), // replace (--system-prompt) | append (--append-system-prompt)
  effort: arg("effort", "low"),
  n: Number(arg("n", "10")),
  start: Number(arg("start", "0")),
  window: Number(arg("window", "10")),
  trivial: flag("trivial"),
  settings: arg("settings", ""), // e.g. '{"alwaysThinkingEnabled":false}'
  excludeDynamic: flag("exclude-dynamic"),
};

const cwd = mkdtempSync(join(tmpdir(), "agent-spike-"));
const outDir = join(RUNS, cfg.label);
mkdirSync(outDir, { recursive: true });
const summaryFile = join(RUNS, `${cfg.label}.jsonl`);

function buildArgs(): string[] {
  const a = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    cfg.model,
  ];
  if (cfg.effort !== "none") a.push("--effort", cfg.effort);
  if (cfg.settings) a.push("--settings", cfg.settings);
  if (cfg.excludeDynamic) a.push("--exclude-dynamic-system-prompt-sections");
  if (cfg.mode === "min") {
    a.push(
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--tools",
      "",
      "--no-session-persistence",
      "--disable-slash-commands"
    );
  }
  if (!cfg.trivial) {
    a.push(cfg.sys === "append" ? "--append-system-prompt" : "--system-prompt", stablePrefix(cfg.label));
    if (cfg.out === "schema") a.push("--json-schema", read("patch.schema.json"));
  }
  return a;
}

interface Timings {
  init?: number;
  firstStream?: number; // message_start of first API response
  firstToken?: number; // first content_block_delta of any kind
  firstOutput?: number; // first text/json delta (not thinking)
  result?: number;
  exit?: number;
}

async function runOne(k: number): Promise<void> {
  const segs = loadTranscript();
  const tNow = Math.round(SCHEDULE_MIN[k] * 60);
  const prompt = cfg.trivial
    ? "Ответь одним словом: ОК"
    : userMessage(segs, tNow, cfg.window, cfg.out === "prompt");
  const args = buildArgs();
  const t0 = performance.now();
  const proc = Bun.spawn(["claude", ...args], {
    cwd,
    stdin: new TextEncoder().encode(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, TIMEOUT_MS);

  const tm: Timings = {};
  const raw: string[] = [];
  let result: Record<string, unknown> | null = null;
  let init: Record<string, unknown> | null = null;
  const rateLimits: unknown[] = [];
  let apiRequests = 0;
  const since = (): number => Math.round(performance.now() - t0);

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line.trim()) continue;
      const ts = since();
      raw.push(JSON.stringify({ ts, line }));
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "system" && e.subtype === "init") {
        tm.init ??= ts;
        init = e;
      } else if (e.type === "rate_limit_event") {
        rateLimits.push(e.rate_limit_info);
      } else if (e.type === "stream_event") {
        const ev = e.event ?? {};
        if (ev.type === "message_start") {
          apiRequests++;
          tm.firstStream ??= ts;
        }
        if (ev.type === "content_block_delta") {
          tm.firstToken ??= ts;
          const dt = ev.delta?.type;
          if (dt === "text_delta" || dt === "input_json_delta") tm.firstOutput ??= ts;
        }
      } else if (e.type === "result") {
        tm.result ??= ts;
        result = e;
      }
    }
  }
  await proc.exited;
  clearTimeout(killer);
  tm.exit = since();
  const stderr = await new Response(proc.stderr).text();
  writeFileSync(join(outDir, `k${k}.jsonl`), `${raw.join("\n")}\n`);
  if (stderr.trim()) writeFileSync(join(outDir, `k${k}.stderr`), stderr);

  const r = result as Record<string, any> | null;
  const rec = {
    cfg,
    env: {
      disableThinking: process.env.CLAUDE_CODE_DISABLE_THINKING ?? null,
      disableNonessential: process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? null,
    },
    k,
    tNow,
    promptChars: prompt.length,
    timedOut,
    exitCode: proc.exitCode,
    timings: tm,
    apiRequests,
    init: init
      ? {
          model: (init as any).model,
          tools: ((init as any).tools ?? []).length,
          mcp: ((init as any).mcp_servers ?? []).length,
          plugins: ((init as any).plugins ?? []).length,
        }
      : null,
    durationMs: r?.duration_ms,
    durationApiMs: r?.duration_api_ms,
    numTurns: r?.num_turns,
    isError: r?.is_error,
    subtype: r?.subtype,
    usage: r?.usage
      ? {
          input: r.usage.input_tokens,
          output: r.usage.output_tokens,
          cacheCreate: r.usage.cache_creation_input_tokens,
          cacheRead: r.usage.cache_read_input_tokens,
          thinking: r.usage.output_tokens_details?.thinking_tokens,
          cacheCreation: r.usage.cache_creation,
          iterations: r.usage.iterations,
        }
      : null,
    modelUsage: r?.modelUsage,
    costUsd: r?.total_cost_usd,
    result: r?.result,
    structured: r?.structured_output,
    rateLimit: rateLimits.at(-1) ?? null,
  };
  appendFileSync(summaryFile, `${JSON.stringify(rec)}\n`);
  const u = rec.usage;
  console.log(
    `[${cfg.label}] k=${k} t=${tNow}s wall=${tm.exit}ms init=${tm.init} ttft=${tm.firstToken} first_out=${tm.firstOutput} result=${tm.result} dur=${rec.durationMs}/${rec.durationApiMs} turns=${rec.numTurns} req=${apiRequests} in=${u?.input} cw=${u?.cacheCreate} cr=${u?.cacheRead} out=${u?.output} think=${u?.thinking} $=${rec.costUsd?.toFixed?.(4)} err=${rec.isError} to=${timedOut}`
  );
}

for (let k = cfg.start; k < cfg.start + cfg.n; k++) {
  await runOne(k % SCHEDULE_MIN.length);
}
