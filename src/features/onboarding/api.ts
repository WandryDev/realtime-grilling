"use client";

import { Effect, Stream } from "effect";

import { appRuntime, runCancelable } from "@/effect/runtime";

import { type AudioSource, OnboardingBackend } from "./backend";

/*
 * React-facing side of the onboarding backend (`./backend.ts`): the live
 * input level, the live mic-check transcript and the clipboard.
 *
 * Every listener returns its unsubscribe function, call it on unmount.
 */

/** Streams the input level (0–1) of the microphone or the system sound. */
export function listenToAudioLevel(
  source: AudioSource,
  onLevel: (level: number) => void
): () => void {
  return runCancelable(
    OnboardingBackend.use((backend) =>
      Stream.runForEach(backend.audioLevel(source), (level) =>
        Effect.sync(() => onLevel(level))
      )
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
