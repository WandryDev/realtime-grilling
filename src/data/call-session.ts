"use client";

import { createStore } from "./store";

/*
 * The call in progress. The start widget begins it, the call window and the
 * compact overlay show it, "Завершить" ends it and the app moves on to the
 * summary of that call.
 */

/** Id of the call the demo records; the post-call screens have its data. */
export const CURRENT_CALL_ID = "telemedia-19-oct";

export type CallStatus = "idle" | "live" | "finishing";

export interface CallSession {
  /** Id the finished call gets in the history. */
  callId: string;
  /** Names of the client's people on the call. */
  participants: string[];
  projectId: string | null;
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

export function useCallSession() {
  return callSessionStore.use();
}

export function startCall(input: {
  participants: string[];
  projectId: string | null;
}) {
  callSessionStore.set({
    callId: CURRENT_CALL_ID,
    participants: input.participants,
    projectId: input.projectId,
    startedAt: Date.now(),
    status: "live",
  });
}

/** "Завершить": the agent collects the summary. */
export function finishCall() {
  callSessionStore.set((session) => ({ ...session, status: "finishing" }));
}

/** "Отменить завершение": back to the live call. */
export function resumeCall() {
  callSessionStore.set((session) =>
    session.status === "finishing" ? { ...session, status: "live" } : session
  );
}

export function resetCall() {
  callSessionStore.set(IDLE);
}
