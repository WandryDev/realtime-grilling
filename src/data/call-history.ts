"use client";

import { Effect } from "effect";
import { useMemo } from "react";

import type { CallOverview, DataChanged } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";

import { CallsData } from "./services/calls";
import { createSyncedStore } from "./synced-store";

/*
 * What a row of the history shows about a call besides its record
 * (`call-history` «Список звонков»; post-call design.md, decision 12),
 * read for every call at once (`calls_overview`): the title (the call's,
 * the summary's, its first topic), the proposals waiting for a decision
 * (the count of the sidebar's `usePendingProposals`), the questions not
 * closed and whether its audio was deleted.
 *
 * One synced store over the one read. Rust reports the writes it depends
 * on as the call's `DataChanged`: a summary saved, a proposal decided or
 * undone, the audio deleted, the call started, finished or deleted. A
 * person or a project deleted takes its proposals or calls with it.
 * Questions change during the call (`CallStateChanged`, no `DataChanged`);
 * the call's end re-reads them.
 */

const read = CallsData.use((data) => data.overview(null));

const concerns = (change: DataChanged) =>
  change.entity === "call" ||
  ((change.entity === "person" || change.entity === "project") &&
    change.change === "deleted");

const overviewStore = createSyncedStore({
  empty: [] as CallOverview[],
  live: inTauri,
  onChange: (change) =>
    concerns(change)
      ? { update: Effect.map(read, (rows) => () => rows) }
      : undefined,
  read,
  runtime: appRuntime,
  seed: () => [] as CallOverview[],
});

/**
 * The history's row of every call, by call id; a call not read yet (or
 * whose read failed) is not in it.
 */
export function useCallsOverview(): ReadonlyMap<string, CallOverview> {
  const rows = overviewStore.use();
  return useMemo(() => new Map(rows.map((row) => [row.callId, row])), [rows]);
}
