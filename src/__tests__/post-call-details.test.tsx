import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallRecording, TranscriptSegment } from "@/bindings";

/*
 * «Детали звонка» on the demo records (`call-details`): the transcript of
 * the recordings by topics, its moments (`?moment=`, ../moment.ts), the
 * questions of the call, the search in the transcript and the player's
 * two channels (../player.ts, on fake media: jsdom plays nothing).
 */

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

const { TranscriptPage } = await import(
  "@/features/post-call/pages/transcript-page"
);
const { buildTranscript, momentParam, resolveMoment } = await import(
  "@/features/post-call/moment"
);
const { matchRanges } = await import("@/features/post-call/text-match");
const { applyChannel, clockMedia, MAX_DRIFT_S, syncFollower } = await import(
  "@/features/post-call/player"
);
const { resetCalls } = await import("@/data/calls");
const { DEMO_CALL_ID } = await import("@/data/services/mock-seed");

/** The demo call's recording (`src/data/services/mock-records.ts`). */
const DEMO_RECORDING = `${DEMO_CALL_ID}-recording`;
/** «Подрядчик, но доступы есть у Игоря…», said at 12:22:51 (21:51 in). */
const ADMIN_ANSWER = "t-122251";
const ADMIN_ANSWER_MS = (21 * 60 + 51) * 1000;
const ADMIN_TEXT = /Подрядчик, но доступы есть у Игоря/u;
const ADMIN_QUESTION = /Кто администрирует amoCRM/u;
const BUSY_QUESTION = /Что происходит, если все операторы заняты/u;

function open(query: Record<string, string>) {
  search = new URLSearchParams(query);
  return render(<TranscriptPage />);
}

afterEach(() => {
  act(() => resetCalls());
});

const segment = (
  recordingId: string,
  id: string,
  channel: TranscriptSegment["channel"],
  startMs: number,
  text: string
): TranscriptSegment => ({
  callId: "call",
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
  meBytes: 1,
  othersBytes: 1,
  pass: "refined",
  segments,
  startedAt,
  transcriptState: "refined",
});

describe("the transcript of a call", () => {
  it("«Звонок с двумя записями»: both recordings in turn, each at its time", () => {
    const first = new Date(2026, 10, 3, 12, 0, 0).getTime();
    const second = new Date(2026, 10, 3, 12, 30, 0).getTime();
    const transcript = buildTranscript([
      recording("r1", first, [
        segment("r1", "s1", "me", 1000, "Начнём?"),
        segment("r1", "s2", "others", 3000, "Да."),
        segment("r1", "s3", "others", 5000, "Мы готовы."),
      ]),
      recording("r2", second, [
        segment("r2", "s4", "others", 2000, "Продолжим."),
      ]),
    ]);

    expect(transcript.sections.map((item) => item.topic.title)).toEqual([
      "Часть 1",
      "Часть 2",
    ]);
    // Adjacent phrases of one channel are one turn.
    expect(
      transcript.turns.map((turn) => [turn.speaker, turn.time, turn.text])
    ).toEqual([
      ["you", "12:00:01", "Начнём?"],
      ["client", "12:00:03", "Да. Мы готовы."],
      ["client", "12:30:02", "Продолжим."],
    ]);
  });

  it("lands on the phrase of a live segment the second pass replaced", () => {
    const transcript = buildTranscript([
      recording("r1", 0, [
        segment("r1", "refined-1", "me", 1000, "Сколько операторов?"),
        segment("r1", "refined-2", "others", 4000, "Пятеро."),
      ]),
    ]);
    const moment = resolveMoment(
      transcript,
      [],
      momentParam({ recordingId: "r1", segmentId: "live-9", startMs: 4500 })
    );
    expect(moment?.turnIds).toEqual(["refined-2"]);
    expect(moment?.at).toEqual({ recordingId: "r1", startMs: 4500 });
  });

  it("«Время пункта итогов»: opens on the phrase, the player at its time", () => {
    open({
      id: DEMO_CALL_ID,
      moment: momentParam({
        recordingId: DEMO_RECORDING,
        segmentId: ADMIN_ANSWER,
        startMs: ADMIN_ANSWER_MS,
      }),
    });

    const moment = screen.getByLabelText("Момент 12:22");
    expect(within(moment).getByText(ADMIN_TEXT)).toBeTruthy();
    const player = screen.getByRole("region", { name: "Запись звонка" });
    expect(within(player).getByText("21:51")).toBeTruthy();
    expect(within(player).getByText("40:12")).toBeTruthy();
  });

  it("«Отвеченный вопрос»: scrolls to the client's answer", () => {
    open({ id: DEMO_CALL_ID });

    fireEvent.click(screen.getByRole("button", { name: ADMIN_QUESTION }));
    const moment = screen.getByLabelText(
      "Ответ на «Кто администрирует amoCRM?»"
    );
    expect(within(moment).getByText(ADMIN_TEXT)).toBeTruthy();
    const player = screen.getByRole("region", { name: "Запись звонка" });
    expect(within(player).getByText("21:51")).toBeTruthy();
  });

  it("lists the call's questions without the hidden ones, asked ones open", () => {
    open({ id: DEMO_CALL_ID });

    const list = screen.getByRole("region", { name: "Вопросы звонка" });
    const busy = within(list).getByRole("button", {
      name: BUSY_QUESTION,
    });
    expect(
      within(busy).getByText("без ответа:", { exact: false })
    ).toBeTruthy();
    expect(within(busy).getByText("12:14")).toBeTruthy();
  });

  it("«Поиск в расшифровке»: finds the phrase whatever the case and «ё»", () => {
    expect(matchRanges("Работаем в Планфиксе", "планфикс")).toEqual([[11, 19]]);
    expect(matchRanges("Ещё раз", "еще")).toEqual([[0, 3]]);

    open({ id: DEMO_CALL_ID });
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Найти в расшифровке" }),
      { target: { value: "AMOCRM" } }
    );
    const marks = screen
      .getAllByText("amoCRM", { selector: "mark" })
      .map((mark) => mark.textContent);
    expect(marks.length).toBeGreaterThan(1);
  });

  it("finds a word in another form, as the history's search in Rust does", () => {
    // «бронь» without «ь» finds «броне», marked to the end of the word.
    expect(matchRanges("Говорили о броне на субботу", "бронь")).toEqual([
      [11, 16],
    ]);
    expect(matchRanges("Брони отменяют", "БРОНЬ")).toEqual([[0, 5]]);
    // A final vowel or «й» goes too; the rest of the query stays exact.
    expect(matchRanges("Запись к врачу", "запися")).toEqual([[0, 6]]);
    expect(matchRanges("Без лишних полей", "без лишний")).toEqual([[0, 10]]);
    // Three letters or less, or a final consonant: only as written.
    expect(matchRanges("Это его дом", "эта")).toEqual([]);
    expect(matchRanges("Касса и кассы", "касс")).toEqual([
      [0, 4],
      [8, 12],
    ]);
  });

  it("deletes the audio: the transcript stays, the player goes", async () => {
    open({ id: DEMO_CALL_ID });

    expect(
      screen.getByText("Opus, 2 канала, 13 МБ. В облако не выгружается.")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Удалить запись" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить запись звонка?",
    });
    expect(
      within(dialog).getByText(
        "Аудио 19 октября, 40 минут, 13 МБ, удалится с этого компьютера. Вернуть его не получится."
      )
    ).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Удалить запись" })
    );

    expect(screen.queryByRole("region", { name: "Запись звонка" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Запись удалена" })
    ).toBeTruthy();
    expect(screen.getByText(ADMIN_TEXT)).toBeTruthy();
  });
});

describe("the player's two channels", () => {
  const pair = () => ({ follower: clockMedia(60), lead: clockMedia(60) });

  it("«Только клиент»: the follower («Вы») is muted, the lead plays", () => {
    const channels = pair();

    applyChannel(channels, "client");
    expect(channels.follower.muted).toBe(true);
    expect(channels.lead.muted).toBe(false);

    applyChannel(channels, "you");
    expect(channels.follower.muted).toBe(false);
    expect(channels.lead.muted).toBe(true);

    applyChannel(channels, "both");
    expect(channels.follower.muted).toBe(false);
    expect(channels.lead.muted).toBe(false);
  });

  it("keeps the follower with the lead: play, pause, speed, drift", async () => {
    const channels = pair();
    await channels.lead.play();
    channels.lead.playbackRate = 2;

    expect(syncFollower(channels)).toBe(false);
    expect(channels.follower.paused).toBe(false);
    expect(channels.follower.playbackRate).toBe(2);

    // Within the tolerance it is left alone, past it it jumps.
    channels.lead.currentTime = 10;
    channels.follower.currentTime = 10 + MAX_DRIFT_S / 2;
    expect(syncFollower(channels)).toBe(false);
    channels.follower.currentTime = 10.5;
    expect(syncFollower(channels)).toBe(true);
    expect(
      Math.abs(channels.follower.currentTime - channels.lead.currentTime)
    ).toBeLessThan(MAX_DRIFT_S);

    channels.lead.pause();
    syncFollower(channels);
    expect(channels.follower.paused).toBe(true);
  });
});
