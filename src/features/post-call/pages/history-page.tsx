"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import {
  type CallRecord,
  countPendingProposals,
  NO_PROJECT_CALL,
  useCalls,
} from "@/data/calls";
import { useProjects } from "@/data/projects";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { searchCalls } from "../api";
import type { FilterOption } from "../components/history";
import { type PostCallLinks, PostCallProvider } from "../components/links";
import { NotFoundState } from "../components/not-found-state";
import { type HistoryMonth, SEARCH } from "../mock";
import {
  CallHistoryScreen,
  type HistorySearch,
} from "../screens/call-history-screen";
import { APP_WINDOW, baseLinks } from "./call-page-frame";

/*
 * /history?project=…: "05 История звонков". Without `project` it lists the
 * calls of every project, the pills narrow it to one; with it, the calls
 * of that project and its filters. Typing searches transcripts and
 * summaries locally (../api.ts). Rows open the summary of the call, search
 * results open the transcript at the found phrase. `?demo=search` opens
 * with the Paper query.
 */

const DEMO_STATES = ["search"] as const;
const ALL = "all";
const OPEN = "open";

const MONTH_NUMBER: Record<string, number> = { окт: 10, сен: 9 };
const MONTH_WEIGHT = 100;

function sortKey(call: CallRecord) {
  const [day = "0", month = ""] = call.date.split(" ");
  return (MONTH_NUMBER[month] ?? 0) * MONTH_WEIGHT + Number(day);
}

function byMonth(
  calls: CallRecord[],
  projectName?: (id: string | null) => string
): HistoryMonth[] {
  const months: HistoryMonth[] = [];
  const sorted = [...calls].sort((a, b) => sortKey(b) - sortKey(a));
  for (const call of sorted) {
    let month = months.find((item) => item.month === call.month);
    if (!month) {
      month = { calls: [], month: call.month };
      months.push(month);
    }
    const people = call.audioDeleted
      ? `${call.participants}, аудио удалено`
      : call.participants;
    const pending = countPendingProposals(call);
    month.calls.push({
      date: call.date,
      duration: call.duration,
      id: call.id,
      openCount: call.openCount,
      participants: projectName
        ? `${projectName(call.projectId)} · ${people}`
        : people,
      proposals: pending > 0 ? pending : undefined,
      time: call.time,
      title: call.title,
    });
  }
  return months;
}

function peopleOf(calls: CallRecord[]) {
  const names = new Set<string>();
  for (const call of calls) {
    for (const name of call.participants.split(", ")) {
      names.add(name);
    }
  }
  return [...names];
}

function matchesFilter(call: CallRecord, filter: string) {
  if (filter === ALL) {
    return true;
  }
  if (filter === OPEN) {
    return call.openCount > 0;
  }
  return call.participants.split(", ").includes(filter);
}

function History({ projectId }: { projectId: string | null }) {
  const demo = useDemoState(DEMO_STATES);
  const projects = useProjects();
  const calls = useCalls();
  const [query, setQuery] = useState(demo === "search" ? SEARCH.query : "");
  const [filter, setFilter] = useState(ALL);
  const [searchFilter, setSearchFilter] = useState(ALL);

  const projectName = useCallback(
    (id: string | null) =>
      id === null
        ? NO_PROJECT_CALL
        : (projects.find((item) => item.id === id)?.name ?? ""),
    [projects]
  );
  const project = projects.find((item) => item.id === projectId);
  const links = useMemo<PostCallLinks>(
    () => ({
      ...baseLinks(),
      project: projectId ? routes.project(projectId) : routes.home(),
    }),
    [projectId]
  );

  const sidebarProjects = useMemo(
    () =>
      projects.map((item) => ({
        calls: calls.filter((call) => call.projectId === item.id).length,
        id: item.id,
        name: item.name,
      })),
    [calls, projects]
  );

  const scoped = useMemo(
    () =>
      projectId ? calls.filter((call) => call.projectId === projectId) : calls,
    [calls, projectId]
  );

  const filterOptions = useMemo<FilterOption[]>(() => {
    if (!projectId) {
      return [
        { count: calls.length, id: ALL, label: "Все проекты" },
        ...sidebarProjects.map((item) => ({
          count: item.calls,
          id: item.id,
          label: item.name,
        })),
      ];
    }
    return [
      { count: scoped.length, id: ALL, label: "Все" },
      {
        accent: true,
        count: scoped.filter((call) => call.openCount > 0).length,
        id: OPEN,
        label: "С открытыми вопросами",
      },
      ...peopleOf(scoped).map((name) => ({ id: name, label: name })),
    ];
  }, [calls.length, projectId, scoped, sidebarProjects]);

  const months = useMemo(() => {
    const listed = projectId
      ? scoped.filter((call) => matchesFilter(call, filter))
      : scoped.filter((call) => filter === ALL || call.projectId === filter);
    return byMonth(listed, projectId ? undefined : projectName);
  }, [filter, projectId, projectName, scoped]);

  const search = useMemo<HistorySearch>(() => {
    const found = searchCalls(query, calls, projectName);
    const total = found.results.length;
    return {
      filter: {
        onValueChange: setSearchFilter,
        options: [
          { count: total, id: ALL, label: "Все проекты" },
          ...projects.map((item) => ({
            count: found.counts[item.id] ?? 0,
            id: item.id,
            label: item.name,
          })),
        ],
        value: searchFilter,
      },
      hint: SEARCH.hint,
      results: found.results.filter(
        (result) => searchFilter === ALL || result.projectId === searchFilter
      ),
      summary: total > 0 ? found.summary : "Ничего не нашлось",
    };
  }, [calls, projectName, projects, query, searchFilter]);

  const changeQuery = useCallback((next: string) => {
    setQuery(next);
    setSearchFilter(ALL);
  }, []);

  if (projectId && !project) {
    return (
      <PostCallProvider links={links}>
        <NotFoundState
          className={APP_WINDOW}
          description="Такого проекта нет на этом компьютере. Возможно, его удалили."
          homeHref={routes.home()}
          title="Проект не найден"
        />
      </PostCallProvider>
    );
  }

  return (
    <PostCallProvider links={links}>
      <CallHistoryScreen
        className={APP_WINDOW}
        filter={{
          onValueChange: setFilter,
          options: filterOptions,
          value: filter,
        }}
        hoveredCallId={null}
        months={months}
        onQueryChange={changeQuery}
        projectId={projectId}
        projectName={project?.name}
        projects={sidebarProjects}
        query={query.trim() ? query : undefined}
        search={search}
        totalCalls={calls.length}
      />
    </PostCallProvider>
  );
}

export function HistoryPage() {
  const params = useSearchParams();
  const projectId = params.get("project");
  return <History key={projectId ?? ALL} projectId={projectId} />;
}
