import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CallCards,
  CallQuestion,
  CallRecording,
  CallSummary,
  CallSummaryView,
  SummaryProgress,
} from "@/bindings";

/*
 * The post-call pages of a real call in Tauri mode, over the fake IPC
 * (./helpers/fake-tauri.ts): what each page reads from the post-call
 * commands, the build Rust runs, and the commands the decisions call.
 * Every test answers the commands of its records itself.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: fake.listen }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/calls/summary",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: nav.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => nav.search,
}));

const { fakeCall, fakePerson, fakeProject, IDLE_SESSION } = await import(
  "./helpers/fake-tauri"
);
const { CallSummaryPage } = await import(
  "@/features/post-call/pages/call-summary-page"
);
const { refreshProjects } = await import("@/data/projects");
const { refreshPeople } = await import("@/data/people");
const { refreshCalls } = await import("@/data/calls");
const { routes } = await import("@/lib/routes");

const EXCHANGE = "019a0000-0000-7000-8000-000000000002";
const IGOR = "019a0000-0000-7000-8000-0000000000a2";
const NATALIA = "019a0000-0000-7000-8000-0000000000a3";
/** A new call per test: the per-call stores live on between tests. */
let CALL = "";
let calls = 0;
const RECORDING = "019a0000-0000-7000-8000-0000000000aa";
const FAST_TOPIC = "019a0000-0000-7000-8000-0000000000f1";
const TOPIC = "019a0000-0000-7000-8000-0000000000b1";
const CARD = "019a0000-0000-7000-8000-0000000000d1";

/** The recording starts at 12:00:00 local time. */
const STARTED_AT = new Date(2026, 9, 19, 12, 0, 0).getTime();
const MINUTE = 60_000;

const LOGIN = "Итоги не собраны: нужен вход в Claude Code";

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

const segment = (id: string, minute: number, text: string) => ({
  callId: CALL,
  channel: "others" as const,
  createdAt: STARTED_AT,
  endMs: minute * MINUTE + 5000,
  id,
  pass: "refined" as const,
  recordingId: RECORDING,
  startMs: minute * MINUTE,
  text,
  updatedAt: STARTED_AT,
});

const RECORDINGS: CallRecording[] = [
  {
    audioDeleted: false,
    durationMs: 30 * MINUTE,
    endedAt: STARTED_AT + 30 * MINUTE,
    id: RECORDING,
    meBytes: 4_000_000,
    othersBytes: 5_000_000,
    pass: "refined",
    segments: [
      segment("s-1", 1, "Курс берём из USD МІКС каждое утро"),
      segment("s-4", 4, "Обмен до тысячи долларов без паспорта"),
      segment("s-20", 20, "Кассиров у нас трое на смене"),
    ],
    startedAt: STARTED_AT,
    transcriptState: "refined",
  },
];

const question = (
  id: string,
  status: CallQuestion["status"],
  priority: number,
  text: string
): CallQuestion => ({
  answer: null,
  answerEvidence: null,
  cardField: "users",
  cardId: null,
  createdAt: STARTED_AT + priority,
  description: "",
  evidence: [],
  gapType: "empty",
  id,
  moment: null,
  priority,
  recordingId: RECORDING,
  status,
  text,
  topicId: FAST_TOPIC,
  updatedAt: STARTED_AT,
});

const QUESTIONS: CallQuestion[] = [
  question("q-open", "open", 2, "Кто считает курс в выходные?"),
  question("q-asked", "asked", 3, "Что делать с купюрами старого образца?"),
  question("q-first", "open", 1, "Какой лимит обмена без паспорта?"),
  question("q-answered", "answered", 1, "Сколько кассиров на смене?"),
  question("q-hidden", "hidden", 1, "Есть ли у вас сайт?"),
];

const evidence = (segmentId: string, minute: number, quote: string) => ({
  quote,
  recordingId: RECORDING,
  segmentId,
  startMs: minute * MINUTE,
});

const CARD_RECORD = {
  decision: "pending" as const,
  fields: [
    {
      facts: [
        {
          evidence: [evidence("s-4", 4, "Обмен до тысячи долларов")],
          source: "client" as const,
          status: "confirmed" as const,
          text: "Обмен до 1000 $ без паспорта",
        },
      ],
      field: "goal" as const,
    },
  ],
  id: CARD,
  title: "Обмен без паспорта",
  topicId: TOPIC,
};

const READY: CallSummary = {
  builtAt: STARTED_AT + 31 * MINUTE,
  callId: CALL,
  content: {
    cards: [CARD_RECORD],
    next: [],
    topics: [
      {
        from: {
          endMs: MINUTE + 5000,
          recordingId: RECORDING,
          segmentId: "s-1",
          startMs: MINUTE,
        },
        id: TOPIC,
        points: [
          {
            evidence: [evidence("s-4", 4, "Обмен до тысячи долларов")],
            status: "fact",
            text: "Без паспорта меняют до 1000 долларов.",
          },
          {
            evidence: [evidence("s-20", 20, "Кассиров у нас трое")],
            status: "assumption",
            text: "Кассиров трое, но смен две.",
          },
        ],
        title: "Обмен валют",
        to: {
          endMs: 20 * MINUTE + 5000,
          recordingId: RECORDING,
          segmentId: "s-20",
          startMs: 20 * MINUTE,
        },
        topicIds: [FAST_TOPIC],
      },
    ],
  },
  createdAt: STARTED_AT,
  error: null,
  state: "ready",
  title: "Курсы и обмен без паспорта",
  tldr: "Курс берут из USD МІКС, без паспорта меняют до тысячи долларов.",
  transcriptPass: "refined",
  updatedAt: STARTED_AT,
};

const failed = (error: string): CallSummary => ({
  ...READY,
  builtAt: null,
  content: null,
  error,
  state: "failed",
  title: "",
  tldr: "",
  transcriptPass: null,
});

const LIVE_CARDS: CallCards = {
  cards: [{ ...CARD_RECORD, title: "Обмен валют", topicId: FAST_TOPIC }],
  next: [],
  source: "live",
};

const progress = (
  stage: SummaryProgress["stage"],
  status: "running" | "done"
): SummaryProgress => ({
  callId: CALL,
  counts: {
    proposals: null,
    segments: 3,
    topics: 1,
    transcriptPass: "refined",
  },
  stage,
  state: { status },
});

/** Answers the post-call commands of the call with these records. */
function records({
  cards = { ...LIVE_CARDS, cards: [CARD_RECORD], source: "summary" },
  view = { building: null, summary: READY },
}: {
  cards?: CallCards;
  view?: CallSummaryView;
} = {}) {
  fake.answers.set("summary_get", () => view);
  fake.answers.set("call_transcript", () => RECORDINGS);
  fake.answers.set("call_questions", () => QUESTIONS);
  fake.answers.set("call_cards", () => cards);
  fake.answers.set("proposals_list", () => []);
  fake.answers.set("summary_build", () => null);
  fake.answers.set("summary_cancel", () => null);
}

function openSummary() {
  nav.search = new URLSearchParams({ id: CALL });
  return render(<CallSummaryPage />);
}

beforeEach(async () => {
  calls += 1;
  CALL = `019a0000-0000-7000-8000-0000000c${String(calls).padStart(4, "0")}`;
  nav.push.mockReset();
  fake.failures.clear();
  fake.answers.clear();
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(EXCHANGE, "Обменник")
  );
  fake.db.people.splice(
    0,
    fake.db.people.length,
    fakePerson(IGOR, EXCHANGE, "Игорь Смирнов"),
    fakePerson(NATALIA, EXCHANGE, "Наталья Ким")
  );
  fake.db.calls.splice(0, fake.db.calls.length, {
    ...fakeCall(CALL, EXCHANGE, ""),
    endedAt: STARTED_AT + 30 * MINUTE,
    participantIds: [IGOR],
    startedAt: STARTED_AT,
  });
  act(() => fake.setSession(IDLE_SESSION));
  await act(() => refreshProjects());
  await act(() => refreshPeople());
  await act(() => refreshCalls());
  fake.invoked.length = 0;
});

describe("«Итоги звонка» in Tauri", () => {
  it("Итоги готовы: the title, TL;DR, topics with points leading to their phrases", async () => {
    records();
    openSummary();

    expect(await screen.findByText("Курсы и обмен без паспорта")).toBeTruthy();
    expect(screen.getByText(READY.tldr)).toBeTruthy();
    expect(
      screen.getByRole("heading", { level: 2, name: "Обмен валют" })
    ).toBeTruthy();
    expect(screen.getByText("12:01–12:20")).toBeTruthy();
    expect(
      screen.getByText("Без паспорта меняют до 1000 долларов.")
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Открыть расшифровку на 12:04" })
        .getAttribute("href")
    ).toBe(routes.callTranscript(CALL, "s-4"));
    expect(
      screen.getByText("Допущение, проверить на следующем звонке")
    ).toBeTruthy();
    expect(screen.queryByText("по живой расшифровке")).toBeNull();
    // No integrations yet: no «Ответы для ClickUp».
    expect(
      screen.queryByRole("heading", { name: "Ответы для ClickUp" })
    ).toBeNull();
  });

  it("Три вопроса остались: open and asked ones, the most important first, counted from the records", async () => {
    records();
    openSummary();

    const list = await screen.findByRole("list", {
      name: "Не успели спросить",
    });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Не успели спросить: Какой лимит обмена без паспорта?Обмен валют, самый важный",
      "Не успели спросить: Кто считает курс в выходные?Обмен валют",
      "Не успели спросить: Что делать с купюрами старого образца?Обмен валют, спросили, ответа не было",
    ]);
    expect(screen.getByText("1 тема")).toBeTruthy();
    expect(screen.getByText("1 вопрос закрыт")).toBeTruthy();
    expect(screen.getByText("3 не успели спросить")).toBeTruthy();
    // The right column's card and the sidebar count come from the records.
    expect(screen.getByText("Обмен без паспорта")).toBeTruthy();
    expect(screen.getByText("1 подтверждено, 6 пусто")).toBeTruthy();
  });

  it("marks a summary built from the live transcript", async () => {
    records({
      view: { building: null, summary: { ...READY, transcriptPass: "mixed" } },
    });
    openSummary();

    expect(await screen.findByText("по живой расшифровке")).toBeTruthy();
  });

  it("Агент не вошёл: «Итоги не собраны» with the reason, «Собрать итоги», and what the records give", async () => {
    records({
      cards: LIVE_CARDS,
      view: { building: null, summary: failed("Нужен вход в Claude Code") },
    });
    openSummary();

    expect(await screen.findByText(LOGIN)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Коротко" })).toBeNull();
    const list = await screen.findByRole("list", {
      name: "Не успели спросить",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    // The fast loop's card, before a summary.
    expect(
      within(screen.getByRole("region", { name: "Карточки задач" })).getByText(
        "Обмен валют"
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Собрать итоги" }));
    await waitFor(() =>
      expect(invokedWith("summary_build")).toEqual([{ callId: CALL }])
    );
  });

  it("Сбой во время сборки: an interrupted build offers «Собрать итоги»", async () => {
    records({ view: { building: null, summary: failed("interrupted") } });
    openSummary();

    expect(
      await screen.findByText(
        "Итоги не собраны: сборку прервал перезапуск приложения"
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Собрать итоги" })).toBeTruthy();
  });

  it("Перезагрузка окна во время сборки: the same stage, then the summary when the build ends", async () => {
    records({
      view: {
        building: progress("summary", "running"),
        summary: { ...READY, state: "building" },
      },
    });
    openSummary();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Собираю итоги" })
    ).toBeTruthy();
    const steps = screen.getByRole("list", { name: "Шаги" });
    const rows = within(steps).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent?.split(":")[0])).toEqual([
      "готово",
      "в работе",
      "ждёт",
      "ждёт",
    ]);
    expect(rows[0]?.textContent).toContain("3 реплики, 1 тема");
    expect(rows[1]?.textContent).toContain("Собираю итоги и карточки задач");
    expect(steps.textContent).not.toContain("ClickUp");

    // The build goes on to the proposals, then ends.
    act(() => fake.emit("summary-progress", progress("proposals", "running")));
    await waitFor(() =>
      expect(
        within(steps)
          .getAllByRole("listitem")
          .map((row) => row.textContent?.split(":")[0])
      ).toEqual(["готово", "готово", "в работе", "ждёт"])
    );
    records();
    act(() => fake.emit("summary-progress", progress("saving", "done")));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Итоги звонка" })
    ).toBeTruthy();
    expect(await screen.findByText(READY.tldr)).toBeTruthy();
  });

  it("«Остановить» stops the build", async () => {
    records({
      view: { building: progress("transcript", "running"), summary: null },
    });
    openSummary();

    fireEvent.click(await screen.findByRole("button", { name: "Остановить" }));
    await waitFor(() =>
      expect(invokedWith("summary_cancel")).toEqual([{ callId: CALL }])
    );
  });
});
