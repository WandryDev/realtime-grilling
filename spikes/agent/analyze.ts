// Aggregates runs/<label>.jsonl into latency/usage/quality tables (markdown).
// Usage: bun spikes/agent/analyze.ts [label ...]   (default: all non-probe runs)
//        bun spikes/agent/analyze.ts --examples LABEL   (print parsed outputs)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RUNS, SCHEDULE_MIN, loadTranscript, read, windowSegments } from "./lib.ts";

// ---------- helpers ----------
const pct = (xs: number[], p: number): number => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1);
  return s[Math.max(0, idx)];
};
const mean = (xs: number[]): number =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
const s1 = (ms: number): string => (Number.isNaN(ms) ? "—" : (ms / 1000).toFixed(1));
const k1 = (n: number): string => (Number.isNaN(n) ? "—" : (n / 1000).toFixed(1));

// ---------- tiny JSON Schema validator (subset used by patch.schema.json) ----------
type Schema = Record<string, any>;
const ROOT: Schema = JSON.parse(read("patch.schema.json"));
function validate(v: unknown, sc: Schema, path = "$"): string[] {
  if (sc.$ref) return validate(v, ROOT.$defs[sc.$ref.split("/").at(-1)], path);
  if (sc.anyOf) {
    const errs = sc.anyOf.map((s: Schema) => validate(v, s, path));
    return errs.some((e: string[]) => e.length === 0) ? [] : [`${path}: no anyOf branch matched (${errs.map((e: string[]) => e[0]).join(" | ")})`];
  }
  const types: string[] = Array.isArray(sc.type) ? sc.type : sc.type ? [sc.type] : [];
  const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (types.length && !types.includes(actual)) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  if (sc.enum && !sc.enum.includes(v)) return [`${path}: ${String(v)} not in enum`];
  const out: string[] = [];
  if (actual === "object") {
    const o = v as Record<string, unknown>;
    for (const r of sc.required ?? []) if (!(r in o)) out.push(`${path}.${r}: missing`);
    for (const [key, val] of Object.entries(o)) {
      if (sc.properties?.[key]) out.push(...validate(val, sc.properties[key], `${path}.${key}`));
      else if (sc.additionalProperties === false) out.push(`${path}.${key}: additional property`);
    }
  }
  if (actual === "array") {
    const a = v as unknown[];
    if (sc.minItems !== undefined && a.length < sc.minItems) out.push(`${path}: < minItems`);
    if (sc.maxItems !== undefined && a.length > sc.maxItems) out.push(`${path}: > maxItems`);
    if (sc.items) a.forEach((x, i) => out.push(...validate(x, sc.items, `${path}[${i}]`)));
  }
  return out;
}

// ---------- fuzzy quote match ----------
const norm = (s: string): string =>
  s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();
function lev(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
/** Best similarity of quote against any same-length window of source (0..1). */
function partialRatio(quote: string, source: string): number {
  const q = norm(quote);
  const s = norm(source);
  if (!q) return 0;
  if (s.includes(q)) return 1;
  if (q.length >= s.length) return 1 - lev(q, s) / Math.max(q.length, s.length);
  let best = 0;
  for (let i = 0; i + q.length <= s.length; i++) {
    best = Math.max(best, 1 - lev(q, s.slice(i, i + q.length)) / q.length);
    if (best === 1) break;
  }
  return best;
}
const FUZZY_OK = 0.8;

// ---------- sources ----------
const SEGS = loadTranscript();
const SEG_BY_ID = new Map(SEGS.map((s) => [s.id, s]));
const DOC_SRC = new Map<string, string>();
for (const line of `${read("brief.md")}\n${read("people.md")}`.split("\n")) {
  const m = /^- ([BP]\d+)\. (.+)$/.exec(line.trim());
  if (m) DOC_SRC.set(m[1], m[2]);
}
const STATE = JSON.parse(read("state.json"));
const OPEN_Q = new Set<string>(STATE.open_questions.map((q: any) => q.id));
const CARDS = new Set<string>(STATE.cards.map((c: any) => c.id));

// ---------- per-run parsing ----------
interface Rec { [k: string]: any }
function parseOutput(r: Rec): { obj: any; how: string } {
  if (r.cfg.out === "schema") return r.structured ? { obj: r.structured, how: "structured" } : { obj: null, how: "missing" };
  const txt = String(r.result ?? "").trim();
  try {
    return { obj: JSON.parse(txt), how: "strict" };
  } catch {
    const m = /\{[\s\S]*\}/.exec(txt);
    if (m) {
      try {
        return { obj: JSON.parse(m[0]), how: "extracted" };
      } catch {
        /* fallthrough */
      }
    }
    return { obj: null, how: "invalid" };
  }
}

interface Quality {
  parsed: number; strict: number; schemaOk: number; empty: number; ops: number;
  questions: number; tooManyQ: number; ev: number; evInWindow: number; evInDoc: number;
  evOutside: number; evUnknown: number; quoteOk: number; quoteChecked: number;
  updMeChannel: number; updEv: number; badQid: number; badCard: number; marks: number; creates: number; updates: number;
  questionsDroppedByFilter: number;
}
function quality(recs: Rec[]): Quality {
  const q: Quality = { parsed: 0, strict: 0, schemaOk: 0, empty: 0, ops: 0, questions: 0, tooManyQ: 0, ev: 0, evInWindow: 0, evInDoc: 0, evOutside: 0, evUnknown: 0, quoteOk: 0, quoteChecked: 0, updMeChannel: 0, updEv: 0, badQid: 0, badCard: 0, marks: 0, creates: 0, updates: 0, questionsDroppedByFilter: 0 };
  for (const r of recs) {
    const { obj, how } = parseOutput(r);
    if (!obj) continue;
    q.parsed++;
    if (how === "strict" || how === "structured") q.strict++;
    if (validate(obj, ROOT).length === 0) q.schemaOk++;
    const ops: any[] = Array.isArray(obj.ops) ? obj.ops : [];
    if (ops.length === 0) q.empty++;
    q.ops += ops.length;
    const win = new Set(windowSegments(SEGS, r.tNow, r.cfg.window).map((s) => s.id));
    const created = new Set(ops.filter((o) => o.op === "create_card").map((o) => o.card_id));
    const nq = ops.filter((o) => o.op === "add_question").length;
    q.questions += nq;
    if (nq > 2) q.tooManyQ++;
    for (const o of ops) {
      if (o.op === "mark_answered") { q.marks++; if (!OPEN_Q.has(o.question_id)) q.badQid++; }
      if (o.op === "create_card") q.creates++;
      if (o.op === "update_card") q.updates++;
      if ((o.op === "add_question" || o.op === "update_card") && !CARDS.has(o.card_id) && !created.has(o.card_id)) q.badCard++;
      let questionValid = true;
      for (const e of Array.isArray(o.evidence) ? o.evidence : []) {
        q.ev++;
        const id = String(e.source_id ?? "");
        let src: string | undefined;
        if (win.has(id)) { q.evInWindow++; src = SEG_BY_ID.get(id)?.text; }
        else if (DOC_SRC.has(id)) { q.evInDoc++; src = DOC_SRC.get(id); }
        else if (SEG_BY_ID.has(id)) { q.evOutside++; questionValid = false; }
        else { q.evUnknown++; questionValid = false; }
        if (src !== undefined) {
          q.quoteChecked++;
          if (partialRatio(String(e.quote ?? ""), src) >= FUZZY_OK) q.quoteOk++;
          else questionValid = false;
        }
        if (o.op === "update_card" && win.has(id)) { q.updEv++; if (SEG_BY_ID.get(id)?.ch === "Я") q.updMeChannel++; }
      }
      if (o.op === "add_question" && !questionValid) q.questionsDroppedByFilter++;
    }
  }
  return q;
}

// ---------- main ----------
const args = process.argv.slice(2);
if (args[0] === "--examples") {
  const recs: Rec[] = readFileSync(join(RUNS, `${args[1]}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const kk of args.slice(2).map(Number)) {
    const r = recs.find((x) => x.k === kk) ?? recs[kk];
    console.log(`### ${args[1]} k=${r.k} (t=${r.tNow}s)\n\`\`\`json\n${JSON.stringify(parseOutput(r).obj, null, 1)}\n\`\`\``);
  }
  process.exit(0);
}
const labels = args.length
  ? args
  : readdirSync(RUNS).filter((f) => f.endsWith(".jsonl") && !f.startsWith("probe")).map((f) => f.replace(/\.jsonl$/, "")).sort();

const lat: string[] = ["| Конфигурация | n | timeout/err | wall p50 | wall p95 | init p50 | TTFT p50 | TTFT p95 | 1-й вывод p50 | холодный wall | тёплые wall p50 | API-запросов/вызов |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
const tok: string[] = ["| Конфигурация | input | cache write | cache read | output (в т.ч. thinking) | cache hit тёплых | side-вызов, вх. ток. | $/вызов холодный | $/вызов тёплый | $/вызов-час @180 | $/вызов-час @90 | ток./вызов-час @180 |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
const qual: string[] = ["| Конфигурация | валидный JSON | строго (без чистки) | по схеме | пустых патчей | ops/вызов | вопросов/вызов | >2 вопросов | evidence в окне/брифе | вне окна | несуществ. ID | цитата ≥0.8 | факты из «Я» | вопросов отсеет фильтр |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
const rl: string[] = [];

for (const label of labels) {
  const recs: Rec[] = readFileSync(join(RUNS, `${label}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ok = recs.filter((r) => !r.timedOut && !r.isError);
  const wall = ok.map((r) => r.timings.exit);
  const ttft = ok.map((r) => r.timings.firstToken).filter((x) => x !== undefined);
  const fo = ok.map((r) => r.timings.firstOutput).filter((x) => x !== undefined);
  const init = ok.map((r) => r.timings.init).filter((x) => x !== undefined);
  const cold = ok[0];
  const warm = ok.slice(1);
  lat.push(`| ${label} | ${recs.length} | ${recs.filter((r) => r.timedOut).length}/${recs.filter((r) => r.isError).length} | ${s1(pct(wall, 50))} | ${s1(pct(wall, 95))} | ${s1(pct(init, 50))} | ${s1(pct(ttft, 50))} | ${s1(pct(ttft, 95))} | ${s1(pct(fo, 50))} | ${s1(cold?.timings.exit)} | ${s1(pct(warm.map((r) => r.timings.exit), 50))} | ${mean(ok.map((r) => r.apiRequests)).toFixed(1)} |`);

  const main = (r: Rec) => r.usage ?? {};
  const side = (r: Rec): number => Object.entries(r.modelUsage ?? {}).filter(([m]) => m !== r.init?.model).reduce((a, [, u]: any) => a + u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens, 0);
  const hit = (r: Rec): number => { const u = main(r); return u.cacheRead / (u.input + u.cacheCreate + u.cacheRead); };
  const totIn = (r: Rec): number => { const u = main(r); return u.input + u.cacheCreate + u.cacheRead + side(r); };
  const warmCost = mean(warm.map((r) => r.costUsd));
  const tokPerCall = mean(warm.map((r) => totIn(r) + main(r).output));
  tok.push(`| ${label} | ${mean(ok.map((r) => main(r).input)).toFixed(0)} | ${k1(mean(ok.map((r) => main(r).cacheCreate)))}k | ${k1(mean(ok.map((r) => main(r).cacheRead)))}k | ${mean(ok.map((r) => main(r).output)).toFixed(0)} (${mean(ok.map((r) => main(r).thinking ?? 0)).toFixed(0)}) | ${(100 * mean(warm.map(hit))).toFixed(0)}% | ${k1(mean(ok.map(side)))}k | ${cold?.costUsd?.toFixed(4)} | ${warmCost.toFixed(4)} | ${(warmCost * 180).toFixed(2)} | ${(warmCost * 90).toFixed(2)} | ${((tokPerCall * 180) / 1e6).toFixed(2)}M |`);

  if (!recs[0].cfg.trivial) {
    const q = quality(recs);
    const n = recs.length;
    const p = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(0)}%` : "—");
    qual.push(`| ${label} | ${q.parsed}/${n} | ${q.strict}/${n} | ${q.schemaOk}/${n} | ${q.empty}/${q.parsed} | ${(q.ops / Math.max(1, q.parsed)).toFixed(1)} | ${(q.questions / Math.max(1, q.parsed)).toFixed(1)} | ${q.tooManyQ} | ${p(q.evInWindow + q.evInDoc, q.ev)} | ${q.evOutside} | ${q.evUnknown} | ${p(q.quoteOk, q.quoteChecked)} | ${q.updMeChannel}/${q.updEv} | ${q.questionsDroppedByFilter}/${q.questions} |`);
  }
  const first = recs[0].rateLimit?.unifiedWindows;
  const last = recs.at(-1).rateLimit?.unifiedWindows;
  if (first && last) rl.push(`| ${label} | ${first.five_hour?.utilization} → ${last.five_hour?.utilization} | ${first.seven_day?.utilization} → ${last.seven_day?.utilization} |`);
}

console.log(`## Задержка (секунды; wall = от spawn до выхода процесса)\n\n${lat.join("\n")}\n`);
console.log(`## Токены и стоимость (средние на вызов; $ = total_cost_usd, API-эквивалент)\n\n${tok.join("\n")}\n`);
console.log(`## Качество вывода\n\n${qual.join("\n")}\n`);
console.log(`## rate_limit_event (utilization, начало → конец прогона)\n\n| Конфигурация | 5h | 7d |\n|---|---|---|\n${rl.join("\n")}\n`);
console.log(`(расписание вызовов, мин: ${SCHEDULE_MIN.join(", ")}; fuzzy-порог цитаты ${FUZZY_OK})`);
