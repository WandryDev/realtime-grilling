"use client";

import { Effect, Stream } from "effect";

import type { CallSession as SharedCallSession } from "@/bindings";
import { appRuntime, runCancelable } from "@/effect/runtime";
import { currentWindowLabel } from "@/lib/window-label";

import { CallSessionEvents } from "./services/call-session";
import { DEMO_CALL_ID } from "./services/mock-seed";
import { createStore } from "./store";

/*
 * The call in progress. The start widget begins it, the call window and the
 * compact overlay show it, "Завершить" ends it and the app moves on to the
 * summary of that call.
 *
 * In Tauri those are different windows, so every change is sent to all of
 * them (`CallSessionChanged`) and each window applies the others' changes
 * (`followCallSession`, started once per window by the app frame).
 */

/** Id of the call the demo records; the post-call screens have its data. */
export const CURRENT_CALL_ID = DEMO_CALL_ID;

export type CallStatus = "idle" | "live" | "finishing";

export interface CallSession {
  /** Id the finished call gets in the history. */
  callId: string;
  /** Names of the client's people on the call. */
  participants: string[];
  projectId: string | null;
  /** The recording of the call, stopped by "Завершить". */
  recordingId?: string;
  /** When recording started (ms since epoch), for the call timers. */
  startedAt?: number;
  status: CallStatus;
}

const IDLE: CallSession = {
  callId: CURRENT_CALL_ID,
  participants: [],
  projectId: null,
  status: "idle",
};

const callSessionStore = createStore<CallSession>(IDLE);

function fromShared(session: SharedCallSession): CallSession {
  const { callId, participants, projectId, recordingId, startedAt, status } =
    session;
  return {
    callId,
    participants,
    projectId,
    status,
    ...(recordingId === undefined || recordingId === null
      ? {}
      : { recordingId }),
    ...(startedAt === undefined || startedAt === null ? {} : { startedAt }),
  };
}

/** Changes the session here and, in Tauri, in every other window. */
function setSession(
  next: CallSession | ((session: CallSession) => CallSession)
) {
  callSessionStore.set(next);
  const source = currentWindowLabel();
  if (source === null) {
    return;
  }
  const session = callSessionStore.get();
  appRuntime.runFork(
    CallSessionEvents.use((events) => events.share({ session, source })).pipe(
      Effect.catch(() => Effect.void)
    )
  );
}

/**
 * Tauri: applies the call session changes other windows make. Returns a
 * function that stops; a no-op in the browser (one page, one session).
 */
export function followCallSession(): () => void {
  const label = currentWindowLabel();
  if (label === null) {
    return () => undefined;
  }
  return runCancelable(
    CallSessionEvents.use((events) =>
      Stream.runForEach(events.changes, (change) =>
        Effect.sync(() => {
          if (change.source !== label) {
            callSessionStore.set(fromShared(change.session));
          }
        })
      )
    ).pipe(Effect.catch(() => Effect.void))
  );
}

export function useCallSession() {
  return callSessionStore.use();
}

export function startCall(input: {
  participants: string[];
  projectId: string | null;
  /** The recording "Начать" started; none for the demo call. */
  recordingId?: string;
}) {
  setSession({
    callId: CURRENT_CALL_ID,
    participants: input.participants,
    projectId: input.projectId,
    ...(input.recordingId === undefined
      ? {}
      : { recordingId: input.recordingId }),
    startedAt: Date.now(),
    status: "live",
  });
}

/**
 * "Завершить": the agent collects the summary. Returns the session as it
 * was, so the caller can stop its recording.
 */
export function finishCall(): CallSession {
  const before = callSessionStore.get();
  setSession((session) => ({ ...session, status: "finishing" }));
  return before;
}

/**
 * "Отменить завершение": back to the live call. Its recording was stopped
 * by "Завершить": returns the session as it was, so the caller can start a
 * new one (`attachRecording`).
 */
export function resumeCall(): CallSession {
  const before = callSessionStore.get();
  setSession((session) => {
    if (session.status !== "finishing") {
      return session;
    }
    const { recordingId: _stopped, ...rest } = session;
    return { ...rest, status: "live" };
  });
  return before;
}

/** The live call records into `recordingId` from now on. */
export function attachRecording(recordingId: string) {
  setSession((session) =>
    session.status === "live" ? { ...session, recordingId } : session
  );
}

export function resetCall() {
  setSession(IDLE);
}
