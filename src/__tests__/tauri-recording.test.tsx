import { assert, it as effectIt } from "@effect/vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Effect, Fiber, Stream } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The recorder and the microphone watch in Tauri mode, over the fake IPC
 * (./helpers/fake-tauri.ts):
 * - RecordingBackend.layerTauri decodes the Rust commands and events;
 * - «Начать» starts the recording before the call, «Завершить» stops it,
 *   no microphone access keeps the call from starting;
 * - the start widget names the app holding the microphone;
 * - «Микрофон освободился» opens on a release while the call is live;
 * - the recording indicators show the levels and a channel's trouble;
 * - «Отменить завершение» records on, «Завершить» while that recording
 *   starts stops it, and ending from a window that never heard of the
 *   recording stops it too.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const win = vi.hoisted(() => ({
  hide: vi.fn(() => Promise.resolve()),
  label: "widget",
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

const { fakeProject, FAKE_RECORDING_PREFIX, IDLE_RECORDING } = await import(
  "./helpers/fake-tauri"
);
const { RecordingBackend } = await import("@/features/recording/backend");
const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { OverlayPage } = await import(
  "@/features/call-widget/pages/overlay-page"
);
const { CallPage } = await import("@/features/call/pages/call-page");
const { resetCall, startCall, useCallSession } = await import(
  "@/data/call-session"
);
const { finishRecordedCall } = await import("@/features/recording/api");
const { toast } = await import("@/components/ui/toast");
const { refreshProjects } = await import("@/data/projects");
const { refreshSettings } = await import("@/data/settings");
const { routes } = await import("@/lib/routes");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const FIRST_RECORDING = `${FAKE_RECORDING_PREFIX}1`;
const MIC_RELEASED = "Микрофон больше не используется. Завершить звонок?";
const LIVE_RECORDED = /^live:fake-recording-\d+$/u;
const LIVE = /^live:/u;
const NO_OTHERS_ACCESS = /Нет доступа к звуку собеседников/u;

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function listeners(event: string) {
  return fake.handlers.get(event)?.size ?? 0;
}

/** Waits until a screen listens to `event`. */
async function listening(event: string) {
  await waitFor(() => expect(listeners(event)).toBeGreaterThan(0));
}

function micEvent(payload: {
  app?: string | null;
  busy: boolean;
  since: number;
}) {
  act(() => fake.emit("mic-activity-changed", payload));
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

function startLiveCall(recordingId?: string) {
  act(() =>
    startCall({
      participants: ["Ольга"],
      projectId: TELEMEDIA,
      ...(recordingId ? { recordingId } : {}),
    })
  );
}

beforeEach(async () => {
  win.label = "widget";
  win.hide.mockClear();
  nav.push.mockReset();
  nav.search = new URLSearchParams();
  fake.failures.clear();
  fake.answers.clear();
  fake.recording = IDLE_RECORDING;
  fake.micActivity = { app: "Zoom", busy: true, since: Date.now() };
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа")
  );
  fake.db.settings = { onboardingCompleted: true };
  await act(() => refreshProjects());
  await act(() => refreshSettings());
  act(() => resetCall());
  fake.invoked.length = 0;
});

describe("RecordingBackend.layerTauri", () => {
  effectIt.effect("starts without a call row and decodes the status", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const id = yield* recorder.start();
      assert.isTrue(id.startsWith(FAKE_RECORDING_PREFIX));
      assert.deepStrictEqual(invokedWith("recording_start").at(-1), {
        input: { callId: null },
      });
      const status = yield* recorder.status;
      assert.strictEqual(status.id, id);
      assert.deepStrictEqual(status.channels, { me: "ok", others: "ok" });

      yield* recorder.stop(id);
      const idle = yield* recorder.status;
      assert.isNull(idle.id);
      assert.isNull(idle.startedAt);
      const unknown = yield* Effect.flip(recorder.stop("no-such-recording"));
      assert.strictEqual(unknown.kind, "NotFound");
    }).pipe(Effect.provide(RecordingBackend.layerTauri))
  );

  effectIt.effect(
    "fails a start without microphone access with the reason",
    () =>
      Effect.gen(function* () {
        fake.failures.set("recording_start", {
          kind: "External",
          message: "Нет доступа к микрофону",
          reason: "noAccess",
        });
        const recorder = yield* RecordingBackend;
        const error = yield* Effect.flip(recorder.start());
        assert.strictEqual(error.kind, "External");
        assert.strictEqual(error.reason, "noAccess");
      }).pipe(Effect.provide(RecordingBackend.layerTauri))
  );

  effectIt.effect(
    "watches the status from before it reads it: a change during the read wins",
    () =>
      Effect.gen(function* () {
        const recorder = yield* RecordingBackend;
        const newer = {
          channels: { me: "ok", others: "ok" },
          id: "r2",
          segmentation: "ok",
          startedAt: 7,
        } as const;
        // Rust records and announces it while the read is on its way back
        // with the older status.
        fake.answers.set("recording_status", () => {
          fake.emit("recording-changed", newer);
          return IDLE_RECORDING;
        });
        const during = yield* Stream.runCollect(
          Stream.take(recorder.watchStatus, 1)
        );
        assert.deepStrictEqual(during, [newer]);
        fake.answers.delete("recording_status");

        // Nothing changes: the read comes first, then the changes.
        const watched = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(recorder.watchStatus, 2))
        );
        yield* Effect.promise(() =>
          waitFor(() => expect(listeners("recording-changed")).toBe(1))
        );
        yield* Effect.promise(() =>
          waitFor(() => expect(invokedWith("recording_status")).toHaveLength(2))
        );
        yield* Effect.yieldNow;
        fake.emit("recording-changed", newer);
        const [read, change] = yield* Fiber.join(watched);
        assert.isNull(read?.id);
        assert.strictEqual(change?.id, "r2");

        // The same for the microphone.
        fake.answers.set("mic_activity_get", () => {
          fake.emit("mic-activity-changed", { busy: false, since: 9 });
          return { app: "Zoom", busy: true, since: 1 };
        });
        const activity = yield* Stream.runCollect(
          Stream.take(recorder.watchMicActivity, 1)
        );
        assert.deepStrictEqual(activity, [
          { app: null, busy: false, since: 9 },
        ]);
      }).pipe(Effect.provide(RecordingBackend.layerTauri))
  );

  effectIt.effect("decodes the events of the recorder and the microphone", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const take = <A, E>(stream: Stream.Stream<A, E>) =>
        Effect.forkChild(Stream.runCollect(Stream.take(stream, 1)));
      const changes = yield* take(recorder.changes);
      const levels = yield* take(recorder.levels);
      const activity = yield* take(recorder.micActivity);
      yield* Effect.promise(() =>
        waitFor(() => {
          expect(listeners("recording-changed")).toBe(1);
          expect(listeners("recording-levels")).toBe(1);
          expect(listeners("mic-activity-changed")).toBe(1);
        })
      );

      fake.emit("recording-changed", {
        channels: { me: "ok", others: "noAccess" },
        id: "r1",
        segmentation: "unavailable",
        startedAt: 5,
      });
      fake.emit("recording-levels", { me: 0.25, others: 0.5 });
      fake.emit("mic-activity-changed", { busy: false, since: 9 });

      assert.deepStrictEqual(yield* Fiber.join(changes), [
        {
          channels: { me: "ok", others: "noAccess" },
          id: "r1",
          segmentation: "unavailable",
          startedAt: 5,
        },
      ]);
      assert.deepStrictEqual(yield* Fiber.join(levels), [
        { me: 0.25, others: 0.5 },
      ]);
      assert.deepStrictEqual(yield* Fiber.join(activity), [
        { app: null, busy: false, since: 9 },
      ]);
      // The streams ended: their listeners are gone.
      assert.strictEqual(listeners("recording-levels"), 0);
    }).pipe(Effect.provide(RecordingBackend.layerTauri))
  );
});

describe("start widget", () => {
  it("starts the recording, then the call with it; «Завершить» stops it", async () => {
    render(
      <>
        <StartWidgetPage />
        <SessionProbe />
      </>
    );
    await screen.findByText("Телемедиа");

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));

    await waitFor(() => expect(sessionText()).toMatch(LIVE_RECORDED));
    const recordingId = fake.recording.id;
    expect(sessionText()).toBe(`live:${recordingId}`);
    expect(invokedWith("recording_start")).toEqual([
      { input: { callId: null } },
    ]);
    await waitFor(() =>
      expect(invokedWith("windows_show")).toEqual([
        { label: "overlay", route: null },
      ])
    );

    // The overlay window takes the call over; it ends once the meeting
    // app lets the microphone go.
    win.label = "overlay";
    render(<OverlayPage />);
    await listening("mic-activity-changed");
    micEvent({ app: "Zoom", busy: false, since: Date.now() });
    fireEvent.click(await screen.findByRole("button", { name: "Завершить" }));

    await waitFor(() =>
      expect(invokedWith("recording_stop")).toEqual([{ id: recordingId }])
    );
    expect(sessionText()).toBe(`finishing:${recordingId}`);
  });

  it("keeps the call from starting without microphone access", async () => {
    fake.failures.set("recording_start", {
      kind: "External",
      message: "Нет доступа к микрофону",
      reason: "noAccess",
    });
    render(
      <>
        <StartWidgetPage />
        <SessionProbe />
      </>
    );
    await screen.findByText("Телемедиа");

    fireEvent.click(screen.getByRole("button", { name: "Начать" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Нет доступа к микрофону");
    expect(sessionText()).toBe("idle:—");
    expect(invokedWith("windows_show")).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Открыть настройки" }));
    await waitFor(() =>
      expect(invokedWith("windows_show")).toEqual([
        { label: "main", route: routes.onboarding("permissions") },
      ])
    );
  });

  it("names the app holding the microphone, as it changes", async () => {
    fake.micActivity = { app: "Telegram", busy: true, since: Date.now() };
    render(<StartWidgetPage />);

    expect(await screen.findByText("Telegram", { exact: false })).toBeTruthy();
    await listening("mic-activity-changed");

    micEvent({ app: "Google Chrome", busy: true, since: Date.now() });

    expect(
      await screen.findByText("Google Chrome", { exact: false })
    ).toBeTruthy();
    expect(screen.queryByText("Telegram", { exact: false })).toBeNull();
  });
});

describe("«Микрофон освободился» in the overlay", () => {
  beforeEach(() => {
    win.label = "overlay";
  });

  it("opens on a release while the call is live; «Продолжить» hides it", async () => {
    startLiveCall();
    render(<OverlayPage />);
    await listening("mic-activity-changed");

    micEvent({ app: "Google Chrome", busy: false, since: Date.now() });

    expect(
      await screen.findByRole("heading", { level: 1, name: MIC_RELEASED })
    ).toBeTruthy();
    expect(
      screen.getByText("Google Chrome отпустил микрофон", { exact: false })
    ).toBeTruthy();
    // "Завершать звонок сам" is 10 minutes by default.
    expect(screen.getByText("10:00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(
      screen.queryByRole("heading", { level: 1, name: MIC_RELEASED })
    ).toBeNull();

    // Only the next busy → free opens it again.
    micEvent({ app: "Google Chrome", busy: true, since: Date.now() });
    expect(
      screen.queryByRole("heading", { level: 1, name: MIC_RELEASED })
    ).toBeNull();
    micEvent({ app: "Google Chrome", busy: false, since: Date.now() });
    expect(
      await screen.findByRole("heading", { level: 1, name: MIC_RELEASED })
    ).toBeTruthy();
  });

  it("ignores a release without a live call", async () => {
    render(<OverlayPage />);
    await listening("mic-activity-changed");

    micEvent({ app: "Zoom", busy: false, since: Date.now() });

    await act(() => Promise.resolve());
    expect(
      screen.queryByRole("heading", { level: 1, name: MIC_RELEASED })
    ).toBeNull();
  });

  it("shows the levels and a channel without access on the indicator", async () => {
    fake.recording = {
      channels: { me: "ok", others: "noAccess" },
      id: FIRST_RECORDING,
      segmentation: "ok",
      startedAt: Date.now(),
      transcription: { state: "ok" },
    };
    startLiveCall(FIRST_RECORDING);
    render(<OverlayPage />);

    expect(
      await screen.findByRole("timer", {
        name: NO_OTHERS_ACCESS,
      })
    ).toBeTruthy();
    await listening("recording-levels");

    act(() => fake.emit("recording-levels", { me: 1, others: 0 }));

    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="recording-indicator-level"]')
      ).not.toBeNull()
    );
  });
});

describe("«Микрофон освободился» in the call window", () => {
  beforeEach(() => {
    win.label = "main";
  });

  it("opens with the app and the countdown from Settings", async () => {
    fake.db.settings = { autoEnd: "5", onboardingCompleted: true };
    await act(() => refreshSettings());
    startLiveCall();
    render(<CallPage />);
    await listening("mic-activity-changed");

    micEvent({ app: "Google Chrome", busy: false, since: Date.now() });

    const panel = await screen.findByRole("region", { name: MIC_RELEASED });
    expect(panel.textContent).toContain("Google Chrome отпустил микрофон");
    expect(panel.textContent).toContain("5:00");
    expect(panel.textContent).not.toContain("6:48");

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    expect(screen.queryByRole("region", { name: MIC_RELEASED })).toBeNull();
  });

  it("ignores a release once the call is finishing", async () => {
    startLiveCall();
    render(<CallPage />);
    await listening("mic-activity-changed");

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    micEvent({ app: "Zoom", busy: false, since: Date.now() });

    await act(() => Promise.resolve());
    expect(screen.queryByRole("region", { name: MIC_RELEASED })).toBeNull();
  });
});

describe("the call and its recording", () => {
  beforeEach(() => {
    win.label = "main";
  });

  /** Starts a recording in the fake recorder, as the widget's «Начать». */
  async function runningRecording(): Promise<string> {
    const id = await fake.invoke("recording_start", {
      input: { callId: null },
    });
    fake.invoked.length = 0;
    return String(id);
  }

  /** `recording_start` waits until the returned function gives its id. */
  function holdStart() {
    let give: (id: string) => void = () => undefined;
    fake.answers.set(
      "recording_start",
      () =>
        new Promise<string>((resolve) => {
          give = (id) => {
            fake.recording = { ...IDLE_RECORDING, id, startedAt: Date.now() };
            resolve(id);
          };
        })
    );
    return (id: string) => give(id);
  }

  it("«Отменить завершение» records on into a new recording", async () => {
    const first = await runningRecording();
    startLiveCall(first);
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );

    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await waitFor(() =>
      expect(invokedWith("recording_stop")).toEqual([{ id: first }])
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить завершение" })
    );

    await waitFor(() => expect(sessionText()).toMatch(LIVE_RECORDED));
    expect(sessionText()).not.toBe(`live:${first}`);
    expect(sessionText()).toBe(`live:${fake.recording.id}`);
  });

  it("stops the new recording when «Завершить» comes while it starts", async () => {
    const first = await runningRecording();
    startLiveCall(first);
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await waitFor(() =>
      expect(invokedWith("recording_stop")).toEqual([{ id: first }])
    );

    const give = holdStart();
    fireEvent.click(
      await screen.findByRole("button", { name: "Отменить завершение" })
    );
    await waitFor(() => expect(invokedWith("recording_start")).toHaveLength(1));
    // The start takes its time; the call ends again meanwhile.
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await act(async () => {
      give("late-recording");
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(invokedWith("recording_stop")).toContainEqual({
        id: "late-recording",
      })
    );
    expect(sessionText()).toBe(`finishing:${first}`);
  });

  it("says why the recording did not start again", async () => {
    const add = vi.spyOn(toast, "add");
    const first = await runningRecording();
    startLiveCall(first);
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    fake.failures.set("recording_start", {
      kind: "External",
      message: "Нет доступа к микрофону",
      reason: "noAccess",
    });
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
    expect(sessionText()).toMatch(LIVE);
    add.mockRestore();
  });

  it("says so when a recording does not stop", async () => {
    const add = vi.spyOn(toast, "add");
    const first = await runningRecording();
    startLiveCall(first);
    fake.failures.set("recording_stop", {
      kind: "Storage",
      message: "Диск занят",
    });

    await act(() => finishRecordedCall());

    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Диск занят",
        title: "Запись не остановилась",
        type: "error",
      })
    );
    add.mockRestore();
  });

  it("stops the running recording from a window that never heard of it", async () => {
    const first = await runningRecording();
    // This window's session has the call but not its recording.
    startLiveCall();

    await act(() => finishRecordedCall());

    expect(invokedWith("recording_stop")).toEqual([{ id: first }]);
    expect(fake.recording.id).toBeUndefined();
  });

  it("the call window takes over the running recording when it opens", async () => {
    const first = await runningRecording();
    render(
      <>
        <CallPage />
        <SessionProbe />
      </>
    );

    await waitFor(() => expect(sessionText()).toBe(`live:${first}`));
  });
});
