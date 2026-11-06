"use client";

import { useMemo } from "react";

import type { CallOverview } from "@/bindings";
import { useCallsOverview } from "@/data/call-history";
import { type CallRecord, NO_PROJECT_CALL, useCalls } from "@/data/calls";
import { useProjects } from "@/data/projects";
import { plural } from "@/lib/plural";

import type { CallSummary } from "./mock";

/*
 * The stored calls as the one-line rows of home («Недавние звонки») and
 * the project page («Звонки»): the record of `useCalls` with what the
 * history's overview (`calls_overview`) adds, its title and counts. A row
 * with proposals waiting opens their review, any other its summary.
 * The demo projects keep their Paper rows (`project-data.ts`).
 */

/** Rows of the project page; the rest is under «Показать ещё». */
export const PROJECT_CALLS_SHOWN = 3;
/** Rows of home; «Вся история» has the rest. */
export const HOME_CALLS_SHOWN = 5;

const MS_PER_DAY = 86_400_000;

export interface StoredCall {
  call: CallRecord;
  overview?: CallOverview;
}

function startOfDay(at: number) {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** «сегодня 12:00», «вчера 09:30», «16 окт 12:00», «16 окт 2025». */
export function callWhen(call: CallRecord, now: number = Date.now()) {
  const today = startOfDay(now);
  if (call.startedAt >= today) {
    return `сегодня ${call.time}`;
  }
  if (call.startedAt >= today - MS_PER_DAY) {
    return `вчера ${call.time}`;
  }
  const year = new Date(call.startedAt).getFullYear();
  return year === new Date(now).getFullYear()
    ? `${call.date} ${call.time}`
    : `${call.date} ${year}`;
}

function statusOf(
  call: CallRecord,
  pending: number,
  open: number
): CallSummary["status"] {
  if (call.endedAt === null) {
    return { kind: "muted", label: "идёт" };
  }
  if (pending > 0) {
    const word = plural(pending, "предложение", "предложения", "предложений");
    return {
      kind: "proposals",
      label: `${pending} ${word} ${pending === 1 ? "ждёт" : "ждут"}`,
    };
  }
  if (open > 0) {
    const word = plural(open, "вопрос", "вопроса", "вопросов");
    return {
      kind: "muted",
      label: `${open} ${word} ${open === 1 ? "открыт" : "открыты"}`,
    };
  }
  return { kind: "muted", label: "разобран" };
}

/**
 * One row. The overview's title (the call's, its summary's, its first
 * topic), else the project's name; `project` is set on home only.
 */
export function callLineOf(
  { call, overview }: StoredCall,
  projectName: string,
  options: { now?: number; withProject?: boolean } = {}
): CallSummary {
  const pending = overview?.pendingProposals ?? 0;
  const open = overview?.openQuestions ?? call.openCount;
  const people = [
    call.participants,
    overview?.audioDeleted ? "аудио удалено" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    duration: call.duration,
    highlighted: pending > 0,
    id: call.id,
    people,
    project: options.withProject ? projectName : undefined,
    projectId: call.projectId ?? undefined,
    status: statusOf(call, pending, open),
    topic: overview?.title || call.title.trim() || projectName,
    when: callWhen(call, options.now),
  };
}

/** «3 звонка», «6 звонков, 7 открытых вопросов», «пока пусто». */
export function callsSummaryOf(calls: StoredCall[], shown: number) {
  if (calls.length === 0) {
    return { hidden: 0, summary: "пока пусто" };
  }
  const open = calls.reduce(
    (sum, { call, overview }) =>
      sum + (overview?.openQuestions ?? call.openCount),
    0
  );
  const parts = [
    `${calls.length} ${plural(calls.length, "звонок", "звонка", "звонков")}`,
  ];
  if (open > 0) {
    parts.push(
      `${open} ${plural(open, "открытый вопрос", "открытых вопроса", "открытых вопросов")}`
    );
  }
  return {
    hidden: Math.max(0, calls.length - shown),
    summary: parts.join(", "),
  };
}

/** Calls of a project (or every call), newest first, with their overview. */
export function useStoredCalls(projectId?: string | null): StoredCall[] {
  const calls = useCalls();
  const overview = useCallsOverview();
  return useMemo(
    () =>
      calls
        .filter(
          (call) => projectId === undefined || call.projectId === projectId
        )
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((call) => ({ call, overview: overview.get(call.id) })),
    [calls, overview, projectId]
  );
}

/** The project page's rows and the line under «Звонки». */
export function useProjectCallLines(projectId: string | null) {
  const stored = useStoredCalls(projectId ?? "");
  const projects = useProjects();
  const name = projects.find((item) => item.id === projectId)?.name ?? "";
  return useMemo(
    () => ({
      calls: stored
        .slice(0, PROJECT_CALLS_SHOWN)
        .map((entry) => callLineOf(entry, name)),
      summary: callsSummaryOf(stored, PROJECT_CALLS_SHOWN),
    }),
    [name, stored]
  );
}

/**
 * Home's newest rows, with the project's name (`NO_PROJECT_CALL` without
 * one). `skip`: projects whose rows come from elsewhere (the demo ones).
 */
export function useHomeCallLines(skip: (projectId: string) => boolean) {
  const stored = useStoredCalls();
  const projects = useProjects();
  return useMemo(() => {
    const names = new Map(projects.map((item) => [item.id, item.name]));
    return stored
      .filter(({ call }) => call.projectId === null || !skip(call.projectId))
      .slice(0, HOME_CALLS_SHOWN)
      .map((entry) =>
        callLineOf(
          entry,
          entry.call.projectId === null
            ? NO_PROJECT_CALL
            : (names.get(entry.call.projectId) ?? ""),
          { withProject: true }
        )
      );
  }, [projects, skip, stored]);
}
