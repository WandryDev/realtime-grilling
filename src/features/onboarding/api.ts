"use client";

import { Effect, Stream } from "effect";

import { appRuntime, runCancelable } from "@/effect/runtime";

import {
  type AudioLevelFrame,
  type AudioSource,
  OnboardingBackend,
} from "./backend";

/*
 * React-facing side of the onboarding backend (`./backend.ts`): the live
 * input level, the live mic-check transcript, the clipboard, the browser and
 * the window focus.
 *
 * Every listener returns its unsubscribe function, call it on unmount.
 */

/** Why a level meter can't run: the `reason` of the capture error. */
export type CaptureProblem = "noAccess" | "noDevice" | "busy" | "failed";

/**
 * Streams the input level of the microphone or the system sound. It stops
 * when the source can't be opened or fails (`onProblem` says why) and when
 * the app stops listening on its own, e.g. the window was hidden (`onEnd`).
 */
export function listenToAudioLevel(
  source: AudioSource,
  {
    onEnd,
    onFrame,
    onProblem,
  }: {
    onEnd: () => void;
    onFrame: (frame: AudioLevelFrame) => void;
    onProblem: (problem: CaptureProblem) => void;
  }
): () => void {
  return runCancelable(
    OnboardingBackend.use((backend) =>
      Stream.runForEach(backend.audioLevel(source), (frame) =>
        Effect.sync(() => onFrame(frame))
      )
    ).pipe(
      Effect.flatMap(() => Effect.sync(onEnd)),
      Effect.catch((error) =>
        Effect.sync(() => onProblem(error.reason ?? "failed"))
      )
    )
  );
}

/** Calls `onFocus` each time this window gets the focus back. */
export function listenToWindowFocus(onFocus: () => void): () => void {
  return runCancelable(
    OnboardingBackend.use((backend) =>
      Stream.runForEach(backend.windowFocus, () => Effect.sync(onFocus))
    ).pipe(Effect.ignore)
  );
}

/** Opens a page of the running agent login in the default browser. */
export function openLoginPage(url: string) {
  runCancelable(
    OnboardingBackend.use((backend) => backend.openLoginPage(url)).pipe(
      Effect.ignore
    )
  );
}

/** Streams what the speech model hears during the mic check, word by word. */
export function listenToMicCheck(
  phrase: string,
  onText: (text: string) => void
): () => void {
  return runCancelable(
    OnboardingBackend.use((backend) =>
      Stream.runForEach(backend.micCheck(phrase), (text) =>
        Effect.sync(() => onText(text))
      )
    )
  );
}

/** Copies text for the support chat. Resolves to whether it worked. */
export function copyToClipboard(text: string): Promise<boolean> {
  return appRuntime.runPromise(
    OnboardingBackend.use((backend) => backend.copyText(text)).pipe(
      Effect.as(true),
      Effect.catchTag("ClipboardError", () => Effect.succeed(false))
    )
  );
}
