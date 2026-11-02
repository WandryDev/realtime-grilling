"use client";

import { Effect, Stream } from "effect";

import { CURRENT_CALL_ID, resetCall } from "@/data/call-session";
import {
  type CallRecord,
  resolveCallId,
  setSummaryProgress,
  type TaskSyncService,
  updateTaskCard,
} from "@/data/calls";
import { appRuntime } from "@/effect/runtime";

import { PostCallBackend } from "./backend";
import {
  PROCESSING_STEPS,
  type ProcessingStepData,
  SEARCH,
  type SearchResult,
  SUMMARY_TOPICS,
  TRANSCRIPT_SECTIONS,
} from "./mock";

/*
 * React-facing side of what the local agent does after a call. Building the
 * summary and sending a task card run the PostCallBackend Effect service
 * (`./backend.ts`); searching the transcripts is local. State goes to the
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
 * marks the summary ready, ends the call session and calls `onDone`.
 * Calling it again while it runs does nothing.
 */
export function collectSummary(
  callId: string,
  options: {
    onDone?: () => void;
    patch?: Partial<Pick<CallRecord, "participants" | "projectId">>;
  } = {}
) {
  if (running.has(callId)) {
    return;
  }
  running.add(callId);
  setSummaryProgress(callId, { progress: 0, step: 0 }, options.patch);

  appRuntime.runFork(
    PostCallBackend.use((backend) =>
      Stream.runForEach(backend.buildSummary(callId), (progress) =>
        Effect.sync(() => setSummaryProgress(callId, progress))
      )
    ).pipe(
      Effect.ensuring(Effect.sync(() => running.delete(callId))),
      Effect.andThen(
        Effect.sync(() => {
          setSummaryProgress(callId, undefined);
          resetCall();
          options.onDone?.();
        })
      )
    )
  );
}

export function isCollectingSummary(callId: string) {
  return running.has(callId);
}

/** Processing steps as they look at `step` with `progress` percent. */
export function processingSteps(
  step: number,
  progress: number
): ProcessingStepData[] {
  return PROCESSING_STEPS.map((item, index) => {
    if (index < step) {
      return {
        ...item,
        meta: DONE_META[index],
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

/* ------------------------------------------------- Поиск по звонкам */

interface Passage {
  meta: string;
  moment?: string;
  text: string;
}

const SPEAKER = { client: "Клиент", you: "Вы" } as const;

/** Searchable text of a call: transcript and summary, or the demo phrases. */
function passagesOf(call: CallRecord): Passage[] {
  const passages: Passage[] = [];
  if (call.id === CURRENT_CALL_ID) {
    for (const section of TRANSCRIPT_SECTIONS) {
      for (const turn of section.turns) {
        passages.push({
          meta: `${SPEAKER[turn.speaker]}, ${turn.time.slice(0, 5)}`,
          moment: turn.id,
          text: turn.text,
        });
      }
    }
    for (const topic of SUMMARY_TOPICS) {
      for (const point of topic.points) {
        passages.push({
          meta: "в итогах звонка",
          moment: point.time,
          text: point.text,
        });
      }
    }
  } else {
    for (const result of SEARCH.results) {
      if (resolveCallId(result.id) === call.id) {
        passages.push({
          meta: result.match.meta,
          text: `${result.match.before}${SEARCH.query}${result.match.after}`,
        });
      }
    }
  }
  passages.push({ meta: "в названии звонка", text: call.title });
  return passages;
}

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

export interface CallSearch {
  /** Results per project id, for the filter pills. */
  counts: Record<string, number>;
  results: (SearchResult & { projectId: string })[];
  summary: string;
}

/** Local search over the transcripts and summaries of the calls. */
export function searchCalls(
  query: string,
  calls: CallRecord[],
  projectName: (id: string) => string
): CallSearch {
  const needle = query.trim().toLocaleLowerCase("ru");
  const results: CallSearch["results"] = [];
  const counts: Record<string, number> = {};
  let matches = 0;

  if (!needle) {
    return { counts, results, summary: "" };
  }

  for (const call of calls) {
    const found = passagesOf(call).filter((passage) =>
      passage.text.toLocaleLowerCase("ru").includes(needle)
    );
    const [first] = found;
    if (!first) {
      continue;
    }
    matches += found.length;
    counts[call.projectId] = (counts[call.projectId] ?? 0) + 1;

    const start = first.text.toLocaleLowerCase("ru").indexOf(needle);
    const end = start + needle.length;
    const more = found.length - 1;
    results.push({
      callId: call.id,
      date: call.date,
      duration: call.duration,
      id: call.id,
      match: {
        after: first.text.slice(end),
        before: first.text.slice(0, start),
        meta: more > 0 ? `${first.meta}, и ещё ${more}` : first.meta,
        text: first.text.slice(start, end),
      },
      moment: first.moment,
      openCount: call.openCount,
      project: projectName(call.projectId),
      projectId: call.projectId,
      time: call.time,
      title: call.title,
    });
  }

  const summary = `${plural(results.length, ["звонок", "звонка", "звонков"])}, ${plural(matches, ["совпадение", "совпадения", "совпадений"])}`;
  return { counts, results, summary };
}
