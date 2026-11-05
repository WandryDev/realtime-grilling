import type {
  Call,
  CallEvidence,
  CallMoment,
  CallSearch,
  CallSearchMatch,
  ProjectMatches,
  SearchSource,
  TranscriptChannel,
} from "@/bindings";

import { compareIds, type MockTables } from "./mock-database";

/*
 * `calls_search` of the mock (post-call design.md, decision 11), as
 * `src-tauri/src/storage/call_search.rs` does it: text in normal form
 * (lower case, «ё» as «е», anything but letters and digits as one space),
 * the first match of each source text with up to 60 characters of the
 * original around it, at most 200 matches, and the counts per project
 * over every call.
 */

export const MAX_MATCHES = 200;
export const SNIPPET_CHARS = 60;

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** The normal form of `text`, with the original index of each character. */
function normalized(text: string[]) {
  const chars: string[] = [];
  const origin: number[] = [];
  let space = false;
  text.forEach((char, index) => {
    for (const lower of char.toLowerCase()) {
      const mapped = lower === "ё" ? "е" : lower;
      if (!LETTER_OR_DIGIT.test(mapped)) {
        space = chars.length > 0;
        continue;
      }
      if (space) {
        chars.push(" ");
        origin.push(index);
        space = false;
      }
      chars.push(mapped);
      origin.push(index);
    }
  });
  return { chars, origin };
}

/** The query in normal form: no spaces at the ends. */
export function normalizeQuery(query: string) {
  return normalized(Array.from(query)).chars;
}

interface Snippet {
  after: string;
  before: string;
  text: string;
}

/** The first match of `query` (normal form, not empty) in `text`. */
function find(text: string, query: string[]): Snippet | null {
  const original = Array.from(text);
  const { chars, origin } = normalized(original);
  for (let at = 0; at + query.length <= chars.length; at += 1) {
    if (query.every((char, offset) => chars[at + offset] === char)) {
      const start = origin[at] ?? 0;
      const end = (origin[at + query.length - 1] ?? 0) + 1;
      return {
        after: original.slice(end, end + SNIPPET_CHARS).join(""),
        before: original
          .slice(Math.max(0, start - SNIPPET_CHARS), start)
          .join(""),
        text: original.slice(start, end).join(""),
      };
    }
  }
  return null;
}

interface Source {
  channel: TranscriptChannel | null;
  moment: CallMoment | null;
  source: SearchSource;
  text: string;
}

const quoteMoment = (evidence: CallEvidence[]): CallMoment | null => {
  const [first] = evidence;
  return first
    ? {
        recordingId: first.recordingId,
        segmentId: first.segmentId,
        startMs: first.startMs,
      }
    : null;
};

function sourcesOf(tables: MockTables, call: Call): Source[] {
  const recordings = [...tables.recordings.values()]
    .filter((item) => item.callId === call.id)
    .map((item) => item.recording)
    .sort((a, b) => a.startedAt - b.startedAt || compareIds(a.id, b.id));
  const sources: Source[] = [
    { channel: null, moment: null, source: "title", text: call.title },
  ];
  for (const recording of recordings) {
    const segments = [...recording.segments].sort(
      (a, b) => a.startMs - b.startMs || compareIds(a.id, b.id)
    );
    for (const segment of segments) {
      sources.push({
        channel: segment.channel,
        moment: {
          recordingId: recording.id,
          segmentId: segment.id,
          startMs: segment.startMs,
        },
        source: "segment",
        text: segment.text,
      });
    }
  }
  const summary = tables.summaries.get(call.id);
  if (summary?.content) {
    sources.push({
      channel: null,
      moment: null,
      source: "tldr",
      text: summary.tldr,
    });
    for (const point of summary.content.topics.flatMap(
      (topic) => topic.points
    )) {
      sources.push({
        channel: null,
        moment: quoteMoment(point.evidence),
        source: "point",
        text: point.text,
      });
    }
    const facts = summary.content.cards.flatMap((card) =>
      card.fields.flatMap((field) => field.facts)
    );
    for (const fact of facts) {
      sources.push({
        channel: null,
        moment: quoteMoment(fact.evidence),
        source: "fact",
        text: fact.text,
      });
    }
  }
  return sources;
}

function searchCall(
  tables: MockTables,
  call: Call,
  query: string[]
): CallSearchMatch[] {
  const started = new Map(
    [...tables.recordings.values()].map((item) => [
      item.recording.id,
      item.recording.startedAt,
    ])
  );
  return sourcesOf(tables, call).flatMap((source) => {
    const found = find(source.text, query);
    if (!found) {
      return [];
    }
    const start = source.moment
      ? started.get(source.moment.recordingId)
      : undefined;
    return [
      {
        ...found,
        at:
          source.moment && start !== undefined
            ? start + source.moment.startMs
            : null,
        callId: call.id,
        channel: source.channel,
        moment: source.moment,
        projectId: call.projectId,
        source: source.source,
      },
    ];
  });
}

/** Projects as Rust orders them: calls without one first, then by id. */
function byProject(a: ProjectMatches, b: ProjectMatches) {
  if (a.projectId === b.projectId) {
    return 0;
  }
  if (a.projectId === null) {
    return -1;
  }
  if (b.projectId === null) {
    return 1;
  }
  return compareIds(a.projectId, b.projectId);
}

/** Searches `calls` (newest first) for `query`, of `projectId` or all. */
export function searchCalls(
  tables: MockTables,
  calls: Call[],
  query: string,
  projectId: string | null
): CallSearch {
  const needle = normalizeQuery(query);
  const result: CallSearch = { matches: [], projects: [], total: 0 };
  if (needle.length === 0) {
    return result;
  }
  const projects = new Map<string | null, ProjectMatches>();
  for (const call of calls) {
    const found = searchCall(tables, call, needle);
    if (found.length === 0) {
      continue;
    }
    const counts = projects.get(call.projectId) ?? {
      calls: 0,
      matches: 0,
      projectId: call.projectId,
    };
    counts.calls += 1;
    counts.matches += found.length;
    projects.set(call.projectId, counts);
    if (projectId !== null && call.projectId !== projectId) {
      continue;
    }
    result.total += found.length;
    result.matches.push(...found.slice(0, MAX_MATCHES - result.matches.length));
  }
  result.projects = [...projects.values()].sort(byProject);
  return result;
}
