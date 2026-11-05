"use client";

import { Effect, Stream } from "effect";

import { closeCall, currentCallSession } from "@/data/call-session";
import {
  type CallRecord,
  type SummaryProgress,
  setSummaryProgress,
  type TaskSyncService,
  updateTaskCard,
} from "@/data/calls";
import { appRuntime } from "@/effect/runtime";

import { PostCallBackend } from "./backend";
import { PROCESSING_STEPS, type ProcessingStepData } from "./mock";

/*
 * React-facing side of what the local agent does after a call. Building the
 * summary and sending a task card run the PostCallBackend Effect service
 * (`./backend.ts`); the history searches in Rust (`calls_search`). State goes to the
 * calls slice (`src/data/calls.ts`), so the screens only read hooks.
 *
 * The effects run outside React: like the real agent, the summary keeps
 * building after the window is closed.
 */

/* ------------------------------------------------------ Сборка итогов */

/** Meta of a finished step: how long it took. */
const DONE_META = ["0:08", "0:41", "0:06", "0:12"];

const running = new Set<string>();

/**
 * Builds the summary of a finished call: walks the processing steps, then
 * marks the summary ready, closes the call when it is the finishing one
 * (the backend marks it finished, no call is current) and calls `onDone`.
 * Calling it again while it runs does nothing.
 */
export function collectSummary(
  callId: string,
  options: {
    onDone?: () => void;
    patch?: Partial<Pick<CallRecord, "participants" | "projectId">>;
    /** The call's recording: its second pass is the transcript step. */
    recordingId?: string;
  } = {}
) {
  if (running.has(callId)) {
    return;
  }
  running.add(callId);
  setSummaryProgress(callId, { progress: 0, step: 0 }, options.patch);

  appRuntime.runFork(
    PostCallBackend.use((backend) =>
      Stream.runForEach(
        backend.buildSummary(callId, options.recordingId),
        (progress) => Effect.sync(() => setSummaryProgress(callId, progress))
      )
    ).pipe(
      Effect.ensuring(Effect.sync(() => running.delete(callId))),
      Effect.andThen(
        Effect.sync(() => {
          setSummaryProgress(callId, undefined);
          const session = currentCallSession();
          if (session.status === "finishing" && session.callId === callId) {
            closeCall(callId);
          }
          options.onDone?.();
        })
      )
    )
  );
}

export function isCollectingSummary(callId: string) {
  return running.has(callId);
}

/** The transcript step when the second pass didn't refine it in time. */
const TRANSCRIPT_NOTES: Record<
  NonNullable<SummaryProgress["transcript"]>,
  Pick<ProcessingStepData, "description" | "title">
> = {
  failed: {
    description: "Уточнить не получилось, итоги по живой расшифровке",
    title: "Расшифровка готова",
  },
  later: {
    description: "Уточню её в фоне, итоги пока по живой расшифровке",
    title: "Расшифровка готова",
  },
};

/** Processing steps as they look at `step` with `progress` percent. */
export function processingSteps(
  step: number,
  progress: number,
  transcript?: SummaryProgress["transcript"]
): ProcessingStepData[] {
  return PROCESSING_STEPS.map((item, index) => {
    if (index < step) {
      const note =
        index === 0 && transcript ? TRANSCRIPT_NOTES[transcript] : undefined;
      return {
        ...item,
        ...note,
        meta: note ? undefined : DONE_META[index],
        progress: undefined,
        status: "done",
      };
    }
    if (index === step) {
      return {
        ...item,
        meta: undefined,
        progress: Math.max(progress, 8),
        status: "active",
      };
    }
    return { ...item, meta: undefined, progress: undefined, status: "waiting" };
  });
}

/* ------------------------------------------- Отправка карточки задачи */

/** Creates a ClickUp task or a GitHub issue from a task card. */
export function sendTaskCard(
  callId: string,
  cardId: string,
  service: TaskSyncService
): Promise<string> {
  updateTaskCard(callId, cardId, (review) => ({
    ...review,
    sync: { ...review.sync, [service]: { status: "sending" } },
  }));

  return appRuntime.runPromise(
    PostCallBackend.use((backend) =>
      backend.sendTaskCard(callId, cardId, service)
    ).pipe(
      Effect.tap((ref) =>
        Effect.sync(() =>
          updateTaskCard(callId, cardId, (review) => ({
            ...review,
            sync: { ...review.sync, [service]: { ref, status: "sent" } },
          }))
        )
      )
    )
  );
}

/* ------------------------------------------------------- Склонение */

const PLURAL_FEW_MIN = 2;
const PLURAL_FEW_MAX = 4;
const TEENS_MIN = 11;
const TEENS_MAX = 14;
const TEN = 10;
const HUNDRED = 100;

/** Russian plural: 1 звонок, 2 звонка, 5 звонков. */
export function plural(count: number, forms: [string, string, string]) {
  const tens = count % HUNDRED;
  const ones = count % TEN;
  if (tens >= TEENS_MIN && tens <= TEENS_MAX) {
    return `${count} ${forms[2]}`;
  }
  if (ones === 1) {
    return `${count} ${forms[0]}`;
  }
  if (ones >= PLURAL_FEW_MIN && ones <= PLURAL_FEW_MAX) {
    return `${count} ${forms[1]}`;
  }
  return `${count} ${forms[2]}`;
}
