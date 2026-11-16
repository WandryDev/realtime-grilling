import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CallState,
  CallStateView,
  ContextFinding,
  RecordingStatus,
} from "@/bindings";

import {
  at,
  callState,
  STATE_RECORDING,
  topic,
  visible,
} from "./helpers/call-state";

/*
 * The «Контекст» column of the call window in Tauri mode, over the fake
 * IPC (./helpers/fake-tauri.ts): built from the slow loop's findings,
 * search and sources in `call_state_get`, read again on
 * `call-state-changed`; «Убрать» goes to `context_finding_hide`; a link
 * opens the service in the default browser (agent-slow-loop design.md,
 * decision 8; specs/call-context).
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const opener = vi.hoisted(() => ({
  openUrl: vi.fn((_url: string) => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload: unknown) => {
    fake.emit(event, payload);
    return Promise.resolve();
  },
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: vi.fn(() => Promise.resolve()),
    label: "main",
    listen: fake.listen,
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => opener);
vi.mock("next/navigation", () => ({
  usePathname: () => "/call",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const { IDLE_RECORDING, IDLE_SESSION, fakeProject, liveSession } = await import(
  "./helpers/fake-tauri"
);
const { CallPage } = await import("@/features/call/pages/call-page");
const { currentCallSession, followCallSession } = await import(
  "@/data/call-session"
);
const { refreshProjects } = await import("@/data/projects");
const { refreshSettings } = await import("@/data/settings");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const RECORDING = STATE_RECORDING;

const RECORDING_NOW: RecordingStatus = {
  ...IDLE_RECORDING,
  id: RECORDING,
  startedAt: Date.now(),
};

const SOURCES = { clickup: 5, files: 2, outline: 12 };

const SHIFT_URL = "https://wiki.example.com/doc/reglament-smeny-abc";
const SHIFT_RULES: ContextFinding = {
  createdAt: at(21),
  id: "f-shift",
  note: "Подтверждает: старший смены распределяет звонки",
  questionId: null,
  quote: "Старший смены распределяет входящие звонки между операторами.",
  sourceKind: "outline",
  sourceName: "Регламент смены",
  sourceUrl: SHIFT_URL,
};

const SPEC_FILE: ContextFinding = {
  createdAt: at(23),
  id: "f-spec",
  note: "Добавляет: в ТЗ уже есть интеграция с amoCRM",
  questionId: null,
  quote: "Интеграция с amoCRM через API v4.",
  sourceKind: "file",
  sourceName: "ТЗ.docx",
  sourceUrl: null,
};

const TASK_URL = "https://app.clickup.com/t/86abc";
const CRM_TASK: ContextFinding = {
  createdAt: at(25),
  id: "f-task",
  note: "Противоречит: в задаче записи звонков не нужны",
  questionId: null,
  quote: "Записи звонков в CRM не переносим.",
  sourceKind: "clickup",
  sourceName: "Карточка пациента при входящем звонке",
  sourceUrl: TASK_URL,
};

const AFTER_THE_CALL = /на странице проекта после звонка/u;
const QUESTION_LINK = /к вопросу/u;

const CRM = topic("t-crm", "Интеграция с CRM", 0);
const RECORD_CALL = "Записывать в CRM сам звонок или только факт?";
const AMO = "Используем текущую интеграцию с amoCRM?";

/** What `call_state_get` answers now. */
let backend: CallStateView;

function setBackend(state: CallState) {
  backend = {
    ...state,
    agent: {
      recordingId: RECORDING,
      state: { kind: "idle" },
      utilization: null,
    },
  };
}

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

/** The backend changed the call state: every window reads it again. */
async function changed() {
  await act(async () => {
    fake.emit("call-state-changed", { recordingId: RECORDING });
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** The call window's «Контекст» column, once the window read the state. */
async function openContext() {
  const view = render(<CallPage />);
  await waitFor(() =>
    expect(invokedWith("call_state_get")).toContainEqual({
      recordingId: RECORDING,
    })
  );
  return within(
    within(view.container).getByRole("region", { name: "Контекст" })
  );
}

function sourceOf(card: HTMLElement) {
  return card
    .querySelector("[data-slot=context-card-source]")
    ?.getAttribute("data-source");
}

beforeEach(async () => {
  fake.answers.clear();
  fake.failures.clear();
  opener.openUrl.mockClear();
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа")
  );
  fake.db.settings = { onboardingCompleted: true };
  fake.recording = RECORDING_NOW;
  setBackend(callState({ contextSources: SOURCES }));
  fake.answers.set("transcript_for_recording", () => []);
  fake.answers.set("call_state_get", () => backend);
  await act(() => refreshProjects());
  await act(() => refreshSettings());
  followCallSession();
  act(() =>
    fake.setSession(
      liveSession({
        participants: ["Ольга"],
        projectId: TELEMEDIA,
        recordingId: RECORDING,
      })
    )
  );
  await waitFor(() => expect(currentCallSession().recordingId).toBe(RECORDING));
  fake.invoked.length = 0;
});

/** jsdom has none; the question link tests put a spy in its place. */
const ORIGINAL_SCROLL = Element.prototype.scrollIntoView;

afterEach(() => {
  Element.prototype.scrollIntoView = ORIGINAL_SCROLL;
  vi.useRealTimers();
  act(() => fake.setSession(IDLE_SESSION));
  fake.recording = IDLE_RECORDING;
});

describe("the «Контекст» column in Tauri", () => {
  it("«Находка из Outline»: icon, name, quote, note, time and a link", async () => {
    setBackend(callState({ contextSources: SOURCES, findings: [SHIFT_RULES] }));
    const context = await openContext();

    const card = await context.findByRole("article", {
      name: "Регламент смены",
    });
    expect(sourceOf(card)).toBe("outline");
    const inCard = within(card);
    expect(inCard.getByText(SHIFT_RULES.quote)).toBeTruthy();
    expect(inCard.getByText(SHIFT_RULES.note)).toBeTruthy();
    expect(inCard.getByText("Документ Outline")).toBeTruthy();
    expect(inCard.getByText("12:21")).toBeTruthy();
    const link = inCard.getByRole("link", { name: "Открыть в источнике" });
    expect(link.getAttribute("href")).toBe(SHIFT_URL);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("the link opens the document in the default browser", async () => {
    setBackend(callState({ contextSources: SOURCES, findings: [CRM_TASK] }));
    const context = await openContext();
    const card = await context.findByRole("article", {
      name: CRM_TASK.sourceName,
    });

    fireEvent.click(
      within(card).getByRole("link", { name: "Открыть в источнике" })
    );

    await waitFor(() => expect(opener.openUrl).toHaveBeenCalledWith(TASK_URL));
  });

  it("«Находка из файла»: the file's icon and name, no link", async () => {
    setBackend(callState({ contextSources: SOURCES, findings: [SPEC_FILE] }));
    const context = await openContext();

    const card = await context.findByRole("article", { name: "ТЗ.docx" });
    expect(sourceOf(card)).toBe("file");
    expect(within(card).getByText("Файл проекта")).toBeTruthy();
    expect(within(card).getByText(SPEC_FILE.quote)).toBeTruthy();
    expect(within(card).queryByRole("link")).toBeNull();
  });

  it("findings go newest first under the sources the search covers", async () => {
    // The backend's order: the newest first
    setBackend(
      callState({
        contextSources: { clickup: 1, files: 0, outline: 3 },
        findings: [CRM_TASK, SPEC_FILE, SHIFT_RULES],
      })
    );
    const context = await openContext();
    await context.findByRole("article", { name: "Регламент смены" });

    expect(
      context
        .getAllByRole("article")
        .map((card) => card.getAttribute("aria-label"))
    ).toEqual([CRM_TASK.sourceName, "ТЗ.docx", "Регламент смены"]);
    const sources = context.getByRole("list", { name: "Где ищу" });
    expect(sources.textContent).toContain("3 документа");
    expect(sources.textContent).toContain("1 задача");
    // Only the kinds the project has
    expect(sources.textContent).not.toContain("Файлы");
  });

  it("«Проект без источников»: nothing to search in, no findings", async () => {
    setBackend(callState());
    const context = await openContext();

    expect(
      await context.findByText("Искать негде: у проекта нет источников")
    ).toBeTruthy();
    expect(context.getByText(AFTER_THE_CALL)).toBeTruthy();
    expect(context.queryByRole("article")).toBeNull();
    expect(context.queryByRole("list", { name: "Где ищу" })).toBeNull();
  });

  it("«Нет выдуманных находок»: no scripted cards, brief or sources", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    setBackend(callState());
    const context = await openContext();
    await context.findByText("Искать негде: у проекта нет источников");

    // The whole demo script would have played by now
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });

    expect(context.queryByRole("article")).toBeNull();
    expect(context.queryByText("GitHub")).toBeNull();
    expect(context.queryByText("Outline")).toBeNull();
    expect(context.queryByText("telemedia/backend")).toBeNull();
    expect(context.queryByText("Архитектура телефонии")).toBeNull();
    expect(context.queryByText("Бриф проекта")).toBeNull();
    expect(context.queryByText("готовлю бриф")).toBeNull();
    expect(
      context.queryByRole("button", { name: "Подключить снова" })
    ).toBeNull();
  });

  it("«Ищу в материалах» while the search runs", async () => {
    setBackend(
      callState({
        contextSearch: {
          queries: ["старший смены", "распределение звонков"],
          running: true,
        },
        contextSources: SOURCES,
      })
    );
    const context = await openContext();

    expect((await context.findByRole("status")).textContent).toBe(
      "Ищу в материалах: старший смены, распределение звонков"
    );

    setBackend(
      callState({
        contextSearch: { queries: [], running: false },
        contextSources: SOURCES,
        findings: [SHIFT_RULES],
      })
    );
    await changed();

    await context.findByRole("article", { name: "Регламент смены" });
    expect(context.queryByRole("status")).toBeNull();
  });

  it("a finding from `call-state-changed` shows up in every call window", async () => {
    const first = await openContext();
    const second = within(
      within(render(<CallPage />).container).getByRole("region", {
        name: "Контекст",
      })
    );
    await waitFor(() => expect(invokedWith("call_state_get")).toHaveLength(2));
    expect(first.queryByRole("article")).toBeNull();

    setBackend(callState({ contextSources: SOURCES, findings: [SHIFT_RULES] }));
    await changed();

    await waitFor(() => {
      expect(
        first.getByRole("article", { name: "Регламент смены" })
      ).toBeTruthy();
      expect(
        second.getByRole("article", { name: "Регламент смены" })
      ).toBeTruthy();
    });
  });

  it("«Убрать» hides the finding through the backend in every window", async () => {
    setBackend(
      callState({ contextSources: SOURCES, findings: [SHIFT_RULES, SPEC_FILE] })
    );
    fake.answers.set("context_finding_hide", ({ findingId }) => {
      setBackend({
        ...backend,
        findings: backend.findings.filter((item) => item.id !== findingId),
      });
      setTimeout(
        () => fake.emit("call-state-changed", { recordingId: RECORDING }),
        0
      );
      return null;
    });
    const first = await openContext();
    const second = within(
      within(render(<CallPage />).container).getByRole("region", {
        name: "Контекст",
      })
    );
    const card = await first.findByRole("article", { name: "Регламент смены" });
    await second.findByRole("article", { name: "Регламент смены" });

    fireEvent.click(within(card).getByRole("button", { name: "Убрать" }));

    await waitFor(() => {
      expect(
        first.queryByRole("article", { name: "Регламент смены" })
      ).toBeNull();
      expect(
        second.queryByRole("article", { name: "Регламент смены" })
      ).toBeNull();
    });
    expect(invokedWith("context_finding_hide")).toEqual([
      { findingId: "f-shift", recordingId: RECORDING },
    ]);
    expect(first.getByRole("article", { name: "ТЗ.docx" })).toBeTruthy();
  });

  it("a refused «Убрать» keeps the finding", async () => {
    setBackend(callState({ contextSources: SOURCES, findings: [SHIFT_RULES] }));
    fake.failures.set("context_finding_hide", {
      kind: "NotFound",
      message: "нет такой находки",
    });
    const context = await openContext();
    const card = await context.findByRole("article", {
      name: "Регламент смены",
    });

    fireEvent.click(within(card).getByRole("button", { name: "Убрать" }));

    await waitFor(() =>
      expect(invokedWith("context_finding_hide")).toHaveLength(1)
    );
    expect(
      context.getByRole("article", { name: "Регламент смены" })
    ).toBeTruthy();
  });

  it("«Вопрос по находке»: the link shows the question in the list", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    setBackend(
      callState({
        contextSources: SOURCES,
        currentTopicId: CRM.id,
        findings: [CRM_TASK, SHIFT_RULES],
        questions: [
          visible("q-amo", AMO, CRM.id, 0),
          visible("q-record", RECORD_CALL, CRM.id, 1, {
            evidence: [
              {
                id: CRM_TASK.id,
                quote: "Записи звонков в CRM не переносим",
                source: "document",
              },
              {
                id: "s-1",
                quote: "звонок пусть пишется в карточку",
                source: "segment",
              },
            ],
            gapType: "contradiction",
          }),
        ],
        topics: [CRM],
      })
    );
    const view = render(<CallPage />);
    const window = within(view.container);
    const context = within(window.getByRole("region", { name: "Контекст" }));
    const card = await context.findByRole("article", {
      name: CRM_TASK.sourceName,
    });
    // A finding no question cites has no link
    const other = context.getByRole("article", { name: "Регламент смены" });
    expect(
      within(other).queryByRole("button", { name: QUESTION_LINK })
    ).toBeNull();

    fireEvent.click(
      within(card).getByRole("button", { name: `к вопросу «${RECORD_CALL}»` })
    );

    const row = window.getByRole("group", { name: RECORD_CALL });
    expect(row.hasAttribute("data-highlighted")).toBe(true);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect(scrolled.mock.contexts[0]).toBe(row);
    expect(
      window.getByRole("group", { name: AMO }).hasAttribute("data-highlighted")
    ).toBe(false);
  });

  it("the finding's own open question gets the link too", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    setBackend(
      callState({
        contextSources: SOURCES,
        currentTopicId: CRM.id,
        findings: [{ ...SHIFT_RULES, questionId: "q-amo" }],
        questions: [
          visible("q-record", RECORD_CALL, CRM.id, 0),
          visible("q-amo", AMO, CRM.id, 1),
        ],
        topics: [CRM],
      })
    );
    const view = render(<CallPage />);
    const window = within(view.container);
    const card = await window.findByRole("article", {
      name: "Регламент смены",
    });

    fireEvent.click(
      within(card).getByRole("button", { name: `к вопросу «${AMO}»` })
    );

    expect(
      window.getByRole("group", { name: AMO }).hasAttribute("data-highlighted")
    ).toBe(true);
  });

  it("an answered question no longer gets a link", async () => {
    setBackend(
      callState({
        contextSources: SOURCES,
        currentTopicId: CRM.id,
        findings: [{ ...SHIFT_RULES, questionId: "q-amo" }],
        questions: [
          visible("q-amo", AMO, CRM.id, 0, {
            status: "answered",
            visible: false,
          }),
        ],
        topics: [CRM],
      })
    );
    const context = await openContext();
    const card = await context.findByRole("article", {
      name: "Регламент смены",
    });

    expect(
      within(card).queryByRole("button", { name: QUESTION_LINK })
    ).toBeNull();
  });
});
