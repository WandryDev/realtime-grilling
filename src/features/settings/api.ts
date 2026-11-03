"use client";

import { Cause, Effect, Exit, Stream } from "effect";

import type { IntegrationState } from "@/data/integrations";
import { type AppServices, appRuntime, runCancelable } from "@/effect/runtime";
import type { IntegrationService } from "@/lib/routes";

import {
  type AudioChannel,
  type ConnectInput,
  type ExportOptions,
  SettingsBackend,
  type SoundCheckResult,
} from "./backend";

/*
 * React-facing side of the Settings backend (`./backend.ts`). Each function
 * runs a SettingsBackend operation through the app runtime and keeps the
 * promise signature the screens use.
 *
 * Long operations take an AbortSignal (the screen aborts them when it
 * unmounts) and report progress from 0 to 100.
 */

type Progress = (percent: number) => void;

function abortError() {
  return new DOMException("Отменено", "AbortError");
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
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

/** Reports every progress value of `stream`, resolves when it ends. */
function runWithProgress(
  stream: (backend: SettingsBackend["Service"]) => Stream.Stream<number>,
  onProgress?: Progress,
  signal?: AbortSignal
) {
  return run(
    SettingsBackend.use((backend) =>
      Stream.runForEach(stream(backend), (percent) =>
        Effect.sync(() => onProgress?.(percent))
      )
    ),
    signal
  );
}

/* ---------------------------------------------------------------- Общие */

/** Opens the folder in Finder. */
export function revealInFinder(path: string) {
  return run(SettingsBackend.use((backend) => backend.revealInFinder(path)));
}

/** Moves the saved calls to `path`, with progress. */
export function moveRecordings(
  path: string,
  onProgress?: Progress,
  signal?: AbortSignal
) {
  return runWithProgress(
    (backend) => backend.moveRecordings(path),
    onProgress,
    signal
  );
}

/* ------------------------------------------------- Звук и распознавание */

/**
 * Live input level of a channel, 0–100, while subscribed. Returns the
 * unsubscribe function.
 */
export function subscribeInputLevel(
  channel: AudioChannel,
  onLevel: (level: number) => void
) {
  return runCancelable(
    SettingsBackend.use((backend) =>
      Stream.runForEach(backend.inputLevel(channel), (level) =>
        Effect.sync(() => onLevel(level))
      )
    )
  );
}

/** Records both channels for a moment and returns what was recognized. */
export function runSoundCheck(signal?: AbortSignal): Promise<SoundCheckResult> {
  return run(
    SettingsBackend.use((backend) => backend.soundCheck),
    signal
  );
}

/* ---------------------------------------------------------------- Агент */

/** Looks for the CLI at `path` and checks that it is signed in. */
export function checkAgent(path: string, signal?: AbortSignal) {
  return run(
    SettingsBackend.use((backend) => backend.checkAgent(path)),
    signal
  );
}

/** Signs the CLI in (in the real app the browser opens). */
export function signInAgent(signal?: AbortSignal) {
  return run(
    SettingsBackend.use((backend) => backend.signInAgent),
    signal
  );
}

/* ------------------------------------------------- Приватность и хранение */

/** Writes all projects to Markdown in `folder`, audio when asked. */
export function exportData(
  options: ExportOptions,
  onProgress?: Progress,
  signal?: AbortSignal
) {
  return runWithProgress(
    (backend) => backend.exportData(options),
    onProgress,
    signal
  );
}

/** Deletes calls, audio, projects and people from the computer. */
export function deleteAllData(signal?: AbortSignal) {
  return run(
    SettingsBackend.use((backend) => backend.deleteAllData),
    signal
  );
}

/* ----------------------------------------------------------- Интеграции */

/**
 * Connects a service: OAuth in the browser for GitHub and ClickUp, an API
 * key for Outline. Resolves with the connected state, rejects with a reason
 * the user can act on.
 */
export function connectService(
  service: IntegrationService,
  input: ConnectInput = {},
  signal?: AbortSignal
): Promise<IntegrationState> {
  return run(
    SettingsBackend.use((backend) => backend.connectService(service, input)),
    signal
  );
}

/** Opens a page in the browser. */
export function openExternal(url: string) {
  return run(SettingsBackend.use((backend) => backend.openExternal(url)));
}
