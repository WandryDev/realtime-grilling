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
 * - the recording indicators show the levels and a channel's trouble.
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
const { refreshProjects } = await import("@/data/projects");
const { refreshSettings } = await import("@/data/settings");
const { routes } = await import("@/lib/routes");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const FIRST_RECORDING = `${FAKE_RECORDING_PREFIX}1`;
const MIC_RELEASED = "Микрофон больше не используется. Завершить звонок?";
const LIVE_RECORDED = /^live:fake-recording-\d+$/u;
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
