"use client";

import { Effect, Stream } from "effect";
import { useEffect, useMemo } from "react";

import type { CallSummary, CallSummaryView, SummaryProgress } from "@/bindings";
import { appRuntime, inTauri, runCancelable } from "@/effect/runtime";
import type { BackendError } from "@/effect/tauri";

import { SummaryData } from "./services/summaries";
import { createStore } from "./store";
import {
  createSyncedStores,
  type LoadStatus,
  refreshMockStores,
  type Synced,
  useSyncedState,
} from "./synced-store";

/*
 * The summary of a call for the post-call pages (post-call design.md,
 * decisions 1, 2 and 12): what `summary_get` reads, re-read on the call's
 * `DataChanged` (the build writes `building`, then the saved summary or
 * `failed`), and the stage of the build running now from `SummaryProgress`.
 *
 * The progress is followed while a page shows a summary. A build that
 * ends reads the summary again, so a window opened during the build never
 * keeps a stage of a build that is over. In the browser the mock build
 * writes the mock database on a timer, so every progress re-reads the mock
 * stores (the calls take the title, the cards and proposals their new
 * records).
 */

export interface CallSummaryState {
  /** The build running now (its last progress); `null` when none runs. */
  building: SummaryProgress | null;
  /** Why the first read failed (`status: "error"`). */
  error?: BackendError;
  status: LoadStatus;
  /**
   * The stored summary: `null` while the call is live (or finishing before
   * the build wrote anything); `failed` / `interrupted` for a finished call
   * without one. A saved summary stays while a rebuild runs or after it
   * failed: `content` is set then.
   */
  summary: CallSummary | null;
}

const EMPTY_VIEW: CallSummaryView = { building: null, summary: null };
const NO_SUMMARY: Synced<CallSummaryView> = {
  data: EMPTY_VIEW,
  status: "ready",
};

const summaryStore = createSyncedStores((callId) => ({
  empty: EMPTY_VIEW,
  live: inTauri,
  onChange: (change) =>
    change.entity === "call" && change.id === callId
      ? {
          update: Effect.map(
            SummaryData.use((data) => data.get(callId)),
            (view) => () => view
          ),
        }
      : undefined,
  read: SummaryData.use((data) => data.get(callId)),
  runtime: appRuntime,
  seed: () => EMPTY_VIEW,
}));

/** Whether the build that sent `progress` is over. */
export function summaryBuildEnded(progress: SummaryProgress) {
  const { stage, state } = progress;
  if (state.status === "cancelled") {
    return true;
  }
  if (state.status === "failed") {
    // At `proposals` the build goes on without new proposals.
    return stage !== "proposals";
  }
  return state.status === "done" && stage === "saving";
}

/** The last progress of each call's build; `null` once it ended. */
const progressStore = createStore<Record<string, SummaryProgress | null>>({});

let followers = 0;
let stopFollowing: (() => void) | undefined;

function onProgress(progress: SummaryProgress) {
  const ended = summaryBuildEnded(progress);
  progressStore.set((current) => ({
    ...current,
    [progress.callId]: ended ? null : progress,
  }));
  if (!inTauri) {
    refreshMockStores();
  } else if (ended) {
    summaryStore(progress.callId).refresh();
  }
}

/** Follows every build's progress while a summary is shown. */
function followProgress() {
  followers += 1;
  stopFollowing ??= runCancelable(
    SummaryData.use((data) =>
      Stream.runForEach(data.progress, (progress) =>
        Effect.sync(() => onProgress(progress))
      )
    ).pipe(Effect.catch(() => Effect.void))
  );
  return () => {
    followers -= 1;
    if (followers === 0) {
      stopFollowing?.();
      stopFollowing = undefined;
    }
  };
}

/**
 * The summary of `callId` and the build running for it. In the browser it
 * is the demo summary; in Tauri it starts `loading`.
 */
export function useCallSummary(
  callId: string | null | undefined
): CallSummaryState {
  const state = useSyncedState(
    callId ? summaryStore(callId) : undefined,
    NO_SUMMARY
  );
  const progress = progressStore.use();
  useEffect(() => followProgress(), []);
  return useMemo(() => {
    const followed = callId ? progress[callId] : undefined;
    return {
      building: followed === undefined ? state.data.building : followed,
      error: state.error,
      status: state.status,
      summary: state.data.summary,
    };
  }, [callId, progress, state]);
}

/**
 * «Собрать итоги»: the build starts in the background and the summary
 * follows it. Resolves once it started (`false` when it couldn't).
 */
export async function buildSummary(callId: string) {
  const started = await summaryStore(callId).mutate(
    SummaryData.use((data) => Effect.as(data.build(callId), true)),
    { error: "Не удалось собрать итоги" }
  );
  return started !== undefined;
}

/** «Остановить»: the build stops, nothing is saved. */
export async function cancelSummary(callId: string) {
  const stopped = await summaryStore(callId).mutate(
    SummaryData.use((data) => Effect.as(data.cancel(callId), true)),
    { error: "Не удалось остановить сборку итогов" }
  );
  return stopped !== undefined;
}
