import {
  act,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentLoopState,
  CallState,
  CallStateView,
  RecordingStatus,
  TranscriptSegment,
} from "@/bindings";

import {
  at,
  callState,
  question,
  STATE_RECORDING,
  segmentEvidence,
  topic,
  visible,
} from "./helpers/call-state";

/*
 * The questions of the call window and the overlay in Tauri mode, over the
 * fake IPC (./helpers/fake-tauri.ts): both read `call_state_get` of the
 * session's recording on `call-state-changed`, show the agent's status
 * from `agent-status`, and send the quick actions to `questions_act`,
 * which answers with the next `call-state-changed` (agent-fast-loop
 * design.md, decision 11).
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
const { OverlayPage } = await import(
  "@/features/call-widget/pages/overlay-page"
);
const { currentCallSession, followCallSession } = await import(
  "@/data/call-session"
);
const { refreshProjects } = await import("@/data/projects");
const { refreshSettings } = await import("@/data/settings");
const { wallClock } = await import("@/features/call/agent-state");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const RECORDING = STATE_RECORDING;

const RECORDING_NOW: RecordingStatus = {
  ...IDLE_RECORDING,
  id: RECORDING,
  startedAt: Date.now(),
};

const CRM = topic("t-crm", "Интеграция с CRM", 0);
const MAIN = "Записывать в CRM сам звонок или только факт?";
const AMO = "Используем текущую интеграцию с amoCRM?";
const RETURN_TO_FINAL_CHECK = /^К финальной проверке/u;
const PHONE = "Карточку открывать только по номеру телефона?";
const FROM_CALLS = /из темы «Приём звонков»/u;

/** The CRM topic with its main question and two more in the queue. */
function crmState(): CallState {
  return callState({
    currentTopicId: CRM.id,
    questions: [
      visible("q-main", MAIN, CRM.id, 0),
      visible("q-amo", AMO, CRM.id, 1),
      visible("q-phone", PHONE, CRM.id, 2, { gapType: "contradiction" }),
    ],
    topics: [CRM],
  });
}

/** What `call_state_get` answers now. */
let backend: CallStateView;

function setBackend(
  state: CallState,
  agent: AgentLoopState = { kind: "idle" }
) {
  backend = {
    ...state,
    agent: { recordingId: RECORDING, state: agent, utilization: null },
  };
}

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

/** Plays a Rust event and lets the stream fibers apply it. */
async function emit(event: string, payload: unknown) {
  await act(async () => {
    fake.emit(event, payload);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** The backend changed the call state: every window reads it again. */
function changed() {
  return emit("call-state-changed", { recordingId: RECORDING });
}

function agentStatus(state: AgentLoopState, utilization: number | null = null) {
  return emit("agent-status", { recordingId: RECORDING, state, utilization });
}

function listeners(event: string) {
  return fake.handlers.get(event)?.size ?? 0;
}

/** The call window, waiting until it reads the recording's call state. */
async function openCall() {
  const view = render(<CallPage />);
  await waitFor(() =>
    expect(invokedWith("call_state_get")).toContainEqual({
      recordingId: RECORDING,
    })
  );
  return within(view.container);
}

/** The call window and the overlay, side by side. */
async function openBoth() {
  const call = within(render(<CallPage />).container);
  const overlay = within(render(<OverlayPage />).container);
  await waitFor(() => expect(listeners("call-state-changed")).toBe(2));
  await waitFor(() => expect(invokedWith("call_state_get")).toHaveLength(2));
  return { call, overlay };
}

beforeEach(async () => {
  fake.answers.clear();
  fake.failures.clear();
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа")
  );
  fake.db.settings = { onboardingCompleted: true };
  fake.recording = RECORDING_NOW;
  setBackend(callState());
  fake.answers.set("transcript_for_recording", () => []);
  fake.answers.set("call_state_get", () => backend);
  fake.answers.set("agent_retry", () => null);
  await act(() => refreshProjects());
  await act(() => refreshSettings());
  // The backend's call, live with the recording, in this window's session
  // before the windows open.
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

afterEach(() => {
  vi.useRealTimers();
  act(() => fake.setSession(IDLE_SESSION));
  fake.recording = IDLE_RECORDING;
});

describe("questions in Tauri", () => {
  it("an event updates the questions in the call window and the overlay", async () => {
    const { call, overlay } = await openBoth();

    // Nothing from the demo script: the agent listens
    expect(
      call.getByText(
        "Слушаю. Первые вопросы появятся, когда станет понятна тема"
      )
    ).toBeTruthy();
    expect(
      call.queryByText("Что происходит, если все операторы заняты?")
    ).toBeNull();
    expect(
      overlay.getByText("Слушаю. Вопросы появятся, когда станет понятна тема.")
    ).toBeTruthy();

    setBackend(crmState());
    await changed();

    expect(await call.findByRole("group", { name: MAIN })).toBeTruthy();
    expect(call.getByRole("group", { name: AMO })).toBeTruthy();
    expect(
      call.getByRole("heading", { name: "Интеграция с CRM" })
    ).toBeTruthy();
    expect(
      within(call.getByRole("group", { name: PHONE })).getByText("противоречие")
    ).toBeTruthy();

    expect(await overlay.findByRole("group", { name: MAIN })).toBeTruthy();
    expect(overlay.getByRole("group", { name: AMO })).toBeTruthy();
    expect(
      overlay.getByRole("heading", { level: 1, name: "Интеграция с CRM" })
    ).toBeTruthy();

    // Another recording's change is not this call's
    fake.invoked.length = 0;
    await emit("call-state-changed", { recordingId: "another" });
    expect(invokedWith("call_state_get")).toEqual([]);
  });

  it("«Скрыть» in the overlay removes the question in the call window", async () => {
    setBackend(crmState());
    fake.answers.set("questions_act", ({ action, id }) => {
      const status = action === "hide" ? "hidden" : "open";
      setBackend({
        ...backend,
        questions: backend.questions.map((item) =>
          item.id === id
            ? { ...item, rank: null, status, visible: status === "open" }
            : item
        ),
      });
      // The backend answers with an event, after the command.
      setTimeout(
        () => fake.emit("call-state-changed", { recordingId: RECORDING }),
        0
      );
      return null;
    });
    const { call, overlay } = await openBoth();
    await call.findByRole("group", { name: AMO });

    fireEvent.click(
      within(overlay.getByRole("group", { name: AMO })).getByRole("button", {
        name: "Скрыть вопрос",
      })
    );

    await waitFor(() =>
      expect(call.queryByRole("group", { name: AMO })).toBeNull()
    );
    expect(invokedWith("questions_act")).toEqual([
      { action: "hide", id: "q-amo" },
    ]);
    expect(overlay.queryByRole("group", { name: AMO })).toBeNull();
    // In the topic's history, with «Вернуть»
    const entry = call.getByText(AMO).closest("li");
    if (!entry) {
      throw new Error("The hidden question is not in the topic history");
    }
    expect(within(entry).getByText("Вы скрыли")).toBeTruthy();

    fireEvent.click(within(entry).getByRole("button", { name: "Вернуть" }));
    await waitFor(() =>
      expect(invokedWith("questions_act")).toContainEqual({
        action: "restore",
        id: "q-amo",
      })
    );
  });

  it("sends the call window's quick actions to the backend, nothing stashed", async () => {
    setBackend(crmState());
    fake.answers.set("questions_act", () => null);
    const call = await openCall();

    fireEvent.click(
      within(await call.findByRole("group", { name: AMO })).getByRole(
        "button",
        {
          name: "Уже спросил",
        }
      )
    );
    await waitFor(() =>
      expect(invokedWith("questions_act")).toEqual([
        { action: "asked", id: "q-amo" },
      ])
    );
    // The backend's state is the truth: unchanged until it says otherwise
    expect(call.getByRole("group", { name: AMO })).toBeTruthy();
  });

  it("pins in place of the pinned question and unpins through the backend", async () => {
    const state = crmState();
    setBackend({
      ...state,
      questions: state.questions.map((item) =>
        item.id === "q-phone" ? { ...item, pinned: true } : item
      ),
    });
    fake.answers.set("questions_act", () => null);
    const call = await openCall();

    fireEvent.click(
      within(await call.findByRole("group", { name: AMO })).getByRole(
        "button",
        {
          name: "Закрепить наверху темы",
        }
      )
    );
    await waitFor(() =>
      expect(invokedWith("questions_act")).toEqual([
        { action: "unpin", id: "q-phone" },
        { action: "pin", id: "q-amo" },
      ])
    );

    fireEvent.click(call.getByRole("button", { name: "Открепить" }));
    await waitFor(() =>
      expect(invokedWith("questions_act")).toContainEqual({
        action: "unpin",
        id: "q-phone",
      })
    );
  });

  it("shows a question pinned in an earlier topic in the current list of both windows", async () => {
    const calls = topic("t-calls", "Приём звонков", 0);
    const ads = topic("t-ads", "Реклама", 1);
    const pinned = "Сколько операторов в смене?";
    // questionCount 1: the pin takes the place, the new topic's question
    // waits
    setBackend(
      callState({
        currentTopicId: ads.id,
        questions: [
          visible("q-pin", pinned, calls.id, 0, { pinned: true }),
          question("q-ads", "Какой бюджет на рекламу?", { topicId: ads.id }),
        ],
        topics: [calls, ads],
      })
    );
    const { call, overlay } = await openBoth();

    expect(await call.findByText(pinned)).toBeTruthy();
    expect(call.getAllByText(pinned)).toHaveLength(1);
    expect(call.getByText(FROM_CALLS)).toBeTruthy();
    expect(call.getByRole("button", { name: "Открепить" })).toBeTruthy();

    expect(await overlay.findByText(pinned)).toBeTruthy();
    expect(overlay.getByText(FROM_CALLS)).toBeTruthy();
    expect(
      overlay.getByRole("heading", { level: 1, name: "Реклама" })
    ).toBeTruthy();
  });

  it("announces a new question under the pill, not one moving up", async () => {
    setBackend(crmState());
    const overlay = within(render(<OverlayPage />).container);
    await overlay.findByRole("group", { name: MAIN });
    fireEvent.click(overlay.getByRole("button", { name: "Свернуть в пилюлю" }));
    expect(overlay.queryByText("Новый вопрос")).toBeNull();

    // The main question hidden: the queued one moves up, it isn't new
    const hidden = (id: string, text: string) =>
      question(id, text, { status: "hidden", topicId: CRM.id });
    setBackend(
      callState({
        currentTopicId: CRM.id,
        questions: [
          hidden("q-main", MAIN),
          visible("q-amo", AMO, CRM.id, 0),
          visible("q-phone", PHONE, CRM.id, 1),
        ],
        topics: [CRM],
      })
    );
    await changed();
    expect(overlay.queryByText("Новый вопрос")).toBeNull();

    // A question that has just come takes the top: it is
    const fresh = "Кто отвечает на звонки ночью?";
    setBackend(
      callState({
        currentTopicId: CRM.id,
        questions: [
          hidden("q-main", MAIN),
          hidden("q-amo", AMO),
          hidden("q-phone", PHONE),
          visible("q-new", fresh, CRM.id, 0, { shownAt: at(5) }),
        ],
        topics: [CRM],
      })
    );
    await changed();
    expect(await overlay.findByText("Новый вопрос")).toBeTruthy();
    expect(overlay.getByText(fresh)).toBeTruthy();
  });

  it("a stale read never replaces a newer state", async () => {
    setBackend(crmState());
    const call = await openCall();
    await call.findByRole("group", { name: MAIN });

    // The first read hangs; a second, with the answered question, wins.
    let releaseOld: () => void = () => undefined;
    const old = backend;
    fake.answers.set(
      "call_state_get",
      () =>
        new Promise((resolve) => {
          releaseOld = () => resolve(structuredClone(old));
        })
    );
    await changed();
    setBackend({
      ...backend,
      questions: backend.questions.filter((item) => item.id !== "q-amo"),
    });
    fake.answers.set("call_state_get", () => backend);
    await changed();
    await waitFor(() =>
      expect(call.queryByRole("group", { name: AMO })).toBeNull()
    );

    await act(async () => {
      releaseOld();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(call.queryByRole("group", { name: AMO })).toBeNull();
  });

  it("signs a contradiction in the transcript with the time of the earlier phrase", async () => {
    const segment = (
      id: string,
      startMs: number,
      text: string
    ): TranscriptSegment => ({
      callId: null,
      channel: "others",
      createdAt: 1,
      endMs: startMs + 1500,
      id,
      pass: "live",
      recordingId: RECORDING,
      startMs,
      text,
      updatedAt: 1,
    });
    fake.answers.set("transcript_for_recording", () => [
      segment("s-1", 60_000, "Приложение пока не трогаем"),
      segment("s-2", 180_000, "Из приложения тоже звонят, надо завести"),
    ]);
    setBackend(
      callState({
        currentTopicId: CRM.id,
        questions: [
          visible("q-app", "Приложение входит в первый этап?", CRM.id, 0, {
            evidence: [
              segmentEvidence("s-1", "пока не трогаем"),
              segmentEvidence("s-2", "тоже звонят"),
            ],
            gapType: "contradiction",
          }),
        ],
        topics: [CRM],
      })
    );
    const call = await openCall();

    expect(await call.findByText("противоречит сказанному в")).toBeTruthy();
    const startedAt = currentCallSession().startedAt ?? 0;
    expect(
      call.getByRole("button", { name: wallClock(startedAt + 60_000) })
    ).toBeTruthy();
    expect(call.getByText("Противоречие")).toBeTruthy();
  });
});

describe("the agent's status in Tauri", () => {
  it("counts the error banner down; «Повторить» calls the agent now", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    setBackend(crmState());
    const call = await openCall();
    await call.findByRole("group", { name: MAIN });

    await agentStatus({
      kind: "error",
      message: "Claude Code не ответил за 30 с",
      retryAt: Date.now() + 30_000,
    });

    const banner = await call.findByRole("alert");
    expect(banner.textContent).toContain("Claude Code не ответил");
    expect(banner.textContent).toContain("0:30");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(banner.textContent).toContain("0:28");

    fireEvent.click(within(banner).getByRole("button", { name: "Повторить" }));
    await waitFor(() =>
      expect(invokedWith("agent_retry")).toEqual([{ recordingId: RECORDING }])
    );

    // The retry works: the banner goes with the next status
    await agentStatus({ kind: "thinking" });
    expect(call.queryByRole("alert")).toBeNull();
    expect(call.getByText("думаю над вопросами")).toBeTruthy();
  });

  it("«Повторить» the backend refuses goes back to the last status", async () => {
    setBackend(crmState());
    const call = await openCall();
    await call.findByRole("group", { name: MAIN });
    await agentStatus({
      kind: "error",
      message: "Claude Code не ответил за 30 с",
      retryAt: Date.now() + 30_000,
    });
    const banner = await call.findByRole("alert");
    // The recording stopped meanwhile: the live pass is over
    fake.failures.set("agent_retry", {
      kind: "NotFound",
      message: `Запись ${RECORDING} не идёт`,
    });

    fireEvent.click(within(banner).getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(invokedWith("agent_retry")).toHaveLength(1));

    await waitFor(() => expect(call.queryByText("переподключаюсь")).toBeNull());
    expect(call.getByText("вопросы на паузе")).toBeTruthy();
    expect(call.getByText("Claude Code не ответил")).toBeTruthy();
  });

  it("stays calm when the agent thinks longer than usual", async () => {
    // The call's time runs from its start on the clock.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const call = await openCall();

    await agentStatus({ kind: "thinking" });
    expect(call.getByText("думаю над вопросами")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(25_000);
    });
    expect(call.getByText("думаю дольше обычного")).toBeTruthy();
    expect(call.queryByRole("alert")).toBeNull();
  });

  it("leads to Settings → Агент when Claude Code needs a login", async () => {
    setBackend(crmState(), { kind: "needsLogin" });
    const call = await openCall();

    const banner = await call.findByRole("alert");
    expect(banner.textContent).toContain("Claude Code просит войти");
    expect(
      within(banner)
        .getByRole("link", { name: "Открыть настройки агента" })
        .getAttribute("href")
    ).toBe("/settings/agent");
  });

  it("names the reset time of the limit and shows the share used", async () => {
    const resetsAt = new Date(2026, 10, 4, 15, 0).getTime();
    const call = await openCall();

    await agentStatus({ kind: "idle" }, 0.87);
    expect(await call.findByText("лимит 87%")).toBeTruthy();

    await agentStatus({ kind: "rateLimited", resetsAt }, 1);
    const banner = await call.findByRole("alert");
    expect(banner.textContent).toContain(
      "Лимит подписки Claude исчерпан до 15:00"
    );
    expect(call.getByText("лимит 100%")).toBeTruthy();
    expect(call.getByText("лимит исчерпан")).toBeTruthy();
  });

  it("shows the overlay's agent stopped", async () => {
    setBackend(crmState(), { kind: "needsLogin" });
    const overlay = within(render(<OverlayPage />).container);

    expect(await overlay.findByText("нужен вход")).toBeTruthy();
  });
});

describe("the final check in Tauri", () => {
  function finalCheckState(): CallState {
    const CALLS = topic("t-calls", "Приём звонков", 1);
    return callState({
      currentTopicId: CALLS.id,
      finalCheck: { questionIds: ["q-main", "q-busy"], startedAt: Date.now() },
      questions: [
        question("q-main", MAIN, { topicId: CRM.id }),
        question("q-busy", "Что, если все операторы заняты?", {
          topicId: CALLS.id,
        }),
        visible("q-queue", "Очередь с музыкой — решение?", CALLS.id, 0),
      ],
      topics: [CRM, CALLS],
    });
  }

  it("appears from the state, with the topic above each question", async () => {
    const { call, overlay } = await openBoth();

    setBackend(finalCheckState());
    await changed();

    expect(await call.findByText("Похоже, разговор идёт к концу")).toBeTruthy();
    expect(call.getByText("2 самых важных из 3 открытых")).toBeTruthy();
    const busy = call.getByRole("group", {
      name: "Что, если все операторы заняты?",
    });
    expect(within(busy).getByText("Приём звонков")).toBeTruthy();

    expect(
      await overlay.findByRole("heading", {
        level: 1,
        name: "Финальная проверка",
      })
    ).toBeTruthy();
    expect(overlay.getByRole("group", { name: MAIN }).textContent).toContain(
      "Интеграция с CRM"
    );
  });

  it("«Вернуться к темам» stays on the screen and the check comes back by its anchor", async () => {
    setBackend(finalCheckState());
    const call = await openCall();
    await call.findByText("Похоже, разговор идёт к концу");

    fireEvent.click(call.getByRole("button", { name: "Вернуться к темам" }));

    expect(call.queryByText("Похоже, разговор идёт к концу")).toBeNull();
    expect(
      call.getByRole("group", { name: "Очередь с музыкой — решение?" })
    ).toBeTruthy();

    // A new state keeps it aside
    await changed();
    expect(call.queryByText("Похоже, разговор идёт к концу")).toBeNull();

    fireEvent.click(call.getByRole("button", { name: RETURN_TO_FINAL_CHECK }));
    expect(call.getByText("Похоже, разговор идёт к концу")).toBeTruthy();
    expect(invokedWith("questions_act")).toEqual([]);
  });
});
