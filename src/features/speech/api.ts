"use client";

import { toast } from "@grill/ui/toast";
import { Effect, Stream } from "effect";
import { useSyncExternalStore } from "react";
import { appRuntime, runCancelable } from "@/effect/runtime";
import type { BackendError } from "@/effect/tauri";

import {
  type BenchmarkResult,
  type ModelId,
  SpeechBackend,
  type SpeechModel,
} from "./backend";

/*
 * React-facing side of the speech models (`./backend.ts`) for Settings:
 * the models as they change, and the buttons. A refused command (the
 * selected model while recording: `Invalid`) shows a toast and leaves the
 * models as the backend has them.
 */

export type { BenchmarkResult, ModelId, SpeechModel } from "./backend";

/* -------------------------------------------------------------- Models */

let models: readonly SpeechModel[] | null = null;
let stopWatch: (() => void) | null = null;
const listeners = new Set<() => void>();

function setModels(next: readonly SpeechModel[]) {
  models = next;
  for (const listener of listeners) {
    listener();
  }
}

/** One watch per window: starts with the first reader, stops after the last. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  stopWatch ??= runCancelable(
    SpeechBackend.use((speech) =>
      Stream.runForEach(speech.watchModels, (next) =>
        Effect.sync(() => setModels(next))
      )
    ).pipe(Effect.catch(() => Effect.void))
  );
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopWatch?.();
      stopWatch = null;
      models = null;
    }
  };
}

const getModels = () => models;
const getNoModels = () => null;

/** Both models as they change; null until the first read. */
export function useSpeechModels(): readonly SpeechModel[] | null {
  return useSyncExternalStore(subscribe, getModels, getNoModels);
}

/* ------------------------------------------------------------- Buttons */

function showRefusal(title: string) {
  return (error: BackendError) =>
    Effect.sync(() => {
      toast.add({ description: error.message, title, type: "error" });
    });
}

function runCommand(
  run: (
    speech: SpeechBackend["Service"]
  ) => Effect.Effect<unknown, BackendError>,
  failure: string
): Promise<void> {
  return appRuntime.runPromise(
    SpeechBackend.use(run).pipe(
      Effect.asVoid,
      Effect.catch(showRefusal(failure))
    )
  );
}

/** "Скачать" / "Продолжить" / "Повторить": progress comes as changes. */
export function downloadModel(id: ModelId) {
  return runCommand(
    (speech) => speech.download(id),
    "Не получилось начать загрузку"
  );
}

/** "Скачать заново": a model that failed goes, then downloads again. */
export function redownloadModel(id: ModelId) {
  return runCommand(
    (speech) => speech.remove(id).pipe(Effect.andThen(speech.download(id))),
    "Не получилось начать загрузку"
  );
}

/** "Удалить". The selected model can't go while recording. */
export function removeModel(id: ModelId) {
  return runCommand((speech) => speech.remove(id), "Модель не удалилась");
}

/** Recognize with this ready model; not another one while recording. */
export function selectModel(id: ModelId) {
  return runCommand((speech) => speech.select(id), "Модель не сменилась");
}

/**
 * "Проверить снова": the hardware check of a model. Resolves to its result
 * (also stored in the settings), or null when it could not run.
 */
export function runBenchmark(id: ModelId): Promise<BenchmarkResult | null> {
  return appRuntime.runPromise(
    SpeechBackend.use((speech) => speech.benchmark(id)).pipe(
      Effect.catch((error) =>
        Effect.as(showRefusal("Проверка не запустилась")(error), null)
      )
    )
  );
}
