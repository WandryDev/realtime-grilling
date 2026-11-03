"use client";

import { Effect, Stream } from "effect";
import { useSyncExternalStore } from "react";

import { toast } from "@/components/ui/toast";
import {
  attachRecording,
  currentCallSession,
  finishCall,
  resumeCall,
} from "@/data/call-session";
import { appRuntime, runCancelable } from "@/effect/runtime";
import type { BackendError } from "@/effect/tauri";

import {
  type ChannelState,
  type MicActivity,
  mockMicActivity,
  RecordingBackend,
  type RecordingLevels,
  type RecordingStatus,
} from "./backend";

/*
 * React-facing side of the recorder (`./backend.ts`):
 * - beginRecording / stopRecording for "Начать" and "Завершить", and the
 *   call session's finish and resume with its recording;
 * - subscribeToMicActivity / useMicApp: who holds the microphone;
 * - useRecordingSignal: the live levels and a channel's trouble, for the
 *   recording indicators;
 * - releaseMicDemo: the browser demo's meeting app lets the mic go.
 */

export type { MicActivity, RecordingLevels } from "./backend";

/* ------------------------------------------------------------- Recording */

export type RecordingStart =
  | { id: string; ok: true }
  /** `noAccess`: the OS denies the microphone; `failed`: anything else. */
  | { message: string; ok: false; reason: "noAccess" | "failed" };

function startFailure(error: BackendError): RecordingStart {
  return {
    message: error.message,
    ok: false,
    reason: error.reason === "noAccess" ? "noAccess" : "failed",
  };
}

/**
 * Starts recording both channels. A recording without a call row: the
 * call is stored when it ends (`callId` would have to exist).
 */
export function beginRecording(): Promise<RecordingStart> {
  return appRuntime.runPromise(
    RecordingBackend.use((recorder) => recorder.start(null)).pipe(
      Effect.map((id): RecordingStart => ({ id, ok: true })),
      Effect.catch((error) => Effect.succeed(startFailure(error)))
    )
  );
}

/**
 * Stops the recording `id`; one already gone (`NotFound`) is fine. Any
 * other failure leaves it recording: a toast says so.
 */
export function stopRecording(id: string): Promise<void> {
  return appRuntime.runPromise(
    RecordingBackend.use((recorder) => recorder.stop(id)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          if (error.kind !== "NotFound") {
            toast.add({
              description: error.message,
              title: "Запись не остановилась",
              type: "error",
            });
          }
        })
      )
    )
  );
}

/** The id of the recording running now, null when none (or unknown). */
function runningRecordingId(): Promise<string | null> {
  return appRuntime.runPromise(
    RecordingBackend.use((recorder) => recorder.status).pipe(
      Effect.map((status) => status.id),
      Effect.catch(() => Effect.succeed(null))
    )
  );
}

/* ------------------------------------------------------- Microphone use */

/**
 * Calls `onChange` with every change of who holds the microphone; the
 * returned function stops (call it on unmount). The state at subscribe
 * time is not reported: only what happens while the screen is up.
 */
export function subscribeToMicActivity(
  onChange: (activity: MicActivity) => void
): () => void {
  return runCancelable(
    RecordingBackend.use((recorder) =>
      Stream.runForEach(recorder.micActivity, (activity) =>
        Effect.sync(() => onChange(activity))
      )
    ).pipe(Effect.catch(() => Effect.void))
  );
}

interface SharedFeed<T> {
  get: () => T;
  initial: T;
  subscribe: (listener: () => void) => () => void;
}

/**
 * One shared subscription per window for a value many components read:
 * it starts with the first reader and stops after the last one.
 */
function sharedFeed<T>(
  initial: T,
  start: (set: (value: T) => void) => () => void
): SharedFeed<T> {
  let value = initial;
  let stop: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (next: T) => {
    value = next;
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    get: () => value,
    initial,
    subscribe: (listener) => {
      listeners.add(listener);
      stop ??= start(set);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = null;
          value = initial;
        }
      };
    },
  };
}

/** The value of a shared feed; the prerender sees its initial one. */
function useSharedFeed<T>(feed: SharedFeed<T>): T {
  return useSyncExternalStore(feed.subscribe, feed.get, () => feed.initial);
}

const micAppFeed = sharedFeed<string | null>(null, (set) =>
  runCancelable(
    RecordingBackend.use((recorder) =>
      Stream.runForEach(recorder.watchMicActivity, (activity) =>
        Effect.sync(() => {
          if (activity.app) {
            set(activity.app);
          }
        })
      )
    ).pipe(Effect.catch(() => Effect.void))
  )
);

/** The app holding the microphone now (or holding it last), as it changes. */
export function useMicApp(): string | null {
  return useSharedFeed(micAppFeed);
}

/** Browser demo: the meeting app lets the microphone go. */
export function releaseMicDemo() {
  mockMicActivity.release();
}

/* --------------------------------------------------------------- Signal */

/** What the recording indicators draw besides the time. */
export interface RecordingSignal {
  /** null before the first reading or when nothing is recorded. */
  level: RecordingLevels | null;
  /** A channel that doesn't capture as it should, said in words. */
  warning: string | null;
}

const NO_SIGNAL: RecordingSignal = { level: null, warning: null };

const ME_WARNINGS: Partial<Record<ChannelState, string>> = {
  noAccess: "Нет доступа к микрофону",
  noDevice: "Микрофон не найден",
  reconnecting: "Микрофон переподключается",
};

const OTHERS_WARNINGS: Partial<Record<ChannelState, string>> = {
  noAccess: "Нет доступа к звуку собеседников",
  noDevice: "Звук собеседников не найден",
  reconnecting: "Звук собеседников переподключается",
  silentUnknownAccess: "Собеседников не слышно: проверьте доступ к звуку",
};

/** The channels' trouble in words; null when both capture. */
export function recordingWarning(status: RecordingStatus): string | null {
  if (status.id === null) {
    return null;
  }
  const parts = [
    ME_WARNINGS[status.channels.me],
    OTHERS_WARNINGS[status.channels.others],
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(". ") : null;
}

const signalFeed = sharedFeed<RecordingSignal>(NO_SIGNAL, (set) => {
  let signal = NO_SIGNAL;
  let recording = false;
  const update = (next: RecordingSignal) => {
    signal = next;
    set(next);
  };
  return runCancelable(
    RecordingBackend.use((recorder) => {
      const statuses = recorder.watchStatus.pipe(
        Stream.map((status) => () => {
          recording = status.id !== null;
          update({
            level: recording ? signal.level : null,
            warning: recordingWarning(status),
          });
        })
      );
      const levels = recorder.levels.pipe(
        Stream.map((level) => () => {
          if (recording) {
            update({ ...signal, level });
          }
        })
      );
      return Stream.runForEach(Stream.merge(statuses, levels), (apply) =>
        Effect.sync(apply)
      );
    }).pipe(Effect.catch(() => Effect.void))
  );
});

/**
 * The live levels of "Я" and "Остальные" and the channels' warning. The
 * window reads the status at once, then follows its changes and the
 * levels; nothing is drawn while nothing is recorded.
 */
export function useRecordingSignal(): RecordingSignal {
  return useSharedFeed(signalFeed);
}

/* ------------------------------------------------------- Call session */

/*
 * The call and its recording. The session changes at once (the screens
 * follow it); the recorder follows on a queue, one operation at a time,
 * each looking at the session as it is when it runs. So "Завершить" while
 * "Отменить завершение" is still starting the recording stops what that
 * start gives, and a resume after that starts a new one.
 */

let recorderQueue: Promise<void> = Promise.resolve();

function serially(operation: () => Promise<void>): Promise<void> {
  const next = recorderQueue.then(operation);
  recorderQueue = next.catch(() => undefined);
  return next;
}

/**
 * A restart that failed, said the way the start widget says it; the call
 * goes on without a recording.
 */
function showRestartFailure(failure: Extract<RecordingStart, { ok: false }>) {
  if (failure.reason === "noAccess") {
    toast.add({
      description:
        "Звонок идёт без записи. Разрешите Grill доступ к микрофону в системных настройках.",
      title: "Нет доступа к микрофону",
      type: "error",
    });
    return;
  }
  toast.add({
    description: failure.message,
    title: "Запись не возобновилась",
    type: "error",
  });
}

/**
 * "Завершить": the call goes to its summary and its recording stops. The
 * recording the session doesn't know of (a window that opened the call
 * before it heard of the recording) stops too: one call, one recording.
 */
export function finishRecordedCall(): Promise<void> {
  const { recordingId } = finishCall();
  return serially(async () => {
    if (currentCallSession().status === "live") {
      // Resumed again meanwhile: the recording goes on.
      return;
    }
    if (recordingId !== undefined) {
      await stopRecording(recordingId);
    }
    const running = await runningRecordingId();
    if (running !== null && running !== recordingId) {
      await stopRecording(running);
    }
  });
}

/**
 * "Отменить завершение": the call is live again; a recorded one records on
 * into a new recording (the stopped one stays as it is). A failed start
 * leaves the call live without a recording and says why.
 */
export function resumeRecordedCall(): Promise<void> {
  const { recordingId, status } = resumeCall();
  if (status !== "finishing" || recordingId === undefined) {
    return Promise.resolve();
  }
  return serially(async () => {
    if (currentCallSession().status !== "live") {
      return;
    }
    const started = await beginRecording();
    if (!started.ok) {
      showRestartFailure(started);
      return;
    }
    if (currentCallSession().status === "live") {
      attachRecording(started.id);
    } else {
      // "Завершить" came while it started.
      await stopRecording(started.id);
    }
  });
}

/**
 * A window that opens a live call: the recording running now is the
 * call's, also when this window never heard of it (opened before the
 * widget's session reached it, or reloaded).
 */
export function adoptRunningRecording(): Promise<void> {
  return serially(async () => {
    const running = await runningRecordingId();
    const session = currentCallSession();
    if (
      running !== null &&
      session.status === "live" &&
      session.recordingId !== running
    ) {
      attachRecording(running);
    }
  });
}
