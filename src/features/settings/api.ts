"use client";

import { Cause, Effect, Exit, Stream } from "effect";

import type {
  AgentState,
  AudioInputs,
  DataSummary,
  RecordingsInfo,
} from "@/bindings";
import { type AppServices, appRuntime, runCancelable } from "@/effect/runtime";
import { BackendError, type BackendErrorKind } from "@/effect/tauri";
import type { CaptureProblem } from "@/features/onboarding/api";

import { type AudioChannel, SettingsBackend } from "./backend";

/*
 * React-facing side of the Settings backend (`./backend.ts`). Each function
 * runs a SettingsBackend operation through the app runtime and gives the
 * screens a promise or an unsubscribe function.
 *
 * Operations that can outlive a screen take an AbortSignal (the screen
 * aborts them when it unmounts).
 */

function abortError() {
  return new DOMException("Отменено", "AbortError");
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/** The `kind` of a backend failure (`Invalid`, `External`…), if it is one. */
export function backendErrorKind(error: unknown): BackendErrorKind | undefined {
  return error instanceof BackendError ? error.kind : undefined;
}

/**
 * Runs an operation as a promise. Aborting `signal` interrupts it and
 * rejects with an AbortError; a failure rejects with the tagged error,
 * whose `message` the screens show.
 */
async function run<A, E>(
  effect: Effect.Effect<A, E, AppServices>,
  signal?: AbortSignal
): Promise<A> {
  if (signal?.aborted) {
    throw abortError();
  }
  const exit = await appRuntime.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw abortError();
  }
  throw Cause.squash(exit.cause);
}

/* ---------------------------------------------------------------- Общие */

/** The recordings' folder, its size and the calls with audio. */
export function readRecordingsInfo(
  signal?: AbortSignal
): Promise<RecordingsInfo> {
  return run(
    SettingsBackend.use((backend) => backend.recordingsInfo),
    signal
  );
}

/** Opens the folder in Finder (Explorer on Windows). */
export function revealInFinder(path: string) {
  return run(SettingsBackend.use((backend) => backend.revealInFinder(path)));
}

/* ------------------------------------------------- Звук и распознавание */

/**
 * The microphones now and on every change, while subscribed. `onEnd`: the
 * app stopped listening on its own (the window was hidden). Returns the
 * unsubscribe function.
 */
export function subscribeAudioInputs(
  onInputs: (inputs: AudioInputs) => void,
  onEnd?: () => void
): () => void {
  return runCancelable(
    SettingsBackend.use((backend) =>
      Stream.runForEach(backend.audioInputs, (inputs) =>
        Effect.sync(() => onInputs(inputs))
      )
    ).pipe(
      Effect.flatMap(() => Effect.sync(() => onEnd?.())),
      Effect.ignore
    )
  );
}

/**
 * Live input level of a channel, 0–100, while subscribed. It stops when
 * the source can't be opened or broke (`onProblem` says why) and when the
 * app stopped listening on its own, e.g. the window was hidden (`onEnd`).
 * Returns the unsubscribe function.
 */
export function subscribeInputLevel(
  channel: AudioChannel,
  {
    onEnd,
    onLevel,
    onProblem,
  }: {
    onEnd?: () => void;
    onLevel: (level: number) => void;
    onProblem?: (problem: CaptureProblem) => void;
  }
): () => void {
  return runCancelable(
    SettingsBackend.use((backend) =>
      Stream.runForEach(backend.inputLevel(channel), (level) =>
        Effect.sync(() => onLevel(level))
      )
    ).pipe(
      Effect.flatMap(() => Effect.sync(() => onEnd?.())),
      Effect.catch((error) =>
        Effect.sync(() => onProblem?.(error.reason ?? "failed"))
      )
    )
  );
}

/** Records the chosen microphone for a moment; what was recognized. */
export function runSoundCheck(signal?: AbortSignal): Promise<string> {
  return run(
    SettingsBackend.use((backend) => backend.soundCheck),
    signal
  );
}

/* ---------------------------------------------------------------- Агент */

/**
 * What Claude Code is: at the saved path without `path`, at `path`
 * otherwise (nothing is saved).
 */
export function checkAgent(
  path?: string,
  signal?: AbortSignal
): Promise<AgentState> {
  return run(
    SettingsBackend.use((backend) => backend.checkAgent(path)),
    signal
  );
}

/* ------------------------------------------------- Приватность и хранение */

/** What «Удалить всё» deletes. */
export function readDataSummary(signal?: AbortSignal): Promise<DataSummary> {
  return run(
    SettingsBackend.use((backend) => backend.dataSummary),
    signal
  );
}

/**
 * Deletes the data, the recordings and the secrets, resets the settings
 * and starts onboarding again.
 */
export function deleteAllData(signal?: AbortSignal) {
  return run(
    SettingsBackend.use((backend) => backend.deleteAllData),
    signal
  );
}
