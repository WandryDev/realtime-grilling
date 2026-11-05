"use client";

import { Effect, Stream } from "effect";

import type { QuestionAction } from "@/bindings";
import { appRuntime, inTauri, runCancelable } from "@/effect/runtime";

import { type CallAgentUpdate, CallBackend } from "./backend";
import type { CallFeedEvent } from "./types";

export type { CallAgentUpdate } from "./backend";

/**
 * Whether the questions are the backend's (Tauri) rather than the demo
 * script's: the windows then act on them through `actOnQuestion`.
 */
export const questionsFromBackend = inTauri;

/*
 * React-facing side of the call backend. The feed and the one-off
 * operations live in the CallBackend Effect service (`./backend.ts`); this
 * module runs them through the app runtime. Each function returns a cleanup
 * that interrupts the running effect.
 */

/* Feed */

/**
 * Plays the call from step `from`. `onStep` gets the position after each
 * step so the caller can resume where it paused.
 */
export function subscribeToCallFeed(
  onEvent: (event: CallFeedEvent) => void,
  { from = 0, onStep }: { from?: number; onStep?: (next: number) => void } = {}
): () => void {
  return runCancelable(
    CallBackend.use((backend) =>
      Stream.runForEach(backend.feed(from), ({ events, next }) =>
        Effect.sync(() => {
          for (const event of events) {
            onEvent(event);
          }
          if (next !== undefined) {
            onStep?.(next);
          }
        })
      )
    )
  );
}

/* The agent's questions */

/**
 * The backend's questions of the recording: its call state now, then
 * after every change, and the agent's status. A failed subscription leaves
 * the window as it is.
 */
export function subscribeToCallAgent(
  recordingId: string,
  onUpdate: (update: CallAgentUpdate) => void
): () => void {
  return runCancelable(
    CallBackend.use((backend) =>
      Stream.runForEach(backend.agent(recordingId), (update) =>
        Effect.sync(() => onUpdate(update))
      )
    ).pipe(Effect.catch(() => Effect.void))
  );
}

/**
 * A quick action on a question, kept by the backend; every window sees
 * it with the next `CallStateChanged`. Resolves to why it failed, or null.
 */
export function actOnQuestion(
  id: string,
  action: QuestionAction
): Promise<string | null> {
  return appRuntime.runPromise(
    CallBackend.use((backend) => backend.actOnQuestion(id, action)).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  );
}

/**
 * «Повторить» of the backend's agent: it calls again now, its status
 * says how it went. Resolves to why the command failed, or null.
 */
export function retryAgentNow(recordingId: string): Promise<string | null> {
  return appRuntime.runPromise(
    CallBackend.use((backend) => backend.retryAgent(recordingId)).pipe(
      Effect.as(null),
      Effect.catch((error) => Effect.succeed(error.message))
    )
  );
}

/* One-off operations */

function runThen(
  operation: (backend: CallBackend["Service"]) => Effect.Effect<void, unknown>,
  callback: () => void
) {
  return runCancelable(
    CallBackend.use(operation).pipe(Effect.andThen(Effect.sync(callback)))
  );
}

/** The demo agent comes back a moment after «Повторить». */
export function retryAgent(onRecovered: () => void) {
  return runThen((backend) => backend.retryAgent(null), onRecovered);
}

/** Reconnects an integration that lost its access (GitHub). */
export function reconnectSource(onConnected: () => void) {
  return runThen((backend) => backend.reconnectSource, onConnected);
}

/**
 * Opens the system privacy settings and waits for the permission. The
 * mock "grants" it after a moment.
 */
export function requestSystemAudio(onGranted: () => void) {
  return runThen((backend) => backend.requestSystemAudio, onGranted);
}

/** The lagging transcript catches up on its own. */
export function waitForTranscript(onCaughtUp: () => void) {
  return runThen((backend) => backend.waitForTranscript, onCaughtUp);
}
