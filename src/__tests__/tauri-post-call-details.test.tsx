import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  CallQuestion,
  CallRecording,
  CallSummaryView,
  TranscriptSegment,
} from "@/bindings";

/*
 * «Детали звонка» in Tauri, over the fake IPC (./helpers/fake-tauri.ts):
 * the page reads `call_transcript`, `call_questions` and `summary_get`,
 * plays the two channel files of a part in two `<audio>` elements of the
 * `grill-audio` scheme, and «Удалить запись» runs `call_audio_delete`;
 * after it the call has no player, its transcript stays.
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
  usePathname: () => "/calls/transcript",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => search,
}));

const { fakeCall, fakeProject } = await import("./helpers/fake-tauri");
const { TranscriptPage } = await import(
  "@/features/post-call/pages/transcript-page"
);

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const CALL = "019a0000-0000-7000-8000-0000000000c1";
const FIRST = "019a0000-0000-7000-8000-0000000000a1";
const SECOND = "019a0000-0000-7000-8000-0000000000a2";
const STARTED = new Date(2026, 10, 3, 12, 0, 0).getTime();
const RESUMED = new Date(2026, 10, 3, 12, 30, 0).getTime();
const ANSWER = /Подрядчик держит amoCRM/u;
const FIRST_PART = /Часть 1/u;
const SECOND_PART = /Часть 2/u;
const QUESTION = /Кто администрирует amoCRM/u;

fake.db.projects.push(fakeProject(PROJECT, "Телемедиа"));
fake.db.calls.push({
  ...fakeCall(CALL, PROJECT, "Созвон про CRM"),
  endedAt: RESUMED + 60_000,
  startedAt: STARTED,
});

const segment = (
  recordingId: string,
  id: string,
  channel: TranscriptSegment["channel"],
  startMs: number,
  text: string
): TranscriptSegment => ({
  callId: CALL,
  channel,
  createdAt: 0,
  endMs: startMs + 2000,
  id,
  pass: "refined",
  recordingId,
  startMs,
  text,
  updatedAt: 0,
});

const recording = (
  id: string,
  startedAt: number,
  segments: TranscriptSegment[]
): CallRecording => ({
  audioDeleted: false,
  durationMs: 60_000,
  endedAt: startedAt + 60_000,
  id,
  meBytes: 400_000,
  othersBytes: 600_000,
  pass: "refined",
  segments,
  startedAt,
  transcriptState: "refined",
});

let recordings: CallRecording[] = [];

const question: CallQuestion = {
  answer: { recordingId: FIRST, segmentId: "s2", startMs: 5000 },
  answerEvidence: [],
  cardField: "integrations",
  cardId: null,
  createdAt: 1,
  description: "",
  evidence: [],
  gapType: "empty",
  id: "019a0000-0000-7000-8000-0000000000q1",
  moment: { recordingId: FIRST, segmentId: "s1", startMs: 2000 },
  priority: 1,
  recordingId: FIRST,
  status: "answered",
  text: "Кто администрирует amoCRM?",
  topicId: null,
  updatedAt: 1,
};

const NO_SUMMARY: CallSummaryView = { building: null, summary: null };

beforeAll(() => {
  // jsdom has no media playback.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockReturnValue(undefined);
});

beforeEach(() => {
  recordings = [
    recording(FIRST, STARTED, [
      segment(FIRST, "s1", "me", 2000, "Кто у вас администрирует amoCRM?"),
      segment(FIRST, "s2", "others", 5000, "Подрядчик держит amoCRM."),
    ]),
    recording(SECOND, RESUMED, [
      segment(SECOND, "s3", "others", 1000, "Вернулись к срокам."),
    ]),
  ];
  fake.invoked.length = 0;
  fake.answers.clear();
  fake.answers.set("call_transcript", () => recordings);
  fake.answers.set("call_questions", () => [question]);
  fake.answers.set("summary_get", () => NO_SUMMARY);
  fake.answers.set("proposals_list", () => []);
  fake.answers.set("recording_peaks", () => ({
    durationMs: 60_000,
    me: [0.2, 0.4],
    others: [0.8, 0.1],
  }));
  fake.answers.set("call_audio_delete", () => {
    recordings = recordings.map((item) => ({
      ...item,
      audioDeleted: true,
      meBytes: null,
      othersBytes: null,
    }));
    fake.dataChanged({
      change: "updated",
      entity: "call",
      id: CALL,
      projectId: PROJECT,
    });
    return null;
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function channelElement(channel: "me" | "others") {
  const element = document.querySelector<HTMLAudioElement>(
    `audio[data-channel="${channel}"]`
  );
  if (!element) {
    throw new Error(`No <audio> of ${channel}`);
  }
  return element;
}

describe("call details in Tauri", () => {
  it("plays a part's two channels; «Только клиент» mutes the follower", async () => {
    const user = userEvent.setup();
    search = new URLSearchParams({ id: CALL });
    render(<TranscriptPage />);

    expect(await screen.findByText(ANSWER)).toBeTruthy();
    // The second recording follows the first, at its own time.
    expect(screen.getByText("12:30:01")).toBeTruthy();
    expect(channelElement("others").getAttribute("src")).toBe(
      `grill-audio://localhost/${FIRST}/others?format=wav`
    );
    expect(channelElement("me").getAttribute("src")).toBe(
      `grill-audio://localhost/${FIRST}/me?format=wav`
    );
    expect(
      screen.getByText(
        "2 части, Opus, 2 канала, 2,0 МБ. В облако не выгружается."
      )
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Оба канала" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Только клиент" })
    );
    expect(channelElement("me").muted).toBe(true);
    expect(channelElement("others").muted).toBe(false);

    // The parts switcher plays the recording after «Отменить завершение».
    await user.click(screen.getByRole("button", { name: FIRST_PART }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: SECOND_PART })
    );
    await waitFor(() =>
      expect(channelElement("others").getAttribute("src")).toBe(
        `grill-audio://localhost/${SECOND}/others?format=wav`
      )
    );
    expect(channelElement("me").muted).toBe(true);
  });

  it("opens an answered question at the client's answer", async () => {
    const user = userEvent.setup();
    search = new URLSearchParams({ id: CALL });
    render(<TranscriptPage />);

    await user.click(await screen.findByRole("button", { name: QUESTION }));
    const moment = screen.getByLabelText(
      "Ответ на «Кто администрирует amoCRM?»"
    );
    expect(within(moment).getByText(ANSWER)).toBeTruthy();
    expect(channelElement("others").currentTime).toBe(5);
  });

  it("deletes the audio of every recording, the transcript stays", async () => {
    const user = userEvent.setup();
    search = new URLSearchParams({ id: CALL });
    render(<TranscriptPage />);

    await user.click(
      await screen.findByRole("button", { name: "Удалить запись" })
    );
    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить запись звонка?",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Удалить запись" })
    );

    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Запись звонка" })).toBeNull()
    );
    expect(
      fake.invoked.filter((item) => item.command === "call_audio_delete")
    ).toEqual([{ args: { callId: CALL }, command: "call_audio_delete" }]);
    expect(
      screen.getByRole("heading", { name: "Запись удалена" })
    ).toBeTruthy();
    expect(screen.getByText(ANSWER)).toBeTruthy();
    expect(document.querySelector("audio")).toBeNull();
  });
});
