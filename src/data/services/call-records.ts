import { platform } from "@tauri-apps/plugin-os";
import { Context, Effect, Layer } from "effect";

import {
  type CallCards,
  type CallQuestion,
  type CallRecording,
  type CardPatch,
  commands,
  type RecordingPeaks,
  type SummaryCard,
  type TranscriptChannel,
} from "@/bindings";
import { type BackendError, call } from "@/effect/tauri";

import {
  compareIds,
  invalid,
  MockDatabase,
  type MockTables,
  notFound,
} from "./mock-database";

/*
 * What is kept of a finished call besides its summary (post-call
 * design.md, decisions 7, 9–11): its task cards, the recordings with their
 * transcript, the questions of those recordings with their moments, the
 * waveform and the audio.
 *
 * - `cards` are the saved summary's (`source: summary`) or, before one,
 *   the fast loop's of every recording (`source: live`); `updateCard`
 *   accepts, defers, restores or renames one of them.
 * - `deleteAudio` («Удалить запись») deletes the audio files of every
 *   recording of a finished call; the transcript, summary, cards, questions
 *   and proposals stay, and the recordings read `audioDeleted`.
 * - `audioUrl` is where the main window's player reads a channel: the
 *   `grill-audio` scheme (`src-tauri/src/records/scheme.rs`) as WAV.
 *   `null` in the browser: the mock has no audio to play.
 *
 * `layerMock` reads the mock database; it holds the demo call's records
 * (`./mock-records.ts`) and no fast loop cards.
 */
export class CallRecordsData extends Context.Service<
  CallRecordsData,
  {
    readonly cards: (callId: string) => Effect.Effect<CallCards, BackendError>;
    readonly updateCard: (
      callId: string,
      cardId: string,
      patch: CardPatch
    ) => Effect.Effect<SummaryCard, BackendError>;
    /** The recordings of a call in the order they started. */
    readonly transcript: (
      callId: string
    ) => Effect.Effect<CallRecording[], BackendError>;
    readonly questions: (
      callId: string
    ) => Effect.Effect<CallQuestion[], BackendError>;
    /** `bars` (1–2000) peaks per channel, 0–1. */
    readonly peaks: (
      recordingId: string,
      bars: number
    ) => Effect.Effect<RecordingPeaks, BackendError>;
    readonly deleteAudio: (callId: string) => Effect.Effect<void, BackendError>;
    readonly audioUrl: (
      recordingId: string,
      channel: TranscriptChannel
    ) => string | null;
  }
>()("grill/data/services/CallRecordsData") {
  static readonly layerTauri = Layer.succeed(CallRecordsData, {
    audioUrl: (recordingId, channel) =>
      audioUrl(recordingId, channel, platform() === "windows"),
    cards: (callId) => call(() => commands.callCards(callId)),
    deleteAudio: (callId) =>
      Effect.asVoid(call(() => commands.callAudioDelete(callId))),
    peaks: (recordingId, bars) =>
      call(() => commands.recordingPeaks(recordingId, bars)),
    questions: (callId) => call(() => commands.callQuestions(callId)),
    transcript: (callId) => call(() => commands.callTranscript(callId)),
    updateCard: (callId, cardId, patch) =>
      call(() => commands.callCardUpdate(callId, cardId, patch)),
  });

  static readonly layerMock = Layer.effect(
    CallRecordsData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const stored = Effect.fnUntraced(function* (callId: string) {
        const found = tables.calls.get(callId);
        if (!found) {
          return yield* notFound(`Звонок ${callId} не найден`);
        }
        return found;
      });

      const transcript = Effect.fnUntraced(function* (callId: string) {
        yield* stored(callId);
        return recordingsOf(tables, callId);
      });

      const cards = Effect.fnUntraced(function* (callId: string) {
        yield* stored(callId);
        const content = tables.summaries.get(callId)?.content;
        if (content) {
          const saved: CallCards = {
            cards: content.cards,
            next: content.next,
            source: "summary",
          };
          return saved;
        }
        const live: CallCards = { cards: [], next: [], source: "live" };
        return live;
      });

      const updateCard = Effect.fnUntraced(function* (
        callId: string,
        cardId: string,
        patch: CardPatch
      ) {
        const found = yield* stored(callId);
        const summary = tables.summaries.get(callId);
        const card = summary?.content?.cards.find((item) => item.id === cardId);
        if (!(summary?.content && card)) {
          return yield* notFound(`Карточки ${cardId} нет у звонка`);
        }
        let { title } = card;
        if (patch.title !== undefined && patch.title !== null) {
          title = patch.title.trim();
          if (!title) {
            return yield* invalid("Название карточки не может быть пустым");
          }
        }
        const updated: SummaryCard = {
          ...card,
          decision: patch.decision ?? card.decision,
          title,
        };
        tables.summaries.set(callId, {
          ...summary,
          content: {
            ...summary.content,
            cards: summary.content.cards.map((item) =>
              item.id === cardId ? updated : item
            ),
          },
          updatedAt: yield* database.touch(summary.updatedAt),
        });
        yield* database.emit("call", callId, found.projectId, "updated");
        return updated;
      });

      const questions = Effect.fnUntraced(function* (callId: string) {
        yield* stored(callId);
        const order = new Map(
          recordingsOf(tables, callId).map((item, index) => [item.id, index])
        );
        return [...tables.questions.values()]
          .filter((item) => order.has(item.recordingId))
          .sort(
            (a, b) =>
              (order.get(a.recordingId) ?? 0) -
                (order.get(b.recordingId) ?? 0) ||
              a.createdAt - b.createdAt ||
              compareIds(a.id, b.id)
          );
      });

      const peaks = Effect.fnUntraced(function* (
        recordingId: string,
        bars: number
      ) {
        if (!(Number.isInteger(bars) && bars >= 1 && bars <= MAX_BARS)) {
          return yield* invalid(`Столбцов волны — от 1 до ${MAX_BARS}`);
        }
        const found = tables.recordings.get(recordingId)?.recording;
        if (!found) {
          return yield* notFound(`Запись ${recordingId} не найдена`);
        }
        if (found.audioDeleted) {
          return yield* notFound("Аудио записи удалено");
        }
        if (found.durationMs === null) {
          return yield* invalid("Запись ещё идёт");
        }
        return mockPeaks(found, bars);
      });

      const deleteAudio = Effect.fnUntraced(function* (callId: string) {
        const found = yield* stored(callId);
        if (found.status !== "finished") {
          return yield* invalid(
            "Звонок ещё не завершён: аудио удаляют после него"
          );
        }
        let deleted = 0;
        for (const [id, item] of tables.recordings) {
          if (item.callId === callId && !item.recording.audioDeleted) {
            tables.recordings.set(id, {
              ...item,
              recording: {
                ...item.recording,
                audioDeleted: true,
                meBytes: null,
                othersBytes: null,
              },
            });
            deleted += 1;
          }
        }
        if (deleted > 0) {
          yield* database.emit("call", callId, found.projectId, "updated");
        }
      });

      return CallRecordsData.of({
        audioUrl: () => null,
        cards,
        deleteAudio,
        peaks,
        questions,
        transcript,
        updateCard,
      });
    })
  );
}

/** The most bars `recording_peaks` draws. */
export const MAX_BARS = 2000;

/**
 * Where the player reads a channel of a recording: the `grill-audio`
 * scheme as WAV (`docs/spikes/audio-playback.md`). Windows' webview reaches
 * custom schemes over `http://<scheme>.localhost`.
 */
export function audioUrl(
  recordingId: string,
  channel: TranscriptChannel,
  windows: boolean
) {
  const path = `${encodeURIComponent(recordingId)}/${channel}?format=wav`;
  return windows
    ? `http://grill-audio.localhost/${path}`
    : `grill-audio://localhost/${path}`;
}

function recordingsOf(tables: MockTables, callId: string) {
  return [...tables.recordings.values()]
    .filter((item) => item.callId === callId)
    .map((item) => item.recording)
    .sort((a, b) => a.startedAt - b.startedAt || compareIds(a.id, b.id));
}

/** Silence between phrases, and how loud a phrase draws. */
const QUIET = 0.04;
const LOUD = 0.55;
const LOUDER = 0.35;
const WAVE = 7;

/** A waveform of the mock: loud where a channel speaks, quiet elsewhere. */
function mockPeaks(found: CallRecording, bars: number): RecordingPeaks {
  const durationMs = found.durationMs ?? 0;
  const channel = (name: TranscriptChannel) =>
    Array.from({ length: bars }, (_, index) => {
      const from = (index / bars) * durationMs;
      const to = ((index + 1) / bars) * durationMs;
      const speaks = found.segments.some(
        (segment) =>
          segment.channel === name &&
          segment.startMs < to &&
          segment.endMs > from
      );
      return speaks ? LOUD + LOUDER * Math.abs(Math.sin(index / WAVE)) : QUIET;
    });
  return { durationMs, me: channel("me"), others: channel("others") };
}
