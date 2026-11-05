import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CallQuestion,
  CallRecording,
  CallSearch,
  CallSummaryView,
  Proposal,
} from "@/bindings";

/*
 * «История звонков» in Tauri, over the fake IPC (./helpers/fake-tauri.ts)
 * (`call-history`): the calls by month, newest first by their start, each
 * with its title (or the summary's), the questions not closed, the
 * pending proposals and «аудио удалено»; the filter by a person goes by
 * id; the search is `calls_search`; a project without calls shows its
 * readiness from its data.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

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
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/history",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => search,
}));

const { fakeCall, fakePerson, fakeProject } = await import(
  "./helpers/fake-tauri"
);
const { HistoryPage } = await import("@/features/post-call/pages/history-page");
const { updatePerson } = await import("@/data/people");
const { momentParam } = await import("@/features/post-call/moment");
const { routes } = await import("@/lib/routes");

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const NEW_PROJECT = "019a0000-0000-7000-8000-000000000002";
const IGOR = "019a0000-0000-7000-8000-0000000000e1";
const OLGA = "019a0000-0000-7000-8000-0000000000e2";
const FIRST = "019a0000-0000-7000-8000-0000000000c1";
const LAST = "019a0000-0000-7000-8000-0000000000c2";
const LOOSE = "019a0000-0000-7000-8000-0000000000c3";
const LAST_RECORDING = "019a0000-0000-7000-8000-0000000000a2";

const NOV_3 = new Date(2026, 10, 3, 11, 0).getTime();
const NOV_5 = new Date(2026, 10, 5, 15, 30).getTime();
const OCT_20 = new Date(2026, 9, 20, 10, 0).getTime();
const NEWEST_FIRST = /5 ноя.*3 ноя/su;
const LAST_TITLE = /Онлайн-запись и бронь/u;
const LOOSE_TOPIC = /Тарифы связи/u;
const FIRST_TITLE = /Старт проекта/u;
const LAST_SHORT = /Онлайн-запись/u;
const OPEN_FILTER = /С открытыми вопросами/u;
const BRON_META = /Клиент, 15:51, и ещё 1/u;

fake.db.projects.push(
  fakeProject(PROJECT, "Телемедиа"),
  // A new project: a brief and a person, no documents, no calls.
  {
    ...fakeProject(NEW_PROJECT, "Школа Ритм"),
    briefBuiltAt: NOV_3,
    briefState: "fresh",
  }
);
fake.db.people.push(
  fakePerson(IGOR, PROJECT, "Игорь"),
  fakePerson(OLGA, PROJECT, "Ольга"),
  fakePerson("019a0000-0000-7000-8000-0000000000e3", NEW_PROJECT, "Марина")
);
fake.db.calls.push(
  {
    ...fakeCall(FIRST, PROJECT, "Старт проекта"),
    endedAt: NOV_3 + 600_000,
    participantIds: [IGOR],
    startedAt: NOV_3,
  },
  {
    // Not named yet: the summary's title stands in.
    ...fakeCall(LAST, PROJECT, ""),
    endedAt: NOV_5 + 900_000,
    openQuestions: 1,
    participantIds: [OLGA],
    startedAt: NOV_5,
  },
  {
    ...fakeCall(LOOSE, null, ""),
    endedAt: OCT_20 + 300_000,
    startedAt: OCT_20,
  }
);

const view = (title: string, topic?: string): CallSummaryView => ({
  building: null,
  summary: {
    builtAt: 1,
    callId: "",
    content: {
      cards: [],
      next: [],
      topics: topic
        ? [
            {
              from: { endMs: 1, recordingId: "", segmentId: "", startMs: 0 },
              id: "t1",
              points: [],
              title: topic,
              to: { endMs: 1, recordingId: "", segmentId: "", startMs: 0 },
              topicIds: [],
            },
          ]
        : [],
    },
    createdAt: 1,
    error: null,
    state: "ready",
    title,
    tldr: "",
    transcriptPass: "refined",
    updatedAt: 1,
  },
});

const question = (
  id: string,
  status: CallQuestion["status"]
): CallQuestion => ({
  answer: null,
  answerEvidence: null,
  cardField: null,
  cardId: null,
  createdAt: 1,
  description: "",
  evidence: [],
  gapType: "empty",
  id,
  moment: null,
  priority: 1,
  recordingId: LAST_RECORDING,
  status,
  text: id,
  topicId: null,
  updatedAt: 1,
});

const pending = (id: string): Proposal => ({
  after: "",
  applied: null,
  before: null,
  callId: LAST,
  createdAt: 1,
  decidedAt: null,
  decision: "pending",
  edited: null,
  evidence: [],
  field: "notes",
  id,
  kind: "said",
  personId: null,
  target: "brief",
  updatedAt: 1,
});

const deleted: CallRecording = {
  audioDeleted: true,
  durationMs: 900_000,
  endedAt: NOV_5 + 900_000,
  id: LAST_RECORDING,
  meBytes: null,
  othersBytes: null,
  pass: "refined",
  segments: [],
  startedAt: NOV_5,
  transcriptState: "refined",
};

const BRON: CallSearch = {
  matches: [
    {
      after: " на субботу, если врач свободен",
      at: NOV_5 + 1_260_000,
      before: "Можно поставить ",
      callId: LAST,
      channel: "others",
      moment: {
        recordingId: LAST_RECORDING,
        segmentId: "s-bron",
        startMs: 1_260_000,
      },
      projectId: PROJECT,
      source: "segment",
      text: "бронь",
    },
    {
      after: " отменяют за сутки",
      at: null,
      before: "Брони ",
      callId: LAST,
      channel: null,
      moment: null,
      projectId: PROJECT,
      source: "point",
      text: "Брони",
    },
  ],
  projects: [{ calls: 1, matches: 2, projectId: PROJECT }],
  total: 2,
};

beforeEach(() => {
  fake.invoked.length = 0;
  fake.answers.clear();
  fake.answers.set("summary_get", ({ callId }) =>
    callId === LAST
      ? view("Онлайн-запись и бронь")
      : view("", callId === LOOSE ? "Тарифы связи" : undefined)
  );
  fake.answers.set("proposals_list", ({ callId }) =>
    callId === LAST ? [pending("p1"), pending("p2")] : []
  );
  fake.answers.set("call_questions", ({ callId }) =>
    callId === LAST
      ? [
          question("q-open", "open"),
          question("q-asked", "asked"),
          question("q-done", "answered"),
        ]
      : []
  );
  fake.answers.set("call_transcript", ({ callId }) =>
    callId === LAST ? [deleted] : []
  );
  fake.answers.set("calls_search", () => BRON);
});

function open(query: Record<string, string> = {}) {
  search = new URLSearchParams(query);
  return render(<HistoryPage />);
}

const rowOf = (name: string | RegExp) => screen.getByRole("link", { name });

describe("call history in Tauri", () => {
  it("«Два звонка проекта»: by month, newest first, each with its title", async () => {
    open({ project: PROJECT });

    const november = await screen.findByRole("region", { name: "Ноябрь" });
    expect(within(november).getAllByRole("link")).toHaveLength(2);
    expect(november.textContent).toMatch(NEWEST_FIRST);
    const last = await within(november).findByRole("link", {
      name: LAST_TITLE,
    });
    // Open and asked are not closed; two proposals wait; no audio.
    expect(within(last).getByText("2 открытых")).toBeTruthy();
    expect(within(last).getByText("2 предложения")).toBeTruthy();
    expect(within(last).getByText("Ольга, аудио удалено")).toBeTruthy();
    expect(within(november).getByText("Старт проекта")).toBeTruthy();
  });

  it("lists a call without a project in the general history", async () => {
    open();

    // No title and no summary title: the summary's first topic.
    const row = await screen.findByRole("link", { name: LOOSE_TOPIC });
    expect(within(row).getByText("Звонок без проекта")).toBeTruthy();
  });

  it("«Фильтр по Игорю»: his calls, also after he was renamed", async () => {
    const user = userEvent.setup();
    open({ project: PROJECT });
    await screen.findByRole("tab", { name: "Игорь" });

    await act(async () => {
      await updatePerson(PROJECT, IGOR, { name: "Игорь Савчук" });
    });
    await user.click(await screen.findByRole("tab", { name: "Игорь Савчук" }));

    expect(rowOf(FIRST_TITLE)).toBeTruthy();
    expect(screen.queryByRole("link", { name: LAST_SHORT })).toBeNull();

    await user.click(screen.getByRole("tab", { name: OPEN_FILTER }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: FIRST_TITLE })).toBeNull()
    );
    expect(rowOf(LAST_TITLE)).toBeTruthy();
  });

  it("«Найти термин»: a client's phrase, opened at it", async () => {
    const user = userEvent.setup();
    open({ project: PROJECT });
    await screen.findByRole("region", { name: "Ноябрь" });

    await user.type(
      screen.getByRole("searchbox", { name: "Поиск по звонкам" }),
      "бронь"
    );

    const result = await screen.findByRole("link", {
      name: BRON_META,
    });
    expect(result.getAttribute("href")).toBe(
      routes.callTranscript(
        LAST,
        momentParam({
          recordingId: LAST_RECORDING,
          segmentId: "s-bron",
          startMs: 1_260_000,
        })
      )
    );
    expect(
      within(result).getByText("бронь", { selector: "mark" })
    ).toBeTruthy();
    expect(screen.getByText("1 звонок, 2 совпадения")).toBeTruthy();
    const last = fake.invoked
      .filter((item) => item.command === "calls_search")
      .at(-1);
    expect(last?.args).toEqual({ projectId: null, query: "бронь" });
  });

  it("«Новый проект»: the brief and the people done, no documents", async () => {
    open({ project: NEW_PROJECT });

    const readiness = await screen.findByRole("list", {
      name: "Готовность проекта",
    });
    expect(
      screen.getByRole("heading", { name: "Звонков пока не было" })
    ).toBeTruthy();
    const rows = within(readiness).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Бриф проекта собран3 ноября",
      "Документы не добавленыДобавить",
      "Люди клиента добавлены1 человек",
    ]);
  });
});
