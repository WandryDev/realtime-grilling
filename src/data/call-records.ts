"use client";

import { Effect, Exit } from "effect";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  CallCards,
  CallQuestion,
  CallRecording,
  CallSearch,
  CardPatch,
  RecordingPeaks,
  TranscriptChannel,
} from "@/bindings";
import {
  type AppServices,
  appRuntime,
  inTauri,
  runCancelable,
} from "@/effect/runtime";
import type { BackendError } from "@/effect/tauri";

import { CallRecordsData } from "./services/call-records";
import { CallsData } from "./services/calls";
import {
  backendErrorOf,
  createSyncedStores,
  type Synced,
  type SyncedStore,
  useSyncedState,
} from "./synced-store";

/*
 * What the post-call pages read about a finished call besides its summary
 * (post-call design.md, decisions 7, 9–11): the task cards, the recordings
 * with their transcript, the questions with their moments, the waveform,
 * the audio of the player, and the search of the history.
 *
 * Cards, transcript and questions are synced stores per call: they re-read
 * on the call's `DataChanged` (a card decision, a build, deleted audio)
 * and on changes of their own records (the fast loop's cards, a second pass
 * writing the transcript, a question answered). The waveform and the
 * search are one-off reads of their arguments. In the browser all of them
 * read the demo records synchronously.
 */

const NO_CARDS: CallCards = { cards: [], next: [], source: "live" };
const NONE_CARDS: Synced<CallCards> = { data: NO_CARDS, status: "ready" };
const NONE_RECORDINGS: Synced<CallRecording[]> = { data: [], status: "ready" };
const NONE_QUESTIONS: Synced<CallQuestion[]> = { data: [], status: "ready" };

const callCards = createSyncedStores((callId) => {
  const read = CallRecordsData.use((data) => data.cards(callId));
  return {
    empty: NO_CARDS,
    live: inTauri,
    onChange: (change) =>
      (change.entity === "call" && change.id === callId) ||
      change.entity === "taskCard" ||
      change.entity === "topic"
        ? { update: Effect.map(read, (cards) => () => cards) }
        : undefined,
    read,
    runtime: appRuntime,
    seed: () => NO_CARDS,
  };
});

const callTranscript: (
  callId: string
) => SyncedStore<CallRecording[], CallRecordsData> = createSyncedStores(
  (callId) => {
    const read = CallRecordsData.use((data) => data.transcript(callId));
    return {
      empty: [] as CallRecording[],
      live: inTauri,
      onChange: (change) => {
        const own =
          (change.entity === "call" && change.id === callId) ||
          (change.entity === "transcript" &&
            callTranscript(callId)
              .get()
              .some((recording) => recording.id === change.id));
        return own
          ? { update: Effect.map(read, (recordings) => () => recordings) }
          : undefined;
      },
      read,
      runtime: appRuntime,
      seed: () => [] as CallRecording[],
    };
  }
);

const callQuestions: (
  callId: string
) => SyncedStore<CallQuestion[], CallRecordsData> = createSyncedStores(
  (callId) => {
    const read = CallRecordsData.use((data) => data.questions(callId));
    return {
      empty: [] as CallQuestion[],
      live: inTauri,
      onChange: (change) => {
        const own =
          (change.entity === "call" && change.id === callId) ||
          (change.entity === "question" &&
            callQuestions(callId)
              .get()
              .some((question) => question.id === change.id));
        return own
          ? { update: Effect.map(read, (questions) => () => questions) }
          : undefined;
      },
      read,
      runtime: appRuntime,
      seed: () => [] as CallQuestion[],
    };
  }
);

/**
 * The task cards of a call: the saved summary's (`source: summary`, with
 * the questions for the next call) or, before one, the fast loop's.
 */
export function useCallCards(
  callId: string | null | undefined
): Synced<CallCards> {
  return useSyncedState(callId ? callCards(callId) : undefined, NONE_CARDS);
}

/** Accepts, defers, restores or renames a card; the card as stored. */
export function updateCallCard(
  callId: string,
  cardId: string,
  patch: CardPatch
) {
  return callCards(callId).mutate(
    CallRecordsData.use((data) => data.updateCard(callId, cardId, patch)),
    { error: "Не удалось сохранить карточку задачи" }
  );
}

/**
 * The recordings of a call in the order they started, each with its
 * transcript (refined where the second pass is done), times, sizes and
 * whether its audio was deleted.
 */
export function useCallTranscript(
  callId: string | null | undefined
): Synced<CallRecording[]> {
  return useSyncedState(
    callId ? callTranscript(callId) : undefined,
    NONE_RECORDINGS
  );
}

/** The questions of a call with the moments of their evidence and answer. */
export function useCallQuestions(
  callId: string | null | undefined
): Synced<CallQuestion[]> {
  return useSyncedState(
    callId ? callQuestions(callId) : undefined,
    NONE_QUESTIONS
  );
}

/**
 * «Удалить запись»: deletes the audio of every recording of a finished
 * call. `true` once deleted; `false` when it failed (a toast says why).
 */
export async function deleteCallAudio(callId: string) {
  const deleted = await callTranscript(callId).mutate(
    CallRecordsData.use((data) => Effect.as(data.deleteAudio(callId), true)),
    { error: "Не удалось удалить запись" }
  );
  return deleted === true;
}

/** Whether the recordings of a call read without audio, as last read. */
export function isCallAudioDeleted(callId: string) {
  const recordings = callTranscript(callId).get();
  return (
    recordings.length > 0 &&
    recordings.every((recording) => recording.audioDeleted)
  );
}

/**
 * Where the player reads a channel of a recording (the `grill-audio`
 * scheme as WAV); `null` in the browser, which has no audio to play.
 */
export function recordingAudioUrl(
  recordingId: string,
  channel: TranscriptChannel
): string | null {
  return appRuntime.runSync(
    CallRecordsData.use((data) =>
      Effect.sync(() => data.audioUrl(recordingId, channel))
    )
  );
}

/**
 * A one-off read for `key` (its arguments): synchronous on the mock,
 * `loading` until Rust answers in Tauri. A new key reads again; the read of
 * an old key is interrupted.
 */
function useRead<A>(
  key: string | undefined,
  read: () => Effect.Effect<A, BackendError, AppServices>,
  empty: A
): Synced<A> {
  const reader = useRef(read);
  reader.current = read;
  const mock = useMemo((): Synced<A> | undefined => {
    if (inTauri || key === undefined) {
      return;
    }
    const exit = appRuntime.runSyncExit(reader.current());
    return Exit.isSuccess(exit)
      ? { data: exit.value, status: "ready" }
      : { data: empty, error: backendErrorOf(exit), status: "error" };
  }, [key, empty]);
  const [live, setLive] = useState<{ key?: string; state: Synced<A> }>({
    state: { data: empty, status: "loading" },
  });
  useEffect(() => {
    if (!inTauri || key === undefined) {
      return;
    }
    return runCancelable(
      Effect.exit(reader.current()).pipe(
        Effect.tap((exit) =>
          Effect.sync(() =>
            setLive({
              key,
              state: Exit.isSuccess(exit)
                ? { data: exit.value, status: "ready" }
                : { data: empty, error: backendErrorOf(exit), status: "error" },
            })
          )
        )
      )
    );
  }, [key, empty]);
  if (key === undefined) {
    return { data: empty, status: "ready" };
  }
  if (mock) {
    return mock;
  }
  return live.key === key ? live.state : { data: empty, status: "loading" };
}

const NO_PEAKS: RecordingPeaks = { durationMs: 0, me: [], others: [] };

/** The waveform of a recording: `bars` peaks per channel, 0–1. */
export function useRecordingPeaks(
  recordingId: string | null | undefined,
  bars: number
): Synced<RecordingPeaks> {
  return useRead(
    recordingId ? `${recordingId}/${bars}` : undefined,
    () => CallRecordsData.use((data) => data.peaks(recordingId ?? "", bars)),
    NO_PEAKS
  );
}

const NO_MATCHES: CallSearch = { matches: [], projects: [], total: 0 };

/**
 * Searches the calls' titles, transcripts and summaries for `query`, in
 * the calls of `projectId` (all for `null`); nothing for a blank query.
 */
export function useCallSearch(
  query: string,
  projectId: string | null
): Synced<CallSearch> {
  const trimmed = query.trim();
  return useRead(
    trimmed ? JSON.stringify([trimmed, projectId]) : undefined,
    () => CallsData.use((data) => data.search(trimmed, projectId)),
    NO_MATCHES
  );
}
