import { assert, it as effectIt } from "@effect/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Fiber, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The call from «Начать» to «завершён» in Tauri mode, over the fake IPC
 * (./helpers/fake-tauri.ts plays the backend's `CallManager`):
 * - CallSessionBackend.layerTauri: the session when a window opens, the
 *   changes of every window, the call commands;
 * - the window's session: a window opened mid-call, «Отменить завершение»;
 * - the start widget offers the last call's project and people;
 * - the call window and the overlay: «Звонок без проекта», «Звонка нет»;
 * - the summary closes the call; «Удалить все данные» is refused during it.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const win = vi.hoisted(() => ({
  hide: vi.fn(() => Promise.resolve()),
  label: "main",
}));

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  search: new URLSearchParams(),
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
    hide: win.hide,
    label: win.label,
    listen: fake.listen,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: nav.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => nav.search,
}));

const {
  fakeCall,
  fakePerson,
  fakeProject,
  IDLE_RECORDING,
  IDLE_SESSION,
  liveSession,
} = await import("./helpers/fake-tauri");
const { CallSessionBackend } = await import("@/data/services/call-session");
const { useCallSession } = await import("@/data/call-session");
const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { OverlayPage } = await import(
  "@/features/call-widget/pages/overlay-page"
);
const { CallPage } = await import("@/features/call/pages/call-page");
const { CallSummaryPage } = await import(
  "@/features/post-call/pages/call-summary-page"
);
const { PrivacySection } = await import(
  "@/features/settings/pages/privacy-section"
);
const { toast } = await import("@/components/ui/toast");
const { routes } = await import("@/lib/routes");
const { refreshProjects } = await import("@/data/projects");
const { refreshPeople } = await import("@/data/people");
const { refreshCalls } = await import("@/data/calls");
const { refreshSettings } = await import("@/data/settings");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const EXCHANGE = "019a0000-0000-7000-8000-000000000002";
const OLGA = "019a0000-0000-7000-8000-0000000000a1";
const IGOR = "019a0000-0000-7000-8000-0000000000a2";
const NATALIA = "019a0000-0000-7000-8000-0000000000a3";
const NO_PROJECT = "Звонок без проекта";
const LIVE_RECORDED = /^live:fake-recording-\d+$/u;
const DEMO_PROJECT = /Телемедиа/u;
/** «Удалить всё» waits a moment before it deletes. */
const DELETE_TIMEOUT = { timeout: 5000 };

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function SessionProbe() {
  const session = useCallSession();
  return (
    <output aria-label="Сессия">
      {session.status}:{session.recordingId ?? "—"}
    </output>
  );
}

function sessionText() {
  return screen.getByRole("status", { name: "Сессия" }).textContent;
}

/** A finished call of `projectId`, `minutesAgo` before now. */
function pastCall(
  id: string,
  projectId: string | null,
  participantIds: string[],
  minutesAgo: number
) {
  const startedAt = Date.now() - minutesAgo * 60_000;
  return {
    ...fakeCall(id, projectId, ""),
    endedAt: startedAt + 30 * 60_000,
    participantIds,
    startedAt,
  };
}

beforeEach(async () => {
  win.label = "main";
  win.hide.mockClear();
  nav.push.mockReset();
  nav.search = new URLSearchParams();
  fake.failures.clear();
  fake.answers.clear();
  fake.recording = IDLE_RECORDING;
  fake.recordFailure = null;
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа"),
    fakeProject(EXCHANGE, "Обменник")
  );
  fake.db.people.splice(
    0,
    fake.db.people.length,
    fakePerson(OLGA, TELEMEDIA, "Ольга Демченко"),
    fakePerson(IGOR, EXCHANGE, "Игорь Смирнов"),
    fakePerson(NATALIA, EXCHANGE, "Наталья Ким")
  );
  fake.db.calls.length = 0;
  fake.db.settings = { onboardingCompleted: true };
  act(() => fake.setSession(IDLE_SESSION));
  await act(() => refreshProjects());
  await act(() => refreshPeople());
  await act(() => refreshCalls());
  await act(() => refreshSettings());
  fake.invoked.length = 0;
});

describe("CallSessionBackend.layerTauri", () => {
  effectIt.effect(
    "reads the session when a window opens, then the changes of every window",
    () =>
      Effect.gen(function* () {
        fake.session = liveSession({ projectId: TELEMEDIA });
        const backend = yield* CallSessionBackend;
        const sessions = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(backend.sessions, 2))
        );
        yield* Effect.promise(() =>
          waitFor(() => expect(invokedWith("call_current")).toHaveLength(1))
        );
        yield* Effect.yieldNow;
        // Another window finished the call.
        fake.setSession({ ...fake.session, status: "finishing" });

        const [opened, changed] = yield* Fiber.join(sessions);
        assert.strictEqual(opened?.status, "live");
        assert.strictEqual(opened?.projectId, TELEMEDIA);
        assert.strictEqual(changed?.status, "finishing");
      }).pipe(Effect.provide(CallSessionBackend.layerTauri))
  );

  effectIt.effect(
    "starts, finishes and resumes the call through the backend, which closes it",
    () =>
      Effect.gen(function* () {
        const backend = yield* CallSessionBackend;
        const started = yield* backend.start({
          participantIds: [IGOR],
          projectId: EXCHANGE,
        });
        assert.strictEqual(started.status, "live");
        assert.deepStrictEqual(started.participants, ["Игорь Смирнов"]);
        assert.deepStrictEqual(invokedWith("call_start"), [
          { input: { participantIds: [IGOR], projectId: EXCHANGE } },
        ]);
        const callId = started.callId ?? "";
        const first = started.recordingId;

        // A second «Начать» gets the same call.
        const again = yield* backend.start({ projectId: null });
        assert.strictEqual(again.callId, callId);

        const finishing = yield* backend.finish(callId);
        assert.strictEqual(finishing.status, "finishing");
        const resumed = yield* backend.resume(callId);
        assert.strictEqual(resumed.status, "live");
        assert.notStrictEqual(resumed.recordingId, first);
        yield* backend.finish(callId);
        const kept = yield* backend.keep(callId);
        assert.isNull(kept.autoEnd);
        // The window doesn't close a call: the summary build does, in Rust.
        const refused = yield* Effect.flip(backend.close(callId));
        assert.strictEqual(refused.kind, "Invalid");
        assert.deepStrictEqual(invokedWith("call_close"), []);
        yield* Effect.promise(() => fake.invoke("call_close", { callId }));
        const closed = yield* backend.current;
        assert.strictEqual(closed.status, "idle");
        assert.isNull(closed.callId);
        assert.strictEqual(
          fake.db.calls.find((call) => call.id === callId)?.status,
          "finished"
        );

        // «Удалить все данные»: the call goes without a summary.
        const next = yield* backend.start({ projectId: null });
        const discarded = yield* backend.discard(next.callId ?? "");
        assert.strictEqual(discarded.status, "idle");
        assert.deepStrictEqual(invokedWith("call_discard"), [
          { callId: next.callId },
        ]);
      }).pipe(Effect.provide(CallSessionBackend.layerTauri))
  );

  effectIt.effect(
    "fails a start without microphone access with the reason, and starts nothing",
    () =>
      Effect.gen(function* () {
        fake.recordFailure = {
          kind: "External",
          message: "Нет доступа к микрофону",
          reason: "noAccess",
        };
        const backend = yield* CallSessionBackend;
        const error = yield* Effect.flip(backend.start({ projectId: null }));
        assert.strictEqual(error.kind, "External");
        assert.strictEqual(error.reason, "noAccess");
        const now = yield* backend.current;
        assert.strictEqual(now.status, "idle");
        assert.deepStrictEqual(fake.db.calls, []);
      }).pipe(Effect.provide(CallSessionBackend.layerTauri))
  );
});

describe("the window's call", () => {
  it("shows the call a window opens in mid-call, not the demo", async () => {
    fake.setSession(
      liveSession({
        participantIds: [IGOR],
        participants: ["Игорь Смирнов"],
        projectId: EXCHANGE,
        startedAt: Date.now() - 125_000,
      })
    );
    render(<CallPage />);

    expect(await screen.findByText("Обменник")).toBeTruthy();
    expect(screen.getByText("Игорь Смирнов")).toBeTruthy();
    expect(screen.queryByText(DEMO_PROJECT)).toBeNull();
    // The time runs from the call's start.
    expect(
      screen.getByRole("timer", { name: "Идёт запись, 02:05" })
    ).toBeTruthy();
    expect(invokedWith("call_start")).toEqual([]);
  });

  it("«Отменить завершение» records the same call on", async () => {
    await act(() =>
      fake.invoke("call_start", {
        input: { participantIds: [OLGA], projectId: TELEMEDIA },
      })
    );
    const { callId, recordingId: first } = fake.session;
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    await waitFor(() => expect(sessionText()).toBe(`live:${first}`));

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(sessionText()).toBe(`finishing:${first}`));
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить завершение" })
    );

    await waitFor(() => expect(sessionText()).toMatch(LIVE_RECORDED));
    expect(sessionText()).not.toBe(`live:${first}`);
    expect(invokedWith("call_finish")).toEqual([{ callId }]);
    expect(invokedWith("call_resume")).toEqual([{ callId }]);
    expect(invokedWith("recording_start")).toEqual([]);
    expect(screen.queryByText("Собираю итоги…")).toBeNull();
  });

  it("a finish the backend refused leaves the call live on the page", async () => {
    const add = vi.spyOn(toast, "add");
    await act(() =>
      fake.invoke("call_start", { input: { projectId: TELEMEDIA } })
    );
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    fake.failures.set("call_finish", {
      kind: "Storage",
      message: "База данных не ответила",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Не удалось завершить звонок" })
      )
    );
    expect(sessionText()).toMatch("live:");
    expect(screen.queryByText("Собираю итоги…")).toBeNull();
    expect(screen.getByRole("button", { name: "Завершить" })).toBeTruthy();
    add.mockRestore();
  });

  it("a resume the backend refused leaves the page collecting the summary", async () => {
    const add = vi.spyOn(toast, "add");
    await act(() =>
      fake.invoke("call_start", { input: { projectId: TELEMEDIA } })
    );
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(sessionText()).toMatch("finishing:"));
    fake.failures.set("call_resume", {
      kind: "Storage",
      message: "База данных не ответила",
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить завершение" })
    );

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Запись не возобновилась" })
      )
    );
    expect(sessionText()).toMatch("finishing:");
    expect(screen.getByText("Собираю итоги…")).toBeTruthy();
    add.mockRestore();
  });

  it("says why the recording did not start again; the call goes on", async () => {
    const add = vi.spyOn(toast, "add");
    await act(() =>
      fake.invoke("call_start", { input: { projectId: TELEMEDIA } })
    );
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(sessionText()).toMatch("finishing:"));
    fake.recordFailure = {
      kind: "External",
      message: "Нет доступа к микрофону",
      reason: "noAccess",
    };
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить завершение" })
    );

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Нет доступа к микрофону",
          type: "error",
        })
      )
    );
    expect(sessionText()).toBe("live:—");
    add.mockRestore();
  });
});

describe("start widget", () => {
  beforeEach(() => {
    win.label = "widget";
  });

  it("offers the project and the people of the last call (Второй звонок проекта)", async () => {
    fake.db.calls.push(
      pastCall("call-telemedia", TELEMEDIA, [OLGA], 60 * 24),
      pastCall("call-exchange", EXCHANGE, [IGOR], 60)
    );
    await act(() => refreshCalls());
    render(<StartWidgetPage />);

    expect(await screen.findByText("Обменник")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Убрать Игорь" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Убрать Наталья" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));

    await waitFor(() =>
      expect(invokedWith("call_start")).toEqual([
        { input: { participantIds: [IGOR], projectId: EXCHANGE } },
      ])
    );
    // The backend hides the widget and shows the overlay.
    await act(() => Promise.resolve());
    expect(invokedWith("windows_show")).toEqual([]);
    expect(win.hide).not.toHaveBeenCalled();
  });

  it("drops the people deleted since the last call", async () => {
    fake.db.calls.push(
      pastCall("call-exchange", EXCHANGE, [IGOR, NATALIA], 60)
    );
    fake.db.people.splice(
      fake.db.people.findIndex((person) => person.id === IGOR),
      1
    );
    await act(() => refreshPeople());
    await act(() => refreshCalls());
    render(<StartWidgetPage />);

    expect(await screen.findByText("Обменник")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Убрать Наталья" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Убрать Игорь" })).toBeNull();
  });

  it("offers a call without a project after one, and the first project without calls", async () => {
    render(<StartWidgetPage />);
    expect(await screen.findByText("Телемедиа")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Убрать Ольга" })).toBeNull();

    act(() => {
      fake.db.calls.push(pastCall("call-alone", null, [], 5));
      fake.dataChanged({
        change: "created",
        entity: "call",
        id: "call-alone",
        projectId: null,
      });
    });

    expect(await screen.findByText(NO_PROJECT)).toBeTruthy();
  });
});

describe("call window and overlay", () => {
  it("name a call without a project «Звонок без проекта»", async () => {
    fake.setSession(liveSession({ projectId: null }));
    const call = render(<CallPage />);
    expect(await call.findByText(NO_PROJECT)).toBeTruthy();
    expect(call.queryByText(DEMO_PROJECT)).toBeNull();
    // No participants of the demo either.
    expect(call.queryByText("с Ольгой и Игорем")).toBeNull();
    call.unmount();

    win.label = "overlay";
    const overlay = render(<OverlayPage />);
    expect(await overlay.findByText(NO_PROJECT)).toBeTruthy();
    expect(overlay.queryByText(DEMO_PROJECT)).toBeNull();
  });

  it("says there is no call and offers to start one, without the demo", async () => {
    render(<CallPage />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Звонка нет" })
    ).toBeTruthy();
    expect(screen.queryByText(DEMO_PROJECT)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Начать звонок" }));
    await waitFor(() =>
      expect(invokedWith("windows_show")).toEqual([
        { label: "widget", route: null },
      ])
    );
    expect(invokedWith("call_start")).toEqual([]);
  });

  it("shows the backend's countdown in both windows", async () => {
    const now = Date.now();
    fake.setSession(
      liveSession({
        autoEnd: { app: "Zoom", endsAt: now + 5 * 60_000, releasedAt: now },
        projectId: TELEMEDIA,
      })
    );
    const call = within(render(<CallPage />).container);
    win.label = "overlay";
    const overlay = within(render(<OverlayPage />).container);

    const panel = await call.findByRole("region", {
      name: "Микрофон больше не используется. Завершить звонок?",
    });
    expect(panel.textContent).toContain("Zoom отпустил микрофон");
    expect(panel.textContent).toContain("5:00");
    expect(
      await overlay.findByText("Zoom отпустил микрофон", { exact: false })
    ).toBeTruthy();
    expect(overlay.getByText("5:00")).toBeTruthy();

    // «Звонилка вернулась»: the countdown goes in every window.
    act(() => fake.setSession({ ...fake.session, autoEnd: null }));
    await waitFor(() =>
      expect(
        overlay.queryByText("Zoom отпустил микрофон", { exact: false })
      ).toBeNull()
    );
    expect(
      call.queryByRole("region", {
        name: "Микрофон больше не используется. Завершить звонок?",
      })
    ).toBeNull();
  });
});

describe("the microphone let go", () => {
  const OFFER = "Микрофон больше не используется. Завершить звонок?";

  /** Zoom let the microphone go: the backend's offer, `endsAt` as given. */
  function release(endsAt: (now: number) => number | null) {
    const now = Date.now();
    act(() =>
      fake.setSession({
        ...fake.session,
        autoEnd: { app: "Zoom", endsAt: endsAt(now), releasedAt: now },
      })
    );
  }

  it("offers to end the call without a countdown with «Никогда»; «Продолжить» withdraws it", async () => {
    await act(() =>
      fake.invoke("call_start", { input: { projectId: TELEMEDIA } })
    );
    const { callId } = fake.session;
    const call = within(render(<CallPage />).container);
    win.label = "overlay";
    const overlay = within(render(<OverlayPage />).container);
    await call.findByRole("button", { name: "Завершить" });

    release(() => null);

    const panel = await call.findByRole("region", { name: OFFER });
    expect(panel.textContent).toContain("Zoom отпустил микрофон");
    expect(within(panel).queryByRole("progressbar")).toBeNull();
    expect(
      await overlay.findByText("Zoom отпустил микрофон", { exact: false })
    ).toBeTruthy();
    expect(overlay.queryByText("Завершу сам через")).toBeNull();
    expect(overlay.queryByRole("progressbar")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "Продолжить" }));

    await waitFor(() =>
      expect(call.queryByRole("region", { name: OFFER })).toBeNull()
    );
    await waitFor(() =>
      expect(
        overlay.queryByText("Zoom отпустил микрофон", { exact: false })
      ).toBeNull()
    );
    expect(invokedWith("call_keep")).toEqual([{ callId }]);
    expect(fake.session.status).toBe("live");
  });

  it("the overlay's «Завершить» works again after «Отменить завершение»", async () => {
    await act(() =>
      fake.invoke("call_start", { input: { projectId: TELEMEDIA } })
    );
    const { callId } = fake.session;
    win.label = "overlay";
    render(<OverlayPage />);
    release((now) => now + 5 * 60_000);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    await waitFor(() => expect(fake.session.status).toBe("finishing"));

    // «Отменить завершение» in the main window, then Zoom lets go again.
    await act(() => fake.invoke("call_resume", { callId }));
    release((now) => now + 5 * 60_000);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));

    await waitFor(() =>
      expect(invokedWith("call_finish")).toEqual([{ callId }, { callId }])
    );
    await waitFor(() => expect(fake.session.status).toBe("finishing"));
  });
});

describe("summary and data", () => {
  it("«Собираю итоги» in the call window follows the build and opens the summary once Rust closed the call", async () => {
    await act(() =>
      fake.invoke("call_start", {
        input: { participantIds: [OLGA], projectId: TELEMEDIA },
      })
    );
    const callId = fake.session.callId ?? "";
    fake.answers.set("summary_get", () => ({ building: null, summary: null }));
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    const card = await screen.findByRole("dialog", { name: "Собираю итоги…" });

    act(() =>
      fake.emit("summary-progress", {
        callId,
        counts: null,
        stage: "proposals",
        state: { status: "running" },
      })
    );
    await waitFor(() =>
      expect(
        within(card)
          .getByText("Что обновить в брифе и профилях")
          .closest("li")
          ?.getAttribute("aria-current")
      ).toBe("step")
    );
    expect(nav.push).not.toHaveBeenCalled();

    // Rust ends the build and closes the call.
    const call = fake.db.calls.find((item) => item.id === callId);
    if (call) {
      call.status = "finished";
    }
    act(() => fake.setSession(IDLE_SESSION));
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith(routes.callSummary(callId))
    );
    expect(invokedWith("call_close")).toEqual([]);
  });

  it("«Собираю итоги» of a call without a project: no proposals stage, the last stage shown done", async () => {
    await act(() => fake.invoke("call_start", { input: { projectId: null } }));
    const callId = fake.session.callId ?? "";
    fake.answers.set("summary_get", () => ({ building: null, summary: null }));
    render(<CallPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));
    const card = await screen.findByRole("dialog", { name: "Собираю итоги…" });
    const steps = () =>
      within(card)
        .getAllByRole("listitem")
        .map((row) => row.textContent);

    expect(steps()).toEqual([
      "Расшифровка дописана, готово",
      "Итоги и короткое резюме по темам, идёт",
      "Незакрытые вопросы и сохранение, ждёт",
    ]);

    // Rust goes from the summary straight to saving, then ends.
    const progress = (stage: string, status: string) => ({
      callId,
      counts: null,
      stage,
      state: { status },
    });
    act(() => fake.emit("summary-progress", progress("saving", "running")));
    await waitFor(() =>
      expect(steps()).toEqual([
        "Расшифровка дописана, готово",
        "Итоги и короткое резюме по темам, готово",
        "Незакрытые вопросы и сохранение, идёт",
      ])
    );
    act(() => fake.emit("summary-progress", progress("saving", "done")));
    await waitFor(() =>
      expect(steps()).toEqual([
        "Расшифровка дописана, готово",
        "Итоги и короткое резюме по темам, готово",
        "Незакрытые вопросы и сохранение, готово",
      ])
    );
    expect(
      within(card).queryByRole("button", { name: "Отменить завершение" })
    ).toBeNull();
  });

  it("follows the build Rust runs and shows the summary once Rust closed the call", async () => {
    await act(() =>
      fake.invoke("call_start", {
        input: { participantIds: [IGOR], projectId: EXCHANGE },
      })
    );
    const callId = fake.session.callId ?? "";
    const building = {
      callId,
      counts: null,
      stage: "summary",
      state: { status: "running" },
    };
    fake.answers.set("summary_get", () => ({ building, summary: null }));
    fake.answers.set("call_transcript", () => []);
    fake.answers.set("call_questions", () => []);
    fake.answers.set("call_cards", () => ({
      cards: [],
      next: [],
      source: "live",
    }));
    fake.answers.set("proposals_list", () => []);
    await act(() => fake.invoke("call_finish", { callId }));
    await act(() => refreshCalls());
    nav.search = new URLSearchParams({ id: callId });
    render(
      <>
        <CallSummaryPage />
        <SessionProbe />
      </>
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Собираю итоги" })
    ).toBeTruthy();
    expect(
      await screen.findByText("в работе:", { exact: false, selector: "span" })
    ).toBeTruthy();

    // Rust saves the summary, sends the last stage and closes the call.
    const call = fake.db.calls.find((item) => item.id === callId);
    fake.answers.set("summary_get", () => ({
      building: null,
      summary: {
        builtAt: 2,
        callId,
        content: { cards: [], next: [], topics: [] },
        createdAt: 1,
        error: null,
        state: "ready",
        title: "Обмен валют",
        tldr: "Договорились про курсы.",
        transcriptPass: "refined",
        updatedAt: 2,
      },
    }));
    act(() =>
      fake.emit("summary-progress", {
        ...building,
        stage: "saving",
        state: { status: "done" },
      })
    );
    if (call) {
      call.status = "finished";
    }
    act(() => fake.setSession(IDLE_SESSION));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Итоги звонка" })
    ).toBeTruthy();
    expect(screen.getByText("Договорились про курсы.")).toBeTruthy();
    await waitFor(() => expect(sessionText()).toBe("idle:—"));
    // The window neither builds nor closes the call itself.
    expect(invokedWith("call_close")).toEqual([]);
    expect(invokedWith("summary_build")).toEqual([]);
  });

  it("opens the summary of a call without a project without the demo's project", async () => {
    fake.db.calls.push(pastCall("call-alone", null, [], 60));
    await act(() => refreshCalls());
    nav.search = new URLSearchParams({ id: "call-alone" });
    render(<CallSummaryPage />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Итоги звонка" })
    ).toBeTruthy();
    expect(screen.getAllByText(NO_PROJECT).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(DEMO_PROJECT);
  });

  it("«Удалить все данные» during a call: Rust refuses, the call goes on", async () => {
    await act(() =>
      fake.invoke("call_start", {
        input: { participantIds: [OLGA], projectId: TELEMEDIA },
      })
    );
    fake.invoked.length = 0;
    fake.failures.set("data_delete_all", {
      kind: "Invalid",
      message: "Идёт звонок: завершите его, потом удаляйте данные",
    });
    const add = vi.spyOn(toast, "add");
    const user = userEvent.setup();
    render(
      <>
        <PrivacySection />
        <SessionProbe />
      </>
    );
    await waitFor(() => expect(sessionText()).toMatch("live:"));

    await user.click(screen.getByRole("button", { name: "Очистить всё" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить всё из Grill?",
    });
    await user.type(within(dialog).getByRole("textbox"), "удалить");
    await user.click(
      within(dialog).getByRole("button", { name: "Удалить всё" })
    );

    await waitFor(
      () =>
        expect(add).toHaveBeenCalledWith(
          expect.objectContaining({
            description: "Идёт звонок: завершите его, потом удаляйте данные",
            title: "Сначала завершите звонок",
          })
        ),
      DELETE_TIMEOUT
    );
    expect(invokedWith("data_delete_all")).toHaveLength(1);
    expect(invokedWith("call_discard")).toEqual([]);
    expect(invokedWith("projects_delete")).toEqual([]);
    // The dialog stays open over the page.
    expect(
      screen.getByRole("status", { hidden: true, name: "Сессия" }).textContent
    ).toMatch("live:");
    expect(nav.push).not.toHaveBeenCalled();
  });
});
