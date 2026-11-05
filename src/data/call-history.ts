"use client";

import { Effect } from "effect";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import { appRuntime, inTauri } from "@/effect/runtime";

import { CallRecordsData } from "./services/call-records";
import { SummaryData } from "./services/summaries";
import { createSyncedStores, type Synced } from "./synced-store";

/*
 * What a row of the history shows about a call besides its record
 * (`call-history` «Список звонков»; post-call design.md, decision 12):
 * the summary's title and first topic for a call without a title, the
 * questions not closed (open, and asked without an answer) and whether its
 * audio was deleted. Its proposals waiting for a decision are the app's
 * one count, `usePendingProposalCounts` of `./proposals.ts`.
 *
 * One synced store per call over the post-call reads. It re-reads on the
 * call's `DataChanged` (a build, a decision, deleted audio) and on changes
 * of its questions and transcripts (a question answered, a second pass).
 */

export interface CallFacts {
  /** Every recording of the call had its audio deleted. */
  audioDeleted: boolean;
  /** The first topic of the saved summary; empty without one. */
  firstTopic: string;
  /** Questions not closed: open, and asked without an answer. */
  notClosed: number;
  /** Whether the call has any questions (`notClosed` counts them then). */
  questions: number;
  /** The summary's title; empty without one. */
  summaryTitle: string;
}

interface StoredFacts extends CallFacts {
  questionIds: string[];
  recordingIds: string[];
}

const NO_FACTS: StoredFacts = {
  audioDeleted: false,
  firstTopic: "",
  notClosed: 0,
  questionIds: [],
  questions: 0,
  recordingIds: [],
  summaryTitle: "",
};

const readFacts = (callId: string) =>
  Effect.gen(function* () {
    const summaries = yield* SummaryData;
    const records = yield* CallRecordsData;
    const [view, questions, recordings] = yield* Effect.all(
      [
        summaries.get(callId),
        records.questions(callId),
        records.transcript(callId),
      ],
      { concurrency: "unbounded" }
    );
    const { summary } = view;
    const facts: StoredFacts = {
      audioDeleted:
        recordings.length > 0 && recordings.every((item) => item.audioDeleted),
      firstTopic: summary?.content?.topics[0]?.title ?? "",
      notClosed: questions.filter(
        (item) => item.status === "open" || item.status === "asked"
      ).length,
      questionIds: questions.map((item) => item.id),
      questions: questions.length,
      recordingIds: recordings.map((item) => item.id),
      summaryTitle: summary?.title ?? "",
    };
    return facts;
  });

const callFacts = createSyncedStores((callId) => {
  const read = readFacts(callId);
  const own = (): StoredFacts => callFacts(callId).get();
  return {
    empty: NO_FACTS,
    live: inTauri,
    onChange: (change) => {
      const concerns =
        (change.entity === "call" && change.id === callId) ||
        (change.entity === "question" &&
          own().questionIds.includes(change.id)) ||
        (change.entity === "transcript" &&
          own().recordingIds.includes(change.id));
      return concerns
        ? { update: Effect.map(read, (facts) => () => facts) }
        : undefined;
    },
    read,
    runtime: appRuntime,
    seed: () => NO_FACTS,
  };
});

type FactsStore = ReturnType<typeof callFacts>;

/**
 * The facts of the calls `callIds`, by call id; a call still being read
 * (or whose read failed) is not in it yet.
 */
export function useCallsFacts(
  callIds: readonly string[]
): ReadonlyMap<string, CallFacts> {
  const key = callIds.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the list
  const stores = useMemo(
    () => callIds.map((id) => [id, callFacts(id)] as const),
    [key]
  );

  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = stores.map(([, store]) => store.subscribe(listener));
      return () => {
        for (const stop of stops) {
          stop();
        }
      };
    },
    [stores]
  );

  // The same map while no store changed, as useSyncExternalStore wants.
  const cache = useRef<{
    states: Synced<StoredFacts>[];
    value: Map<string, CallFacts>;
  } | null>(null);
  const snapshot = useCallback(
    (state: (store: FactsStore) => Synced<StoredFacts>) => {
      const states = stores.map(([, store]) => state(store));
      const cached = cache.current;
      if (
        cached &&
        cached.states.length === states.length &&
        cached.states.every((item, index) => item === states[index])
      ) {
        return cached.value;
      }
      const value = new Map<string, CallFacts>();
      stores.forEach(([id], index) => {
        const item = states[index];
        if (item?.status === "ready") {
          value.set(id, item.data);
        }
      });
      cache.current = { states, value };
      return value;
    },
    [stores]
  );
  const getSnapshot = useCallback(
    () => snapshot((store) => store.getState()),
    [snapshot]
  );
  const getServerSnapshot = useCallback(
    () => snapshot((store) => store.getServerState()),
    [snapshot]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
