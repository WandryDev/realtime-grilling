// The call's timeline from what the server returns: the phrases of every
// recording and the agent's calls in one line of time, and what is tied to
// each phrase (spec «Таймлайн звонка»).

import type { CallTimeline } from "@grill/analytics-server/api";

export type Timeline = typeof CallTimeline.Type;
export type Segment = Timeline["segments"][number];
export type AgentCall = Timeline["agentCalls"][number];
export type Question = Timeline["questions"][number];
export type Finding = Timeline["findings"][number];

/** What can be opened beside the timeline. */
export type Selection =
  | { readonly kind: "agentCall"; readonly id: string }
  | { readonly kind: "question"; readonly id: string }
  | { readonly kind: "finding"; readonly id: string };

export interface Fact {
  readonly field: string;
  readonly value: string;
}

export type Item =
  | {
      readonly kind: "phrase";
      readonly key: string;
      readonly at: number;
      readonly segment: Segment;
      readonly questions: readonly Question[];
      readonly facts: readonly Fact[];
    }
  | {
      readonly kind: "agentCall";
      readonly key: string;
      readonly at: number;
      readonly call: AgentCall;
    }
  | {
      readonly kind: "finding";
      readonly key: string;
      readonly at: number;
      readonly finding: Finding;
    };

interface Evidence {
  readonly id?: string;
  readonly source?: string;
}

const evidenceOf = (value: unknown): readonly Evidence[] =>
  Array.isArray(value) ? (value as Evidence[]) : [];

/** When the call started: its first recording, else the call's own start. */
export const startOf = (timeline: Timeline): number =>
  Math.min(
    ...timeline.recordings.map((recording) => recording.startedAt),
    timeline.call.startedAt ?? Number.POSITIVE_INFINITY
  );

/** The phrases a question or a fact rests on. */
export const segmentsCited = (value: unknown): string[] =>
  evidenceOf(value)
    .filter((item) => item.source === "segment" && typeof item.id === "string")
    .map((item) => item.id as string);

/** The findings a question rests on. */
export const findingsCited = (value: unknown): string[] =>
  evidenceOf(value)
    .filter((item) => item.source === "document" && typeof item.id === "string")
    .map((item) => item.id as string);

/** A phrase by id: a shown one, or a live one a refine replaced. */
export const phraseOf = (
  timeline: Timeline,
  id: string | null
): Segment | undefined =>
  timeline.segments.find((segment) => segment.id === id) ??
  timeline.liveSegments.find((segment) => segment.id === id);

/**
 * The shown phrase a cited one stands at: itself, or for a live phrase a
 * refine replaced, the refined phrase of its recording that began last
 * before it (spec «Уточнённая расшифровка»).
 */
export const anchors = (timeline: Timeline): ((id: string) => string) => {
  const shown = new Set(timeline.segments.map((segment) => segment.id));
  const live = new Map(
    timeline.liveSegments.map((segment) => [segment.id, segment])
  );
  return (id) => {
    const phrase = live.get(id);
    if (shown.has(id) || !phrase) {
      return id;
    }
    const before = timeline.segments
      .filter(
        (segment) =>
          segment.recordingId === phrase.recordingId &&
          segment.startMs <= phrase.startMs
      )
      .at(-1);
    return before?.id ?? id;
  };
};

export const items = (timeline: Timeline): Item[] => {
  const start = startOf(timeline);
  const anchor = anchors(timeline);
  const recordingStart = new Map(
    timeline.recordings.map((recording) => [recording.id, recording.startedAt])
  );
  const questionsBySegment = new Map<string, Question[]>();
  for (const question of timeline.questions) {
    for (const id of new Set(segmentsCited(question.evidence).map(anchor))) {
      questionsBySegment.set(id, [
        ...(questionsBySegment.get(id) ?? []),
        question,
      ]);
    }
  }
  const factsBySegment = new Map<string, Fact[]>();
  for (const card of timeline.cards) {
    const fields = Array.isArray(card.fields) ? card.fields : [];
    for (const field of fields as {
      field?: string;
      value?: string;
      evidence?: unknown;
    }[]) {
      for (const id of new Set(segmentsCited(field.evidence).map(anchor))) {
        factsBySegment.set(id, [
          ...(factsBySegment.get(id) ?? []),
          {
            field: String(field.field ?? ""),
            value: String(field.value ?? ""),
          },
        ]);
      }
    }
  }
  const all: Item[] = [
    ...timeline.segments.map((segment) => ({
      at:
        (recordingStart.get(segment.recordingId) ?? start) +
        segment.startMs -
        start,
      facts: factsBySegment.get(segment.id) ?? [],
      key: `s:${segment.id}`,
      kind: "phrase" as const,
      questions: questionsBySegment.get(segment.id) ?? [],
      segment,
    })),
    ...timeline.agentCalls.map((call) => ({
      at: call.startedAt - start,
      call,
      key: `a:${call.id}`,
      kind: "agentCall" as const,
    })),
    ...timeline.findings.map((finding) => ({
      at: finding.createdAt - start,
      finding,
      key: `f:${finding.id}`,
      kind: "finding" as const,
    })),
  ];
  return all.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
};

export interface KindTotal {
  readonly calls: number;
  readonly costUsd: number;
  readonly kind: string;
  readonly tokens: number;
}

/** Tokens and $ of the call by kind of agent call, and all of it. */
export const totals = (
  timeline: Timeline
): { all: KindTotal; byKind: KindTotal[] } => {
  const byKind = new Map<
    string,
    { calls: number; tokens: number; costUsd: number }
  >();
  for (const call of timeline.agentCalls) {
    const current = byKind.get(call.kind) ?? {
      calls: 0,
      costUsd: 0,
      tokens: 0,
    };
    byKind.set(call.kind, {
      calls: current.calls + 1,
      costUsd: current.costUsd + (call.costUsd ?? 0),
      tokens:
        current.tokens +
        (call.inputTokens ?? 0) +
        (call.outputTokens ?? 0) +
        (call.cacheRead ?? 0) +
        (call.cacheWrite ?? 0),
    });
  }
  const list = [...byKind.entries()].map(([kind, total]) => ({
    kind,
    ...total,
  }));
  return {
    all: list.reduce(
      (sum, total) => ({
        calls: sum.calls + total.calls,
        costUsd: sum.costUsd + total.costUsd,
        kind: "all",
        tokens: sum.tokens + total.tokens,
      }),
      { calls: 0, costUsd: 0, kind: "all", tokens: 0 }
    ),
    byKind: list.sort((a, b) => b.costUsd - a.costUsd),
  };
};

/** The agent calls whose applied operation of `op` changed `subjectId`. */
export const callsThat = (
  timeline: Timeline,
  op: string,
  subjectId: string
): AgentCall[] =>
  timeline.agentCalls.filter((call) =>
    call.ops.some(
      (item) => item.applied && item.op === op && item.subjectId === subjectId
    )
  );
