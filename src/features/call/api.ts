"use client";

import { Effect, Stream } from "effect";

import { runCancelable } from "@/effect/runtime";

import { CallBackend } from "./backend";
import type { CallFeedEvent } from "./types";

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

/* One-off operations */

/**
 * "Собираю итоги": reports each finished stage, then `onDone`. The first
 * stage (the transcript) is ready right away.
 */
export function collectSummary(
  onStage: (stage: number) => void,
  onDone: () => void
): () => void {
  return runCancelable(
    CallBackend.use((backend) =>
      Stream.runForEach(backend.collectSummary, (stage) =>
        Effect.sync(() => onStage(stage))
      )
    ).pipe(Effect.andThen(Effect.sync(onDone)))
  );
}

function runThen(
  operation: (backend: CallBackend["Service"]) => Effect.Effect<void>,
  callback: () => void
) {
  return runCancelable(
    CallBackend.use(operation).pipe(Effect.andThen(Effect.sync(callback)))
  );
}

/** Restarts the agent session after it stopped answering. */
export function retryAgent(onRecovered: () => void) {
  return runThen((backend) => backend.retryAgent, onRecovered);
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
