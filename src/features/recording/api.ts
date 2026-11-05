"use client";

import { Effect, Stream } from "effect";
import { useSyncExternalStore } from "react";

import { runCancelable } from "@/effect/runtime";

import {
  type ChannelState,
  type MicActivity,
  mockMicActivity,
  RecordingBackend,
  type RecordingLevels,
  type RecordingStatus,
} from "./backend";

/*
 * React-facing side of the recorder (`./backend.ts`). The call records
 * through the call session (`src/data/call-session.ts`), so this is:
 * - subscribeToMicActivity / useMicApp: who holds the microphone;
 * - useRecordingSignal: the live levels and a channel's trouble, for the
 *   recording indicators;
 * - releaseMicDemo: the browser demo's meeting app lets the mic go.
 */

export type { MicActivity, RecordingInput, RecordingLevels } from "./backend";

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
