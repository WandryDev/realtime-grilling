// Shared input loading for the agent-latency spike: builds the stable prefix
// (system prompt + brief + people) and the per-call volatile part
// (state + last N minutes of transcript).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const INPUTS = join(HERE, "inputs");
export const RUNS = join(HERE, "runs");

export interface Segment {
  id: string;
  t: number; // seconds from call start
  ch: "Я" | "Остальные";
  text: string;
}

const LINE_RE = /^\[(\d\d):(\d\d)\] (Я|Остальные): (.+)$/;

export function loadTranscript(): Segment[] {
  const raw = readFileSync(join(INPUTS, "transcript.txt"), "utf8");
  const segs: Segment[] = [];
  for (const line of raw.split("\n")) {
    const m = LINE_RE.exec(line.trim());
    if (!m) continue;
    segs.push({
      id: `s${String(segs.length + 1).padStart(3, "0")}`,
      t: Number(m[1]) * 60 + Number(m[2]),
      ch: m[3] as Segment["ch"],
      text: m[4],
    });
  }
  return segs;
}

export const read = (name: string): string =>
  readFileSync(join(INPUTS, name), "utf8");

/** Stable, cacheable prefix: identical bytes on every call of a call-session. */
export function stablePrefix(callSessionId = ""): string {
  return [
    read("system.md").trim(),
    "",
    "# Бриф проекта",
    "",
    read("brief.md").trim(),
    "",
    "# Профили людей клиента",
    "",
    read("people.md").trim(),
    ...(callSessionId ? ["", `ID звонка: ${callSessionId}`] : []),
  ].join("\n");
}

export const fmtT = (t: number): string =>
  `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;

/** Default call schedule (minutes into the call) for the 10 simulated calls. */
export const SCHEDULE_MIN = [3, 5.5, 8, 10.5, 13, 15.5, 18, 20.5, 23, 25.5];

export function windowSegments(
  segs: Segment[],
  tNowSec: number,
  windowMin: number
): Segment[] {
  return segs.filter((s) => s.t <= tNowSec && s.t > tNowSec - windowMin * 60);
}

/** Volatile per-call user message: state + transcript window. */
export function userMessage(
  segs: Segment[],
  tNowSec: number,
  windowMin: number,
  promptOnly: boolean
): string {
  const state = JSON.parse(read("state.json"));
  const win = windowSegments(segs, tNowSec, windowMin);
  const lines = win.map((s) => `${s.id} [${fmtT(s.t)}] ${s.ch}: ${s.text}`);
  const tail = promptOnly
    ? "Верни патч строго одним JSON-объектом в формате из системного промпта. Никакого текста вне JSON, без ```."
    : "Передай патч одним вызовом инструмента StructuredOutput. Не пиши текст до или после вызова.";
  return [
    `Время звонка: ${fmtT(tNowSec)}. Ниже текущее состояние и транскрипт за последние ${windowMin} мин.`,
    "",
    "## Текущее состояние",
    "```json",
    JSON.stringify(state, null, 1),
    "```",
    "",
    "## Транскрипт",
    ...lines,
    "",
    tail,
  ].join("\n");
}
