"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import type { CallOverview, CallSearchMatch } from "@/bindings";
import { useCallsOverview } from "@/data/call-history";
import { useCallSearch } from "@/data/call-records";
import { type CallRecord, NO_PROJECT_CALL, useCalls } from "@/data/calls";
import { type ClientPerson, usePeople } from "@/data/people";
import { type ProjectRecord, useProjects } from "@/data/projects";
import { useProjectSources } from "@/data/sources";
import type { Synced } from "@/data/synced-store";
import { clockTime } from "@/lib/clock";
import { plural } from "@/lib/plural";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import type { FilterOption } from "../components/history";
import { type PostCallLinks, PostCallProvider } from "../components/links";
import { NotFoundState } from "../components/not-found-state";
import { type HistoryMonth, SEARCH, type SearchResult } from "../mock";
import { momentParam } from "../moment";
import {
  CallHistoryScreen,
  type HistorySearch,
  type ReadinessItem,
} from "../screens/call-history-screen";
import { APP_WINDOW, baseLinks } from "./call-page-frame";

/*
 * /history?project=…: "05 История звонков" (`call-history`). Without
 * `project` it lists the calls of every project and those without one,
 * the pills narrow it to a project; with it, the calls of that project
 * and its filters: with questions not closed, and by the client's people
 * (by id, so a renamed person still finds their calls). Newest first by
 * the start, by month. Typing searches the transcripts, summaries and
 * titles in Rust (`calls_search`) once typing pauses: in a project's
 * history that project's calls, the pills widen it to every project or
 * narrow it to another. A result from the transcript opens it at the
 * phrase. A project without calls shows its readiness for one.
 * `?demo=search` opens with the Paper query.
 */

const DEMO_STATES = ["search"] as const;
const ALL = "all";
const OPEN = "open";

/** What a row shows of a call: the record, and what its overview adds. */
interface HistoryEntry {
  audioDeleted: boolean;
  call: CallRecord;
  notClosed: number;
  pending: number;
  title: string;
}

/**
 * The overview's title (the call's, its summary's, its first topic), else
 * the project («Звонок без проекта» without one).
 */
function entryOf(
  call: CallRecord,
  overview: CallOverview | undefined,
  projectName: (id: string | null) => string
): HistoryEntry {
  return {
    audioDeleted: overview?.audioDeleted ?? false,
    call,
    // Before the overview is read, the record's count of the open ones.
    notClosed: overview?.openQuestions ?? call.openCount,
    pending: overview?.pendingProposals ?? 0,
    title: overview?.title || call.title.trim() || projectName(call.projectId),
  };
}

/** «Ноябрь», with the year for another year's month. */
function monthOf(call: CallRecord, year: number) {
  const started = new Date(call.startedAt).getFullYear();
  return started === year ? call.month : `${call.month} ${started}`;
}

function byMonth(
  entries: HistoryEntry[],
  projectName?: (id: string | null) => string
): HistoryMonth[] {
  const months: HistoryMonth[] = [];
  const year = new Date().getFullYear();
  const sorted = [...entries].sort(
    (a, b) => b.call.startedAt - a.call.startedAt
  );
  for (const { audioDeleted, call, notClosed, pending, title } of sorted) {
    const heading = monthOf(call, year);
    let month = months.at(-1);
    if (month?.month !== heading) {
      month = { calls: [], month: heading };
      months.push(month);
    }
    const people = [call.participants, audioDeleted ? "аудио удалено" : ""]
      .filter(Boolean)
      .join(", ");
    month.calls.push({
      date: call.date,
      duration: call.duration,
      id: call.id,
      openCount: notClosed,
      participants: projectName
        ? [projectName(call.projectId), people].filter(Boolean).join(" · ")
        : people,
      proposals: pending > 0 ? pending : undefined,
      time: call.time,
      title,
    });
  }
  return months;
}

function matchesFilter(entry: HistoryEntry, filter: string) {
  if (filter === ALL) {
    return true;
  }
  if (filter === OPEN) {
    return entry.notClosed > 0;
  }
  return entry.call.participantIds.includes(filter);
}

/** «Клиент, 12:21», «в итогах звонка», «, и ещё 5». */
function metaOf(match: CallSearchMatch, more: number) {
  let meta = "в итогах звонка";
  if (match.source === "title") {
    meta = "в названии звонка";
  } else if (match.source === "segment") {
    const who = match.channel === "me" ? "Вы" : "Клиент";
    meta = match.at === null ? who : `${who}, ${clockTime(match.at, false)}`;
  }
  return more > 0 ? `${meta}, и ещё ${more}` : meta;
}

type SearchRow = SearchResult & { projectId: string | null };

/** One row per call: its first match, and how many more it has. */
function searchRows(
  matches: CallSearchMatch[],
  entries: Map<string, HistoryEntry>,
  projectName: (id: string | null) => string
): SearchRow[] {
  const perCall = new Map<string, CallSearchMatch[]>();
  for (const match of matches) {
    const found = perCall.get(match.callId);
    if (found) {
      found.push(match);
    } else {
      perCall.set(match.callId, [match]);
    }
  }
  return [...perCall].flatMap(([callId, found]) => {
    const entry = entries.get(callId);
    const [first] = found;
    if (!(entry && first)) {
      return [];
    }
    const { call } = entry;
    return [
      {
        callId,
        date: call.date,
        duration: call.duration,
        id: callId,
        match: {
          after: first.after,
          before: first.before,
          meta: metaOf(first, found.length - 1),
          text: first.text,
        },
        moment: first.moment ? momentParam(first.moment) : undefined,
        openCount: entry.notClosed,
        project: projectName(call.projectId),
        projectId: call.projectId,
        time: call.time,
        title: entry.title,
      },
    ];
  });
}

function searchSummary(
  status: Synced<unknown>["status"],
  calls: number,
  total: number
) {
  // The last results stay while the next ones are read.
  if (status === "loading" && calls === 0) {
    return "Ищу…";
  }
  if (status === "error") {
    return "Поиск не удался";
  }
  if (calls === 0) {
    return "Ничего не нашлось";
  }
  return `${calls} ${plural(calls, "звонок", "звонка", "звонков")}, ${total} ${plural(total, "совпадение", "совпадения", "совпадений")}`;
}

const DAY_FORMAT = new Intl.DateTimeFormat("ru", {
  day: "numeric",
  month: "long",
});

/** «Звонков пока не было»: what the project has for its first call. */
function readinessOf(
  project: ProjectRecord,
  documents: number,
  people: ClientPerson[]
): ReadinessItem[] {
  const built =
    project.briefState === "fresh" || project.briefState === "outdated";
  let brief: ReadinessItem = {
    action: "Собрать",
    id: "brief",
    label: "Бриф проекта не собран",
    status: "open",
  };
  if (built) {
    brief = {
      id: "brief",
      label: "Бриф проекта собран",
      meta:
        project.briefState === "outdated"
          ? "устарел"
          : DAY_FORMAT.format(project.briefBuiltAt ?? Date.now()),
      status: "done",
    };
  } else if (project.briefState === "building") {
    brief = {
      id: "brief",
      label: "Бриф проекта собирается",
      status: "open",
    };
  }
  return [
    brief,
    documents > 0
      ? {
          id: "documents",
          label: "Документы добавлены",
          meta: `${documents} ${plural(documents, "документ", "документа", "документов")}`,
          status: "done",
        }
      : {
          action: "Добавить",
          id: "documents",
          label: "Документы не добавлены",
          status: "open",
        },
    people.length > 0
      ? {
          id: "people",
          label: "Люди клиента добавлены",
          meta: `${people.length} ${plural(people.length, "человек", "человека", "человек")}`,
          status: "done",
        }
      : {
          action: "Добавить",
          id: "people",
          label: "Люди клиента не добавлены",
          status: "open",
        },
  ];
}

function History({ projectId }: { projectId: string | null }) {
  const demo = useDemoState(DEMO_STATES);
  const projects = useProjects();
  const calls = useCalls();
  const people = usePeople(projectId);
  const sources = useProjectSources(projectId);
  const [query, setQuery] = useState(demo === "search" ? SEARCH.query : "");
  const [filter, setFilter] = useState(ALL);
  // A project's history searches its calls; the pills widen it.
  const [searchFilter, setSearchFilter] = useState(projectId ?? ALL);
  const found = useCallSearch(
    query,
    searchFilter === ALL ? null : searchFilter
  );

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

  const overview = useCallsOverview();
  const entries = useMemo(
    () =>
      calls.map((call) => entryOf(call, overview.get(call.id), projectName)),
    [calls, overview, projectName]
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
      projectId
        ? entries.filter((entry) => entry.call.projectId === projectId)
        : entries,
    [entries, projectId]
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
        count: scoped.filter((entry) => entry.notClosed > 0).length,
        id: OPEN,
        label: "С открытыми вопросами",
      },
      ...people
        .filter((person) =>
          scoped.some((entry) => entry.call.participantIds.includes(person.id))
        )
        .map((person) => ({ id: person.id, label: person.name })),
    ];
  }, [calls.length, people, projectId, scoped, sidebarProjects]);

  const months = useMemo(() => {
    const listed = projectId
      ? scoped.filter((entry) => matchesFilter(entry, filter))
      : scoped.filter(
          (entry) => filter === ALL || entry.call.projectId === filter
        );
    return byMonth(listed, projectId ? undefined : projectName);
  }, [filter, projectId, projectName, scoped]);

  const search = useMemo<HistorySearch>(() => {
    const byId = new Map(entries.map((entry) => [entry.call.id, entry]));
    const rows = searchRows(found.data.matches, byId, projectName);
    // Per project over every call, whatever the search was narrowed to.
    const counts = new Map(
      found.data.projects.map((item) => [item.projectId, item.calls])
    );
    const everywhere = found.data.projects.reduce(
      (total, item) => total + item.calls,
      0
    );
    return {
      filter: {
        onValueChange: setSearchFilter,
        options: [
          { count: everywhere, id: ALL, label: "Все проекты" },
          ...projects.map((item) => ({
            count: counts.get(item.id) ?? 0,
            id: item.id,
            label: item.name,
          })),
        ],
        value: searchFilter,
      },
      hint: SEARCH.hint,
      results: rows.filter(
        (row) => searchFilter === ALL || row.projectId === searchFilter
      ),
      summary: searchSummary(found.status, rows.length, found.data.total),
    };
  }, [entries, found, projectName, projects, searchFilter]);

  const readiness = useMemo(
    () => (project ? readinessOf(project, sources.length, people) : undefined),
    [people, project, sources.length]
  );

  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next);
      if (!next.trim()) {
        setSearchFilter(projectId ?? ALL);
      }
    },
    [projectId]
  );

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
        readiness={readiness ?? []}
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
