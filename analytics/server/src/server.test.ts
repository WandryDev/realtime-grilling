import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROJECTIONS } from "./migrations";
import { rebuild } from "./rebuild";
import {
  type App,
  event,
  fixtures,
  get,
  makeApp,
  newId,
  post,
} from "./testing";

let app: App;

beforeEach(async () => {
  app = await makeApp();
});

afterEach(async () => {
  await app.dispose();
});

const count = (table: string) =>
  app.db(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql.unsafe<{ n: number }>(
        `SELECT count(*)::float8 AS n FROM ${table}`
      );
      return rows[0]?.n ?? 0;
    })
  );

/** A project, a call of it and its recording, at `at`. */
const callOf = (local: string, name: string, at = 1_795_000_000_000) => {
  const call = newId();
  const recording = newId();
  return {
    call,
    events: [
      event("project", { localId: local, name }, at),
      event(
        "call",
        {
          endedAt: at + 60_000,
          id: call,
          projectLocalId: local,
          startedAt: at,
          status: "finished",
          title: `Звонок ${name}`,
        },
        at
      ),
      event(
        "recording",
        {
          callId: call,
          endedAt: at + 60_000,
          id: recording,
          startedAt: at,
          status: "finished",
        },
        at
      ),
    ],
    recording,
  };
};

const question = (
  recordingId: string,
  id: string,
  pinned: boolean,
  at: number
) =>
  event(
    "question",
    {
      answerEvidence: null,
      cardField: "edgeCases",
      createdAt: 1_795_000_000_000,
      description: "",
      evidence: [],
      gapType: "empty",
      id,
      pinned,
      priority: 2,
      recordingId,
      shownAt: at,
      status: "open",
      text: "Сколько ждёт звонок в очереди?",
      topicId: null,
    },
    at
  );

const agentCall = (
  recordingId: string,
  kind: string,
  costUsd: number,
  extra: Record<string, unknown> = {}
) =>
  event("agentCall", {
    cacheRead: 31_000,
    cacheWrite: 0,
    callId: null,
    candidates: [],
    costUsd,
    durationMs: 9000,
    effort: null,
    error: null,
    findingsInPrompt: [],
    id: newId(),
    inputTokens: 2,
    kind,
    model: null,
    outcome: "ok",
    outputTokens: 600,
    parts: [],
    projectLocalId: null,
    queries: null,
    rawReply: null,
    recordingId,
    reply: null,
    startedAt: 1_795_000_010_000,
    trigger: "turnEnd",
    triggerSegmentId: null,
    utilization: 0.3,
    windowSegments: [],
    ...extra,
  });

describe("6.1 the frame", () => {
  it("answers an empty list of projects", async () => {
    expect(await get(app, "/api/projects")).toEqual({ body: [], status: 200 });
  });
});

describe("6.2 the intake", () => {
  it("takes every sample of the contract", async () => {
    const samples = Object.values(fixtures());
    const { status, body } = await post(app, samples);
    expect(status).toBe(200);
    expect(body.accepted).toHaveLength(samples.length);
    expect(await count("events")).toBe(samples.length);
    expect(await count("rejected_events")).toBe(0);
  });

  it("«Повтор после обрыва»: a repeated batch is kept once and acknowledged", async () => {
    const { events } = callOf("p1", "Обменник");
    await post(app, events);
    const again = await post(app, events);
    expect(again.body.accepted).toEqual(events.map((e) => e.id));
    expect(await count("events")).toBe(events.length);
    expect(await count("calls")).toBe(1);
  });

  it("«Неверное событие»: kept apart with the reason, acknowledged", async () => {
    const bad = { at: 1, body: { id: "c" }, id: newId(), kind: "call", v: 1 };
    const { body } = await post(app, [bad]);
    expect(body.accepted).toEqual([bad.id]);
    expect(await count("events")).toBe(0);
    expect(await count("calls")).toBe(0);
    expect(await count("rejected_events")).toBe(1);
  });

  it("«Событие с именем менеджера»: a field the contract lacks rejects it", async () => {
    const project = event("project", {
      localId: "p1",
      manager: "Аня",
      name: "Обменник",
    });
    const { body } = await post(app, [project]);
    expect(body.accepted).toEqual([project.id]);
    expect(await count("events")).toBe(0);
    expect(await count("rejected_events")).toBe(1);
  });

  it("«Старый клиент»: the previous version is taken, an unknown one is not", async () => {
    const old = {
      ...event("project", { localId: "p1", name: "Обменник" }),
      v: 0,
    };
    const future = {
      ...event("project", { localId: "p2", name: "Склад" }),
      v: 9,
    };
    await post(app, [old, future]);
    expect(await count("events")).toBe(1);
    expect(await count("rejected_events")).toBe(1);
  });
});

interface ProjectRow {
  calls: number;
  id: string;
  name: string;
}

describe("6.3 the projections", () => {
  it("«Два менеджера, один проект»", async () => {
    await post(app, callOf("anya-1", "Обменник").events);
    await post(app, callOf("oleg-7", "обменник ").events);
    const { body } = await get<ProjectRow[]>(app, "/api/projects");
    expect(body.map(({ name, calls }) => ({ calls, name }))).toEqual([
      { calls: 2, name: "обменник " },
    ]);
  });

  it("«Разные названия»", async () => {
    await post(app, callOf("p1", "Обменник").events);
    await post(app, callOf("p2", "Обменник 2.0").events);
    const { body } = await get<ProjectRow[]>(app, "/api/projects");
    expect(body).toHaveLength(2);
  });

  it("«ё» and «е», spaces and case are one name", async () => {
    await post(app, callOf("p1", "Жёлтый  Склад").events);
    await post(app, callOf("p2", "желтый склад").events);
    const { body } = await get<ProjectRow[]>(app, "/api/projects");
    expect(body.map((project) => project.calls)).toEqual([2]);
  });

  it("«Переименование» moves the local project's calls, the past ones too", async () => {
    await post(app, callOf("p1", "Обменник").events);
    await post(app, [
      event(
        "project",
        { localId: "p1", name: "Обменник Pro" },
        1_795_000_100_000
      ),
    ]);
    const { body } = await get<ProjectRow[]>(app, "/api/projects");
    expect(body.map(({ name, calls }) => ({ calls, name }))).toEqual([
      { calls: 1, name: "Обменник Pro" },
    ]);
  });

  it("a call without a project is «Без проекта»", async () => {
    await post(app, [
      event("call", {
        endedAt: null,
        id: newId(),
        projectLocalId: null,
        startedAt: 1,
        status: "live",
        title: "",
      }),
    ]);
    const { body } = await get<ProjectRow[]>(app, "/api/projects");
    expect(body.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "none", name: "Без проекта" },
    ]);
  });

  it("«Действие раньше вопроса»: the pinned question stays pinned", async () => {
    const { events, call, recording } = callOf("p1", "Обменник");
    await post(app, events);
    const id = newId();
    // The pin and its snapshot come first…
    await post(app, [
      event("questionEvent", {
        agentCallId: null,
        at: 1_795_000_020_000,
        id: newId(),
        questionId: id,
        recordingId: recording,
        step: "pinned",
      }),
      question(recording, id, true, 1_795_000_020_000),
    ]);
    // … the creation after.
    await post(app, [
      event("questionEvent", {
        agentCallId: null,
        at: 1_795_000_010_000,
        id: newId(),
        questionId: id,
        recordingId: recording,
        step: "created",
      }),
      question(recording, id, false, 1_795_000_010_000),
    ]);
    const { body } = await get<{
      questions: { pinned: boolean }[];
      questionSteps: { step: string }[];
    }>(app, `/api/calls/${call}`);
    expect(body.questions.map((q) => q.pinned)).toEqual([true]);
    expect(body.questionSteps.map((step) => step.step)).toEqual([
      "created",
      "pinned",
    ]);
  });

  it("«Звонок удалён в Grill»: there is no delete; the call stays", async () => {
    const { events, call } = callOf("p1", "Обменник");
    await post(app, events);
    expect((await get(app, `/api/calls/${call}`)).status).toBe(200);
  });

  it("rebuild makes the same projections from the log", async () => {
    await post(app, Object.values(fixtures()));
    const { events } = callOf("p1", "Обменник");
    await post(app, events);
    const dump = () =>
      app.db(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const tables: Record<string, unknown> = {};
          for (const table of PROJECTIONS) {
            tables[table] = yield* sql.unsafe(
              `SELECT * FROM ${table} ORDER BY 1, 2`
            );
          }
          return JSON.stringify(tables, (_, value) =>
            typeof value === "bigint" ? value.toString() : value
          );
        })
      );
    const before = await dump();
    await app.db(rebuild);
    expect(await dump()).toBe(before);
  });
});

describe("6.4 the reads", () => {
  it("«Стоимость по видам»: the cost by kind, the brief apart", async () => {
    const { events, recording } = callOf("p1", "Обменник");
    await post(app, [
      ...events,
      agentCall(recording, "fastLoop", 0.04),
      agentCall(recording, "fastLoop", 0.06),
      agentCall(recording, "slowLoop", 0.02),
      event("agentCall", {
        ...(agentCall(recording, "brief", 0.5).body as Record<string, unknown>),
        projectLocalId: "p1",
        recordingId: null,
        trigger: null,
      }),
    ]);
    const [project] = (await get<ProjectRow[]>(app, "/api/projects")).body;
    const { body } = await get<{
      costByKind: { kind: string; calls: number; costUsd: number }[];
      brief: { calls: number; costUsd: number };
      calls: { costUsd: number }[];
    }>(app, `/api/projects/${project?.id}`);
    const fast = body.costByKind.find((row) => row.kind === "fastLoop");
    expect(fast?.calls).toBe(2);
    expect(fast?.costUsd).toBeCloseTo(0.1);
    expect(
      body.costByKind.find((row) => row.kind === "slowLoop")?.costUsd
    ).toBeCloseTo(0.02);
    expect(body.brief).toMatchObject({ calls: 1, costUsd: 0.5 });
    expect(body.calls[0]?.costUsd).toBeCloseTo(0.12);
  });

  it("«Самый используемый документ»: sources by candidates, findings and grounds", async () => {
    const { events, recording } = callOf("p1", "Обменник");
    const candidate = (label: string, name: string) => ({
      chunkKey: `${name}#1`,
      headingPath: null,
      label,
      rank: 1,
      sourceKind: "outline",
      sourceName: name,
      sourceUrl: null,
      text: "фрагмент",
    });
    const finding = (name: string, questionId: string | null) =>
      event("finding", {
        agentCallId: null,
        chunkKey: `${name}#1`,
        createdAt: 1,
        evictedAt: null,
        hiddenAt: null,
        id: newId(),
        note: "Подтверждает",
        questionId,
        quote: "цитата",
        recordingId: recording,
        sourceKind: "outline",
        sourceName: name,
        sourceUrl: "https://outline.example/doc",
      });
    await post(app, [
      ...events,
      agentCall(recording, "slowLoop", 0.01, {
        candidates: [
          candidate("C1", "Регламент KYC"),
          candidate("C2", "Лимиты"),
        ],
      }),
      agentCall(recording, "slowLoop", 0.01, {
        candidates: [candidate("C1", "Регламент KYC")],
      }),
      finding("Регламент KYC", "q-1"),
      finding("Регламент KYC", null),
    ]);
    const [project] = (await get<ProjectRow[]>(app, "/api/projects")).body;
    const { body } = await get<{
      sources: {
        sourceName: string;
        candidates: number;
        findings: number;
        grounds: number;
      }[];
    }>(app, `/api/projects/${project?.id}`);
    expect(body.sources[0]).toMatchObject({
      candidates: 2,
      findings: 2,
      grounds: 1,
      sourceName: "Регламент KYC",
    });
  });

  it("«Итог звонка»: the timeline, an agent call's details, a finding", async () => {
    const all = fixtures();
    await post(app, Object.values(all));
    const { body: timeline, status } = await get<{
      questions: { id: string }[];
      agentCalls: { id: string; ops: unknown[]; promptBytes: number }[];
      segments: { id: string }[];
      costUsd: number;
    }>(app, "/api/calls/call-1");
    expect(status).toBe(200);
    expect(timeline.questions.map((q) => q.id)).toEqual(["q-1"]);
    // The refined transcript replaces the live one.
    expect(timeline.segments.map((s) => s.id)).toEqual(["ref-1"]);
    expect(timeline.agentCalls.map((c) => c.id)).toEqual(["ac-1"]);
    expect(timeline.agentCalls[0]?.ops).toHaveLength(1);
    expect(timeline.costUsd).toBeCloseTo(0.042);

    const { body: details } = await get<{
      parts: { label: string; text: string | null }[];
    }>(app, "/api/agent-calls/ac-1");
    expect(details.parts).toEqual([
      expect.objectContaining({
        label: "file",
        text: "Ты помощник аналитика на звонке.",
      }),
    ]);
    const { body: finding } = await get<{
      citedBy: string[];
      steps: unknown[];
    }>(app, "/api/findings/f-1");
    expect(finding.steps).toHaveLength(1);
    expect((await get(app, "/api/calls/nope")).status).toBe(404);
  });
});

/** Reads the SSE stream until `n` changes came or `ms` passed. */
const readChanges = async (response: Response, n: number, ms: number) => {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const changes: { seq: number; callId: string | null }[] = [];
  let text = "";
  const deadline = Date.now() + ms;
  while (reader && changes.length < n && Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: a stream is read in order
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), deadline - Date.now())
      ),
    ]);
    if (!chunk || chunk.done) {
      break;
    }
    text += decoder.decode(chunk.value);
    const blocks = text.split("\n\n");
    text = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      if (data) {
        changes.push(JSON.parse(data.slice(6)));
      }
    }
  }
  await reader?.cancel();
  return changes;
};

describe("6.5 the live changes", () => {
  it("«Идёт звонок»: a phrase reaches the call's page within 2 s", async () => {
    const { events, call, recording } = callOf("p1", "Обменник");
    await post(app, events);
    const stream = await app.fetch(
      new Request(`http://localhost/api/live?call=${call}`)
    );
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const sent = Date.now();
    const reading = readChanges(stream, 1, 2000);
    await post(app, [
      event("segment", {
        channel: "others",
        endMs: 2000,
        id: newId(),
        recordingId: recording,
        startMs: 1000,
        text: "Двести звонков в день",
      }),
    ]);
    const changes = await reading;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.callId).toBe(call);
    expect(Date.now() - sent).toBeLessThan(2000);
  });

  it("«Обрыв страницы»: what came while away comes on reconnect", async () => {
    const { events, call, recording } = callOf("p1", "Обменник");
    await post(app, events);
    const first = await app.fetch(
      new Request(`http://localhost/api/live?call=${call}&since=0`)
    );
    const seen = await readChanges(first, 2, 1000);
    const last = Math.max(...seen.map((change) => change.seq));
    // Away: two phrases come.
    await post(
      app,
      [1, 2].map((n) =>
        event("segment", {
          channel: "others",
          endMs: n * 1000 + 500,
          id: newId(),
          recordingId: recording,
          startMs: n * 1000,
          text: `Фраза ${n}`,
        })
      )
    );
    const again = await app.fetch(
      new Request(`http://localhost/api/live?call=${call}`, {
        headers: { "last-event-id": String(last) },
      })
    );
    const missed = await readChanges(again, 2, 1000);
    expect(missed).toHaveLength(2);
    expect(missed.every((change) => change.seq > last)).toBe(true);
  });
});
