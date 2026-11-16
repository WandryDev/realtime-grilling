import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RecordingStatus, TranscriptSegment } from "@/bindings";

/*
 * The call window's transcript in Tauri mode, over the fake IPC
 * (./helpers/fake-tauri.ts): the recording running now is read first, then
 * the recognizer's events change the feed (speech-recognition design.md,
 * decision 17). The script's agent goes on without its demo phrases.
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

const { currentCallSession, followCallSession } = await import(
  "@/data/call-session"
);
const { IDLE_RECORDING, IDLE_SESSION, fakeProject, liveSession } = await import(
  "./helpers/fake-tauri"
);
const { CallPage } = await import("@/features/call/pages/call-page");
const { refreshProjects } = await import("@/data/projects");
const { refreshSettings } = await import("@/data/settings");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const RECORDING = "019a0000-0000-7000-8000-0000000000aa";
const OTHER_RECORDING = "019a0000-0000-7000-8000-0000000000bb";
const DEMO_PHRASE =
  "Добрый день! Да, слышно отлично. Игорь тоже подключился, с телефона.";

const RECORDING_NOW: RecordingStatus = {
  ...IDLE_RECORDING,
  id: RECORDING,
  startedAt: Date.now(),
};

function segment(
  channel: "me" | "others",
  startMs: number,
  text: string
): TranscriptSegment {
  return {
    callId: null,
    channel,
    createdAt: 1,
    endMs: startMs + 1500,
    id: `segment-${channel}-${startMs}`,
    pass: "live",
    recordingId: RECORDING,
    startMs,
    text,
    updatedAt: 1,
  };
}

/** Plays a Rust event and lets the stream fibers apply it. */
async function emit(event: string, payload: unknown) {
  await act(async () => {
    fake.emit(event, payload);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function listeners(event: string) {
  return fake.handlers.get(event)?.size ?? 0;
}

/** Renders the call window and waits until it hears the recognizer. */
async function openCall() {
  render(<CallPage />);
  await waitFor(() =>
    expect(listeners("transcript-phrase")).toBeGreaterThan(0)
  );
}

function transcript() {
  return screen.getByRole("region", { name: "Расшифровка" });
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
  fake.answers.set("transcript_for_recording", () => []);
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
  act(() => fake.setSession(IDLE_SESSION));
  fake.recording = IDLE_RECORDING;
});

describe("call transcript in Tauri", () => {
  it("reads the recording's stored phrases when it opens mid-call", async () => {
    fake.answers.set("transcript_for_recording", () => [
      segment("me", 0, "Добрый день, слышно меня?"),
      segment("others", 2000, "Да, отлично слышно"),
    ]);
    await openCall();

    expect(await screen.findByText("Добрый день, слышно меня?")).toBeTruthy();
    expect(screen.getByText("Да, отлично слышно")).toBeTruthy();
    expect(
      fake.invoked.filter((call) => call.command === "transcript_for_recording")
    ).toEqual([
      { args: { recordingId: RECORDING }, command: "transcript_for_recording" },
    ]);
    // No demo phrases: the transcript is the recognizer's
    expect(screen.queryByText(DEMO_PHRASE)).toBeNull();
  });

  it("shows «расшифровываю», then the text in the same message", async () => {
    await openCall();

    await emit("transcript-pending", {
      channel: "others",
      recordingId: RECORDING,
      startMs: 4000,
    });
    await waitFor(() =>
      expect(transcript().textContent).toContain("Клиентрасшифровываю")
    );

    // Another recording's events are not this call's
    await emit("transcript-phrase", {
      channel: "others",
      endMs: 5000,
      id: "segment-x",
      pass: "live",
      recordingId: OTHER_RECORDING,
      startMs: 4000,
      text: "Чужая фраза",
    });
    expect(screen.queryByText("Чужая фраза")).toBeNull();

    await emit("transcript-phrase", {
      channel: "others",
      endMs: 9000,
      id: "segment-1",
      pass: "live",
      recordingId: RECORDING,
      startMs: 4000,
      text: "Пятеро операторов на старте",
    });
    expect(await screen.findByText("Пятеро операторов на старте")).toBeTruthy();
    await waitFor(() =>
      expect(transcript().textContent).not.toContain("расшифровываю")
    );

    // "Я" is "Вы"
    await emit("transcript-pending", {
      channel: "me",
      recordingId: RECORDING,
      startMs: 9500,
    });
    await waitFor(() =>
      expect(transcript().textContent).toContain("Вырасшифровываю")
    );
    await emit("transcript-phrase", {
      channel: "me",
      endMs: 11_000,
      id: "segment-2",
      pass: "live",
      recordingId: RECORDING,
      startMs: 9500,
      text: "А к лету?",
    });
    expect(await screen.findByText("А к лету?")).toBeTruthy();
    await waitFor(() =>
      expect(transcript().textContent).not.toContain("расшифровываю")
    );
  });

  it("removes a dropped phrase and marks a skipped one", async () => {
    await openCall();

    await emit("transcript-pending", {
      channel: "others",
      recordingId: RECORDING,
      startMs: 1000,
    });
    await emit("transcript-dropped", {
      channel: "others",
      recordingId: RECORDING,
      startMs: 1000,
    });
    await waitFor(() =>
      expect(transcript().textContent).not.toContain("расшифровываю")
    );

    await emit("transcript-pending", {
      channel: "others",
      recordingId: RECORDING,
      startMs: 3000,
    });
    await emit("transcript-skipped", {
      channel: "others",
      endMs: 15_000,
      recordingId: RECORDING,
      startMs: 3000,
    });
    expect(
      await screen.findByText("Пропущено, расшифрую после звонка")
    ).toBeTruthy();
    expect(screen.getByText("0:12")).toBeTruthy();
    await waitFor(() =>
      expect(transcript().textContent).not.toContain("расшифровываю")
    );
  });

  it("leaves the last recording's unfinished phrases «пропущено» when a new one takes over", async () => {
    await openCall();
    await emit("transcript-pending", {
      channel: "others",
      recordingId: RECORDING,
      startMs: 4000,
    });
    await emit("transcript-pending", {
      channel: "me",
      recordingId: RECORDING,
      startMs: 6000,
    });
    await emit("transcript-phrase", {
      channel: "me",
      endMs: 7000,
      id: "segment-1",
      pass: "live",
      recordingId: RECORDING,
      startMs: 6000,
      text: "Успел до конца",
    });
    expect(await screen.findByText("Успел до конца")).toBeTruthy();

    // "Отменить завершение": the next recording's events from now on.
    await emit("recording-changed", {
      ...RECORDING_NOW,
      id: OTHER_RECORDING,
    });
    expect(
      await screen.findByText("Пропущено, расшифрую после звонка")
    ).toBeTruthy();
    await waitFor(() =>
      expect(transcript().textContent).not.toContain("расшифровываю")
    );
    expect(screen.getByText("Успел до конца")).toBeTruthy();
    expect(
      screen.queryByText("Ваша фраза пропущена, расшифрую после звонка")
    ).toBeNull();
  });

  it("says how far the transcript lags, until it catches up", async () => {
    await openCall();

    await emit("transcript-lag", { recordingId: RECORDING, seconds: 40 });
    expect(
      await screen.findByText("Расшифровка отстаёт на 40 секунд")
    ).toBeTruthy();

    await emit("transcript-lag", { recordingId: RECORDING, seconds: 0 });
    await waitFor(() =>
      expect(screen.queryByText("Расшифровка отстаёт на 40 секунд")).toBeNull()
    );
  });

  it("says the model is missing, with the way to Settings", async () => {
    fake.recording = {
      ...RECORDING_NOW,
      transcription: { model: "turbo", state: "noModel" },
    };
    await openCall();

    expect(
      await screen.findByText("Модель распознавания не установлена")
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Открыть настройки" })
        .getAttribute("href")
    ).toBe("/settings/audio");

    // The model loads after all: the notice goes
    await emit("recording-changed", {
      ...RECORDING_NOW,
      transcription: { model: "turbo", state: "ok" },
    });
    await waitFor(() =>
      expect(
        screen.queryByText("Модель распознавания не установлена")
      ).toBeNull()
    );
  });
});
