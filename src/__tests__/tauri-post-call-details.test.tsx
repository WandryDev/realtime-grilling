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
const LATE_QUESTION = /Когда запуск/u;
const TASK_CARDS_NAV = /^Карточки задач/u;
const play = () => vi.mocked(HTMLMediaElement.prototype.play);

/**
 * Calls of their own for the tests below: the per-call stores live on
 * between tests, so each opens a call no other test read.
 */
const OWN_CALLS = Array.from(
  { length: 8 },
  (_, index) => `019a0000-0000-7000-8000-0000000001${index}0`
);
let ownCalls = 0;
function ownCall() {
  const id = OWN_CALLS[ownCalls] ?? "";
  ownCalls += 1;
  return id;
}

fake.db.projects.push(fakeProject(PROJECT, "Телемедиа"));
for (const id of [CALL, ...OWN_CALLS]) {
  fake.db.calls.push({
    ...fakeCall(id, PROJECT, "Созвон про CRM"),
    endedAt: RESUMED + 60_000,
    startedAt: STARTED,
  });
}

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
  transcriptDeleted: false,
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
  play().mockClear();
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
  fake.answers.set("call_cards", () => ({
    cards: [],
    next: [],
    source: "live",
  }));
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

  it("jumps to a moment of a longer part at its time, not clamped to the part shown", async () => {
    const user = userEvent.setup();
    const long = 20 * 60_000;
    recordings = [
      recordings[0] as CallRecording,
      {
        ...recording(SECOND, RESUMED, [
          segment(SECOND, "s3", "others", 1000, "Вернулись к срокам."),
          segment(SECOND, "s4", "others", 720_000, "Запуск в марте."),
        ]),
        durationMs: long,
        endedAt: RESUMED + long,
      },
    ];
    fake.answers.set("call_questions", () => [
      question,
      {
        ...question,
        answer: { recordingId: SECOND, segmentId: "s4", startMs: 720_000 },
        id: "019a0000-0000-7000-8000-0000000000q2",
        moment: { recordingId: SECOND, segmentId: "s3", startMs: 1000 },
        recordingId: SECOND,
        text: "Когда запуск?",
      },
    ]);
    search = new URLSearchParams({ id: ownCall() });
    render(<TranscriptPage />);

    // The first part (a minute) is shown; the answer is at 12:00 of the second.
    await user.click(
      await screen.findByRole("button", { name: LATE_QUESTION })
    );
    await waitFor(() =>
      expect(channelElement("others").getAttribute("src")).toBe(
        `grill-audio://localhost/${SECOND}/others?format=wav`
      )
    );
    expect(channelElement("others").currentTime).toBe(720);
    expect(channelElement("me").currentTime).toBe(720);
    expect(
      within(screen.getByRole("region", { name: "Запись звонка" })).getByText(
        "12:00"
      )
    ).toBeTruthy();
  });

  it("plays a recording without the «Остальные» file from «Вы» alone", async () => {
    const user = userEvent.setup();
    recordings = [{ ...(recordings[0] as CallRecording), othersBytes: null }];
    search = new URLSearchParams({ id: ownCall() });
    render(<TranscriptPage />);

    expect(await screen.findByText(ANSWER)).toBeTruthy();
    expect(channelElement("me").getAttribute("src")).toBe(
      `grill-audio://localhost/${FIRST}/me?format=wav`
    );
    expect(document.querySelector('audio[data-channel="others"]')).toBeNull();
    // One channel: nothing to pick.
    expect(screen.queryByRole("button", { name: "Оба канала" })).toBeNull();
    expect(
      screen.getByText("Opus, 1 канал, 0,4 МБ. В облако не выгружается.")
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Слушать" }));
    expect(play()).toHaveBeenCalledTimes(1);
    expect(play().mock.instances[0]).toBe(channelElement("me"));
    expect(screen.getByRole("button", { name: "Пауза" })).toBeTruthy();
    expect(channelElement("me").muted).toBe(false);
  });

  it("«Послушать» (`play=1`) plays from the moment once it stands there", async () => {
    search = new URLSearchParams({
      id: CALL,
      moment: `${FIRST}@5000@s2`,
      play: "1",
    });
    render(<TranscriptPage />);

    expect(await screen.findByRole("button", { name: "Пауза" })).toBeTruthy();
    expect(channelElement("others").currentTime).toBe(5);
    // Both channels start: the lead and its follower.
    expect(play().mock.instances).toEqual([
      channelElement("others"),
      channelElement("me"),
    ]);
  });

  it("opens the moment without playing it without `play=1`", async () => {
    search = new URLSearchParams({ id: ownCall(), moment: `${FIRST}@5000@s2` });
    render(<TranscriptPage />);

    expect(await screen.findByRole("button", { name: "Слушать" })).toBeTruthy();
    expect(channelElement("others").currentTime).toBe(5);
    expect(play()).not.toHaveBeenCalled();
  });

  it("offers no playing while nothing can play: loading, a recording being written", async () => {
    let answer: (value: CallRecording[]) => void = () => undefined;
    fake.answers.set(
      "call_transcript",
      () =>
        new Promise<CallRecording[]>((resolve) => {
          answer = resolve;
        })
    );
    search = new URLSearchParams({ id: ownCall() });
    render(<TranscriptPage />);

    const toggle = (await screen.findByRole("button", {
      name: "Слушать",
    })) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.queryByRole("slider", { name: "Позиция записи" })).toBeNull();

    // Still being written: no length yet, nothing to play.
    answer([
      {
        ...(recordings[0] as CallRecording),
        durationMs: null,
        endedAt: null,
      },
    ]);
    expect(await screen.findByText(ANSWER)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Слушать" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    expect(document.querySelector("audio")).toBeNull();
  });

  it("says the position as time, names the parts menu, loads only metadata", async () => {
    search = new URLSearchParams({ id: ownCall() });
    render(<TranscriptPage />);

    const position = await screen.findByRole("slider", {
      name: "Позиция записи",
    });
    expect(position.getAttribute("aria-valuetext")).toBe("0:00 из 1:00");
    expect(
      screen.getByRole("button", { name: "Часть записи: Часть 1, 12:00" })
    ).toBeTruthy();
    expect(channelElement("others").getAttribute("preload")).toBe("metadata");
    expect(channelElement("me").getAttribute("preload")).toBe("metadata");
  });

  it("counts the call's own task cards in the sidebar", async () => {
    const card = {
      decision: "pending" as const,
      fields: [],
      id: "card",
      title: "CRM",
      topicId: "topic",
    };
    fake.answers.set("call_cards", () => ({
      cards: [card, { ...card, id: "card-2" }, { ...card, id: "card-3" }],
      next: [],
      source: "live",
    }));
    search = new URLSearchParams({ id: ownCall() });
    render(<TranscriptPage />);

    const sections = await screen.findByRole("navigation", {
      name: "Разделы звонка",
    });
    await waitFor(() =>
      expect(
        within(sections).getByRole("link", { name: TASK_CARDS_NAV }).textContent
      ).toBe("Карточки задач3")
    );
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
