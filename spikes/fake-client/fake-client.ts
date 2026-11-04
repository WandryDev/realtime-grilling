// Artificial client for live tests of the fast loop.
//
// Watches the app's database for the manager's phrases ("me") of the running
// recording. When the manager pauses, asks Claude for the client's line and
// speaks it with `say`, so the app hears it as system audio ("others").
//
//   bun spikes/fake-client/fake-client.ts [--persona path] [--voice Milena] [--pause 2500]

import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const DB_PATH = join(
  homedir(),
  "Library/Application Support/com.dev-wandry.realtime-grilling/grill.db"
);
const PERSONA = option("persona", join(import.meta.dir, "persona.md"));
const VOICE = option("voice", "Milena");
const PAUSE_MS = Number(option("pause", "2500"));
const CLAUDE = option("claude", join(homedir(), ".local/bin/claude"));
// Phrases of "me" that start while the client speaks are its echo in the mic.
const ECHO_MARGIN_MS = 1500;

interface Segment {
  channel: "me" | "others";
  created_at: number;
  end_ms: number;
  id: string;
  start_ms: number;
  text: string;
}

const db = new Database(DB_PATH, { readonly: true });
const log = (...parts: unknown[]) =>
  console.log(new Date().toLocaleTimeString("ru-RU"), ...parts);

function activeRecording() {
  return db
    .query(
      "select id, started_at from recordings where status = 'recording' order by started_at desc limit 1"
    )
    .get() as { id: string; started_at: number } | null;
}

function managerSegments(recordingId: string) {
  return db
    .query(
      "select id, channel, start_ms, end_ms, text, created_at from transcript_segments where recording_id = ? and pass = 'live' and channel = 'me' order by start_ms"
    )
    .all(recordingId) as Segment[];
}

interface Line {
  at: number;
  speaker: "Менеджер" | "Клиент";
  text: string;
}

// The client's lines are kept as spoken, not as recognized.
const clientLines: Line[] = [];
// Wall-clock intervals when `say` was playing.
const playing: [number, number][] = [];
const used = new Set<string>();

function isEcho(segment: Segment, recordingStart: number) {
  const at = recordingStart + segment.start_ms;
  return playing.some(
    ([from, to]) => at >= from - ECHO_MARGIN_MS && at <= to + ECHO_MARGIN_MS
  );
}

function askClient(conversation: Line[]): string {
  const transcript = conversation
    .map((line) => `${line.speaker}: ${line.text}`)
    .join("\n");
  const message = `Разговор до этого момента (реплики менеджера — из распознавания речи, с ошибками):\n\n${transcript}\n\nОтветь следующей репликой клиента.`;
  const result = spawnSync(
    CLAUDE,
    [
      "-p",
      "--model",
      "claude-sonnet-5-5",
      "--effort",
      "low",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--tools",
      "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--system-prompt-file",
      PERSONA,
      "--output-format",
      "text",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      input: message,
      timeout: 60_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr || `claude exited with ${result.status}`);
  }
  return result.stdout.trim().replace(/^["«]|["»]$/gu, "");
}

function speak(text: string) {
  return new Promise<void>((resolve) => {
    const from = Date.now();
    const child = spawn("say", ["-v", VOICE, text]);
    child.on("exit", () => {
      playing.push([from, Date.now()]);
      resolve();
    });
  });
}

let busy = false;
let current: string | null = null;

async function tick() {
  if (busy) {
    return;
  }
  const recording = activeRecording();
  if (!recording) {
    return;
  }
  if (current !== recording.id) {
    // A new recording: what was said before the script saw it is not a cue.
    current = recording.id;
    clientLines.length = 0;
    for (const segment of managerSegments(recording.id)) {
      used.add(segment.id);
    }
    log("Запись", recording.id);
    return;
  }
  const fresh = managerSegments(recording.id).filter(
    (segment) => !used.has(segment.id)
  );
  const real = fresh.filter((segment) => !isEcho(segment, recording.started_at));
  for (const echo of fresh.filter((segment) => !real.includes(segment))) {
    used.add(echo.id);
  }
  if (real.length === 0) {
    return;
  }
  const last = real.at(-1);
  if (!last || Date.now() - last.created_at < PAUSE_MS) {
    return;
  }
  busy = true;
  try {
    for (const segment of real) {
      used.add(segment.id);
    }
    const manager: Line[] = managerSegments(recording.id)
      .filter((segment) => used.has(segment.id) && !isEcho(segment, recording.started_at))
      .map((segment) => ({
        at: recording.started_at + segment.start_ms,
        speaker: "Менеджер",
        text: segment.text,
      }));
    const conversation = [...manager, ...clientLines].sort((a, b) => a.at - b.at);
    log("Менеджер:", real.map((segment) => segment.text).join(" "));
    const started = Date.now();
    const reply = askClient(conversation);
    log(`Клиент (${((Date.now() - started) / 1000).toFixed(1)} с):`, reply);
    clientLines.push({ at: Date.now(), speaker: "Клиент", text: reply });
    await speak(reply);
  } catch (error) {
    log("ошибка:", error instanceof Error ? error.message : error);
  } finally {
    busy = false;
  }
}

readFileSync(PERSONA, "utf8");
log(`Жду фраз менеджера в ${DB_PATH}`);
log(`Легенда: ${PERSONA}, голос ${VOICE}, пауза ${PAUSE_MS} мс. Ctrl+C — выход.`);
setInterval(() => {
  tick().catch((error) => log("ошибка:", error));
}, 500);
