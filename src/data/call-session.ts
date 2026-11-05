"use client";

import { Effect, Exit, Stream } from "effect";
import { useEffect } from "react";

import type {
  CallAutoEnd,
  CallStart,
  CallSession as SharedCallSession,
} from "@/bindings";
import { toast } from "@/components/ui/toast";
import { appRuntime, inTauri } from "@/effect/runtime";
import type { BackendError } from "@/effect/tauri";
import {
  CallSessionBackend,
  IDLE_SESSION,
  resetMockCallSession,
} from "./services/call-session";
import { DEMO_CALL_ID } from "./services/mock-seed";
import { createStore } from "./store";
import { backendErrorOf } from "./synced-store";

/*
 * The call in progress, as this window has it. The start widget begins it,
 * the call window and the compact overlay show it, "Завершить" ends it and
 * the main window builds its summary, then closes it.
 *
 * The session comes from `CallSessionBackend` (`./services/call-session.ts`).
 * In Tauri the backend owns it: the store reads it when the window first
 * uses it and then follows `CallSessionChanged`, which the backend sends to
 * every window after each change. The actions call the backend and apply
 * its answer; they never send the session to other windows. In the browser
 * and the tests the mock answers synchronously, so the store has the new
 * session before an action returns.
 */

/** Id of the call the browser demo records; the post-call screens have its data. */
export const CURRENT_CALL_ID = DEMO_CALL_ID;

export type CallStatus = "idle" | "live" | "finishing";

export interface CallSession {
  /** The countdown "Завершать звонок сам" after the meeting app let go. */
  autoEnd: CallAutoEnd | null;
  /** The call in the history; null when no call is current. */
  callId: string | null;
  /** The client's people on the call. */
  participantIds: string[];
  /** Their names, in the same order. */
  participants: string[];
  /** null: a call without a project. */
  projectId: string | null;
  /** The recording of the call; the stopped one while finishing. */
  recordingId?: string;
  /** When the call started (ms since epoch), for the call timers. */
  startedAt?: number;
  status: CallStatus;
}

function fromShared(session: SharedCallSession): CallSession {
  const { recordingId, startedAt } = session;
  return {
    autoEnd: session.autoEnd,
    callId: session.callId,
    participantIds: session.participantIds,
    participants: session.participants,
    projectId: session.projectId,
    status: session.status,
    ...(recordingId === null ? {} : { recordingId }),
    ...(startedAt === null ? {} : { startedAt }),
  };
}

const IDLE = fromShared(IDLE_SESSION);

const callSessionStore = createStore<CallSession>(IDLE);
/** Tauri: whether the first read came; the mock's session is there at once. */
const loadedStore = createStore<boolean>(!inTauri);

/** Sessions from the backend's stream; an answer older than one is dropped. */
let followed = 0;

function apply(session: SharedCallSession) {
  callSessionStore.set(fromShared(session));
  loadedStore.set(true);
}

let following = false;

/** Tauri: reads the session and follows its changes, once per window. */
function follow() {
  if (!inTauri || following) {
    return;
  }
  following = true;
  appRuntime.runFork(
    CallSessionBackend.use((backend) =>
      Stream.runForEach(backend.sessions, (session) =>
        Effect.sync(() => {
          followed += 1;
          apply(session);
        })
      )
    ).pipe(
      // Unreadable: the window shows no call; its next use tries again.
      Effect.catch(() => Effect.sync(() => loadedStore.set(true))),
      Effect.ensuring(
        Effect.sync(() => {
          following = false;
        })
      )
    )
  );
}

/**
 * Keeps the session of this window up to date for the window's life (the
 * app frame starts it). Returns a function for the effect's cleanup; the
 * session goes on following, as every window stays loaded.
 */
export function followCallSession(): () => void {
  follow();
  return () => undefined;
}

export function useCallSession() {
  useEffect(follow, []);
  return callSessionStore.use();
}

/** Tauri: false until the window has read the session once. */
export function useCallSessionLoaded() {
  useEffect(follow, []);
  return loadedStore.use();
}

/** The session as this window has it now (outside React). */
export function currentCallSession(): CallSession {
  return callSessionStore.get();
}

type Operation = (
  backend: CallSessionBackend["Service"]
) => Effect.Effect<SharedCallSession, BackendError>;

/**
 * Runs an action of the backend and applies the session it answers,
 * unless the stream brought a newer one meanwhile. A failed action reads
 * the session again: it may have changed anyway (a resume without the
 * microphone is live without a recording). The mock runs synchronously.
 */
async function act(
  operation: Operation
): Promise<Exit.Exit<SharedCallSession, BackendError>> {
  const seen = followed;
  const effect = CallSessionBackend.use(operation);
  const exit = inTauri
    ? await appRuntime.runPromiseExit(effect)
    : appRuntime.runSyncExit(effect);
  if (Exit.isSuccess(exit)) {
    if (followed === seen) {
      apply(exit.value);
    }
    return exit;
  }
  const reread = CallSessionBackend.use((backend) => backend.current);
  const now = inTauri
    ? await appRuntime.runPromiseExit(reread)
    : appRuntime.runSyncExit(reread);
  if (Exit.isSuccess(now) && followed === seen) {
    apply(now.value);
  }
  return exit;
}

function failureOf(exit: Exit.Exit<unknown, BackendError>) {
  return Exit.isFailure(exit) ? backendErrorOf(exit) : null;
}

function showError(title: string, error: BackendError) {
  toast.add({ description: error.message, title, type: "error" });
}

/** Why "Начать" did not start the call. */
export interface CallStartFailure {
  message: string;
  ok: false;
  /** `noAccess`: the OS denies the microphone; `failed`: anything else. */
  reason: "noAccess" | "failed";
}

export type CallStartResult = { ok: true } | CallStartFailure;

/**
 * "Начать": the backend creates the call with its project (or none) and
 * people and records it. In Tauri it also hides the start widget and shows
 * the overlay or the call window. Without microphone access no call starts
 * and the result says why.
 */
export async function startCall(input: CallStart): Promise<CallStartResult> {
  const error = failureOf(await act((backend) => backend.start(input)));
  if (error === null) {
    return { ok: true };
  }
  return {
    message: error.message,
    ok: false,
    reason: error.reason === "noAccess" ? "noAccess" : "failed",
  };
}

/** The current call's id for an action, or nothing to act on. */
function currentCallId(): string | null {
  const { callId, status } = callSessionStore.get();
  return status === "idle" ? null : callId;
}

/**
 * "Завершить": the recording stops and the call is `finishing`; in Tauri
 * the backend hides the overlay and opens the call window for the summary.
 * Nothing when no call is live.
 */
export async function finishCall(): Promise<void> {
  const callId = currentCallId();
  if (callId === null) {
    return;
  }
  const error = failureOf(await act((backend) => backend.finish(callId)));
  if (error !== null) {
    showError("Не удалось завершить звонок", error);
  }
}

/** A resume whose recording did not start: the call goes on without one. */
function showRestartFailure(error: BackendError) {
  if (error.reason === "noAccess") {
    toast.add({
      description:
        "Звонок идёт без записи. Разрешите Grill доступ к микрофону в системных настройках.",
      title: "Нет доступа к микрофону",
      type: "error",
    });
    return;
  }
  showError("Запись не возобновилась", error);
}

/**
 * "Отменить завершение": the call is live again and records on into a new
 * recording. A recording that doesn't start leaves the call live without
 * one, and a toast says why.
 */
export async function resumeCall(): Promise<void> {
  const callId = currentCallId();
  if (callId === null) {
    return;
  }
  const error = failureOf(await act((backend) => backend.resume(callId)));
  if (error !== null) {
    showRestartFailure(error);
  }
}

/**
 * The summary of `callId` is built: the call is over and none is current.
 * In Tauri only the main window may close a call.
 */
export async function closeCall(callId: string): Promise<void> {
  const error = failureOf(await act((backend) => backend.close(callId)));
  if (error !== null) {
    showError("Не удалось закрыть звонок", error);
  }
}

/** "Продолжить": the countdown of the auto end stops in every window. */
export async function keepCall(): Promise<void> {
  const callId = currentCallId();
  if (callId === null) {
    return;
  }
  await act((backend) => backend.keep(callId));
}

/**
 * Back to no call: the mock's session and this window's copy (tests, the
 * dev navigator). In Tauri the next change or read replaces the copy.
 */
export function resetCall() {
  resetMockCallSession();
  callSessionStore.set(IDLE);
}
