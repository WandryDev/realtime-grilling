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
  Proposal,
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
const { TaskCardsPage } = await import(
  "@/features/post-call/pages/task-cards-page"
);
const { ProposalsPage } = await import(
  "@/features/post-call/pages/proposals-page"
);
const { HistoryPage } = await import("@/features/post-call/pages/history-page");
const { PersonPage } = await import("@/features/projects/pages/person-page");
const { toast } = await import("@/components/ui/toast");
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
const CLICKUP_SOON = /Отправить в ClickUp\s*скоро/u;
const PROPOSALS_NAV = /^Предложения/u;

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

const NEXT = [
  {
    field: "acceptance" as const,
    gap: "empty" as const,
    text: "Какие критерии готовности у обмена?",
    topicId: TOPIC,
  },
];

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
    ).toBe(routes.callTranscript(CALL, `${RECORDING}@240000@s-4`));
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

function openCards() {
  nav.search = new URLSearchParams({ id: CALL });
  return render(<TaskCardsPage />);
}

/** Two people of the client on the call. */
async function withBothPeople() {
  const call = fake.db.calls.find((item) => item.id === CALL);
  if (call) {
    call.participantIds = [IGOR, NATALIA];
  }
  await act(() => refreshCalls());
}

describe("«Карточки задач» in Tauri", () => {
  it("Карточка после сборки: one card of the topic with its facts on seven lenses", async () => {
    records();
    openCards();

    const card = await screen.findByRole("region", {
      name: "Обмен без паспорта",
    });
    expect(within(card).getByText("обсуждали 12:01–12:20")).toBeTruthy();
    expect(within(card).getByText("Обмен до 1000 $ без паспорта")).toBeTruthy();
    expect(within(card).getAllByRole("term")).toHaveLength(7);
    // An empty lens shows its open question.
    expect(
      within(card).getByText("Какой лимит обмена без паспорта?")
    ).toBeTruthy();
    expect(within(card).getAllByText("Не обсуждали").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("names the one person of the client on the call, and opens the quote at its moment", async () => {
    records();
    openCards();

    fireEvent.click(
      await screen.findByRole("button", { name: "сказал(а) Игорь, 12:04" })
    );
    expect(screen.getByText("12:04:00")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Открыть в расшифровке" })
        .getAttribute("href")
    ).toBe(routes.callTranscript(CALL, `${RECORDING}@240000@s-4`));
    fireEvent.click(screen.getByRole("button", { name: "Послушать" }));
    expect(nav.push).toHaveBeenCalledWith(
      routes.callTranscript(CALL, `${RECORDING}@240000@s-4`)
    );
  });

  it("Несколько людей клиента: the source is «сказал клиент», without a name", async () => {
    await withBothPeople();
    records();
    openCards();

    expect(
      await screen.findByRole("button", { name: "сказал клиент, 12:04" })
    ).toBeTruthy();
    expect(screen.queryByText("Игорь", { exact: false })).toBeNull();
  });

  it("Итоги не собраны: the cards the fast loop made during the call", async () => {
    records({
      cards: LIVE_CARDS,
      view: { building: null, summary: failed("Нужен вход в Claude Code") },
    });
    openCards();

    const card = await screen.findByRole("region", { name: "Обмен валют" });
    expect(within(card).getByText("собрана во время звонка")).toBeTruthy();
    expect(within(card).getByText("Обмен до 1000 $ без паспорта")).toBeTruthy();
    expect(
      screen.getByText(
        "Агент предложит их по пробелам карточек, когда соберутся итоги"
      )
    ).toBeTruthy();
  });

  it("Кнопка ClickUp: decisions go to call_card_update, sending is «скоро»", async () => {
    let stored = CARD_RECORD;
    const cards = () => ({ cards: [stored], next: NEXT, source: "summary" });
    records();
    fake.answers.set("call_cards", cards);
    fake.answers.set("call_card_update", (args) => {
      const patch = args.patch as { decision?: string; title?: string };
      stored = {
        ...stored,
        decision: (patch.decision ?? stored.decision) as typeof stored.decision,
        title: patch.title ?? stored.title,
      };
      return stored;
    });
    openCards();

    const card = await screen.findByRole("region", {
      name: "Обмен без паспорта",
    });
    fireEvent.click(within(card).getByRole("button", { name: "Принять" }));
    const clickUp = (await within(card).findByRole("button", {
      name: CLICKUP_SOON,
    })) as HTMLButtonElement;
    expect(clickUp.disabled).toBe(true);
    expect(invokedWith("call_card_update")).toEqual([
      { callId: CALL, cardId: CARD, patch: { decision: "accepted" } },
    ]);

    fireEvent.click(within(card).getByRole("button", { name: "Изменить" }));
    const input = await screen.findByRole("textbox", {
      name: "Название карточки",
    });
    fireEvent.change(input, { target: { value: "Лимит без паспорта" } });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(
      await screen.findByRole("region", { name: "Лимит без паспорта" })
    ).toBeTruthy();
    expect(invokedWith("call_card_update").at(-1)).toEqual({
      callId: CALL,
      cardId: CARD,
      patch: { title: "Лимит без паспорта" },
    });

    // «Спросить в следующий раз» from the gaps of the cards.
    const next = screen.getByRole("complementary", {
      name: "Спросить в следующий раз",
    });
    expect(within(next).getByText("из пустого поля")).toBeTruthy();
    expect(
      within(next).getByText("Какие критерии готовности у обмена?")
    ).toBeTruthy();
  });
});

const proposalOf = (
  id: string,
  decision: Proposal["decision"],
  patch: Partial<Proposal> = {}
): Proposal => ({
  after: "USD МІКС — курс межбанка на утро",
  applied: null,
  before: null,
  callId: CALL,
  createdAt: STARTED_AT,
  decidedAt: decision === "pending" ? null : STARTED_AT,
  decision,
  edited: null,
  evidence: [evidence("s-1", 1, "Курс берём из USD МІКС")],
  field: "glossary",
  id,
  kind: "said",
  personId: null,
  target: "brief",
  updatedAt: STARTED_AT,
  ...patch,
});

/** Five proposals of the call, two of them accepted. */
function fiveProposals() {
  return [
    proposalOf("p-1", "accepted"),
    proposalOf("p-2", "pending", {
      after: "Обмен до 1000 $",
      field: "product",
    }),
    proposalOf("p-3", "pending", { after: "Python", field: "stack" }),
    proposalOf("p-4", "accepted", {
      after: "Кассир-администратор",
      field: "role",
      personId: IGOR,
      target: "person",
    }),
    proposalOf("p-5", "pending", {
      after: "4",
      before: "2",
      evidence: [],
      field: "tech",
      kind: "inferred",
      personId: IGOR,
      target: "person",
    }),
  ];
}

function openProposals() {
  nav.search = new URLSearchParams({ id: CALL });
  return render(<ProposalsPage />);
}

/** The count next to «Предложения» in the call's sidebar. */
async function sidebarPending() {
  const sections = await screen.findByRole("navigation", {
    name: "Разделы звонка",
  });
  return within(sections).getByRole("link", { name: PROPOSALS_NAV })
    .textContent;
}

describe("«Предложения» in Tauri", () => {
  it("Счётчик: five proposals, two accepted — «3» everywhere", async () => {
    records();
    fake.answers.set("proposals_list", fiveProposals);

    const review = openProposals();
    expect(await screen.findByText("разобрано 2 из 5")).toBeTruthy();
    const tally = screen.getByRole("complementary", { name: "Решения" });
    expect(
      within(tally).getByText("Ждут решения").nextSibling?.textContent
    ).toBe("3");
    expect(await sidebarPending()).toBe("Предложения3 ждут решения");
    review.unmount();

    const summary = openSummary();
    await screen.findByText(READY.tldr);
    expect(await sidebarPending()).toBe("Предложения3 ждут решения");
    const card = screen
      .getByRole("heading", { name: "Предложения обновить знания" })
      .closest("div");
    expect(card?.textContent).toContain("3");
    summary.unmount();

    nav.search = new URLSearchParams({ project: EXCHANGE });
    render(<HistoryPage />);
    expect(await screen.findByText("3 предложения")).toBeTruthy();
  });

  it("groups by the brief and the people, and decides through the commands", async () => {
    records();
    let list = fiveProposals();
    fake.answers.set("proposals_list", () => list);
    fake.answers.set("proposal_decide", (args) => {
      const input = args.input as {
        decision: Proposal["decision"];
        edited?: string;
      };
      list = list.map((item) =>
        item.id === args.id
          ? { ...item, decision: input.decision, edited: input.edited ?? null }
          : item
      );
      return list.find((item) => item.id === args.id);
    });
    openProposals();

    expect(
      await screen.findByRole("heading", { name: "Бриф проекта" })
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Игорь Смирнов" })).toBeTruthy();
    const tech = screen.getByRole("article", { name: "Технический уровень" });
    expect(within(tech).getByText("2 из 5")).toBeTruthy();
    expect(within(tech).getByText("4 из 5")).toBeTruthy();
    expect(within(tech).getByText("вывод агента")).toBeTruthy();
    const product = screen.getByRole("article", { name: "Раздел «Продукт»" });
    expect(within(product).getByText("сказал(а) Игорь, 12:01")).toBeTruthy();

    // «Изменить и принять» with the manager's level.
    fireEvent.click(within(tech).getByRole("button", { name: "Изменить" }));
    const editor = await screen.findByRole("textbox", { name: "Новый текст" });
    fireEvent.change(editor, { target: { value: "3 из 5" } });
    fireEvent.keyDown(editor, { ctrlKey: true, key: "Enter" });
    await waitFor(() =>
      expect(invokedWith("proposal_decide")).toEqual([
        { id: "p-5", input: { decision: "accepted", edited: "3" } },
      ])
    );

    // Keys: X rejects the current one.
    await screen.findByText("разобрано 3 из 5");
    fireEvent.keyDown(window, { key: "x" });
    await waitFor(() =>
      expect(invokedWith("proposal_decide").at(-1)).toEqual({
        id: "p-2",
        input: { decision: "rejected" },
      })
    );
  });

  it("notes over the limit: the proposal stays pending and the reason is shown", async () => {
    const add = vi.spyOn(toast, "add");
    records();
    fake.answers.set("proposals_list", fiveProposals);
    fake.failures.set("proposal_decide", {
      kind: "Invalid",
      message: "Заметки проекта длиннее 50 000 символов",
    });
    openProposals();

    const product = await screen.findByRole("article", {
      name: "Раздел «Продукт»",
    });
    fireEvent.click(within(product).getByRole("button", { name: "Принять" }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Заметки проекта длиннее 50 000 символов",
          title: "Не удалось принять предложение",
        })
      )
    );
    expect(
      screen.getByRole("article", { name: "Раздел «Продукт»" })
    ).toBeTruthy();
    expect(screen.getByText("разобрано 2 из 5")).toBeTruthy();
    add.mockRestore();
  });

  it("an undo Rust refuses («Поле изменили после принятия») changes nothing and says why", async () => {
    const add = vi.spyOn(toast, "add");
    records();
    fake.answers.set("proposals_list", fiveProposals);
    fake.failures.set("proposal_undo", {
      kind: "Invalid",
      message: "Поле изменили после принятия",
    });
    openProposals();

    await screen.findByText("разобрано 2 из 5");
    fireEvent.click(screen.getAllByRole("button", { name: "Отменить" })[0]);
    await waitFor(() =>
      expect(invokedWith("proposal_undo")).toEqual([{ id: "p-1" }])
    );
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Поле изменили после принятия",
          title: "Не удалось отменить решение",
        })
      )
    );
    expect(screen.getByText("разобрано 2 из 5")).toBeTruthy();
    add.mockRestore();
  });

  it("Звонок без проекта: «Предложений нет»", async () => {
    const call = fake.db.calls.find((item) => item.id === CALL);
    if (call) {
      call.projectId = null;
      call.participantIds = [];
    }
    await act(() => refreshCalls());
    records();
    openProposals();

    expect(
      await screen.findByRole("heading", { name: "Предложений нет" })
    ).toBeTruthy();
    expect(
      screen.getByText(
        "У звонка без проекта нет брифа и профилей, предлагать нечего."
      )
    ).toBeTruthy();
  });

  it("Предложение по Игорю: his pending proposal on his page, with the call's review", async () => {
    records();
    fake.answers.set("proposals_for_person", (args) =>
      args.personId === IGOR ? [fiveProposals()[4]] : []
    );
    nav.search = new URLSearchParams({ id: IGOR, project: EXCHANGE });
    render(<PersonPage />);

    const suggestion = await screen.findByRole("region", {
      name: "Предложение после звонка 19 октября",
    });
    expect(within(suggestion).getByText("Технический уровень")).toBeTruthy();
    expect(within(suggestion).getByText("+ 4 из 5")).toBeTruthy();
    expect(
      within(suggestion)
        .getByRole("link", { name: "Разобрать в звонке" })
        .getAttribute("href")
    ).toBe(routes.callProposals(CALL));
    expect(invokedWith("proposals_for_person")).toEqual([{ personId: IGOR }]);
  });
});
