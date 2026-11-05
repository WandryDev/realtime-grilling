"use client";

import { CURRENT_CALL_ID } from "@/data/call-session";
import { type CallRecord, resolveCallId } from "@/data/calls";

import {
  SEARCH,
  type SearchResult,
  SUMMARY_TOPICS,
  TRANSCRIPT_SECTIONS,
} from "./mock";

/*
 * The local search of the history over the demo transcripts and
 * summaries. What Rust keeps after a call is read by the hooks of
 * `src/data/*` (summaries, proposals, call records).
 */

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
  /** `projectId` null: a call without a project. */
  results: (SearchResult & { projectId: string | null })[];
  summary: string;
}

/** Local search over the transcripts and summaries of the calls. */
export function searchCalls(
  query: string,
  calls: CallRecord[],
  projectName: (id: string | null) => string
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
    if (call.projectId !== null) {
      counts[call.projectId] = (counts[call.projectId] ?? 0) + 1;
    }

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
