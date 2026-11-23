"use client";

import type { ReactNode } from "react";

import { PanelPage } from "../components/call-window";
import {
  CenteredState,
  StateList,
  StateRow,
  StateRowNote,
} from "../components/centered-state";
import {
  type FilterOption,
  FilterTabs,
  HistoryCallRow,
  HistoryHeader,
  type HistoryProject,
  HistoryWindow,
  MonthHeading,
  SearchField,
  SearchResultRow,
  StartCallButton,
} from "../components/history";
import { LinkButton } from "../components/link-button";
import { usePostCallLinks } from "../components/links";
import { DoneCheck, OpenRing } from "../components/status-mark";
import { MicIcon } from "../icons";
import {
  HISTORY_PROJECTS,
  type HistoryMonth,
  PROJECT_FILTERS,
  PROJECT_HISTORY,
  PROJECT_READINESS,
  type ReadinessStatus,
  SEARCH,
  type SearchResult,
} from "../mock";

/*
 * "05 История звонков": a project's calls by month (`projectId`), search
 * across all projects (`query`), or a new project without calls yet. The
 * app passes the calls (`months`), the live search and controlled pills;
 * `projectId={null}` lists the calls of every project.
 */

/** Pills over a list: the options, the selected one and its handler. */
export interface HistoryFilter {
  onValueChange?: (value: string) => void;
  options: FilterOption[];
  value?: string;
}

/** A row of «Готовность проекта»: done, or open with an action. */
export interface ReadinessItem {
  /** Link to the project page that fixes it. */
  action?: string;
  id: string;
  label: string;
  meta?: string;
  status: ReadinessStatus;
}

export interface HistorySearch {
  filter: HistoryFilter;
  hint: string;
  results: SearchResult[];
  summary: string;
}

const PREVIEW_SEARCH: HistorySearch = {
  filter: { options: SEARCH.filters },
  hint: SEARCH.hint,
  results: SEARCH.results,
  summary: SEARCH.summary,
};

function SearchResults({
  query,
  search,
}: {
  query: string;
  search: HistorySearch;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <FilterTabs label="Проекты" {...search.filter} />
        <p className="text-muted-foreground text-sm">{search.hint}</p>
      </div>
      <section aria-labelledby="search-summary" className="flex flex-col">
        <MonthHeading>
          <span id="search-summary">{search.summary}</span>
        </MonthHeading>
        {search.results.map((result) => (
          <SearchResultRow key={result.id} query={query} result={result} />
        ))}
      </section>
    </>
  );
}

function ProjectCalls({
  filter,
  hoveredCallId,
  months,
}: {
  filter: HistoryFilter;
  hoveredCallId?: string | null;
  months: HistoryMonth[];
}) {
  return (
    <>
      <FilterTabs className="self-start" label="Фильтр звонков" {...filter} />
      <div className="flex flex-col">
        {months.map((month, index) => (
          <section
            aria-label={month.month}
            className="flex flex-col"
            key={month.month}
          >
            <MonthHeading divided={index > 0}>{month.month}</MonthHeading>
            {month.calls.map((call) => (
              <HistoryCallRow
                call={call}
                key={call.id}
                preview={call.id === hoveredCallId ? "hover" : undefined}
              />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}

function NoCalls({ readiness }: { readiness: ReadinessItem[] }) {
  const links = usePostCallLinks();
  return (
    <CenteredState
      className="flex-1"
      description="Начните звонок с клиентом, Grill подскажет вопросы по ходу. Итоги, карточки задач и расшифровка появятся здесь."
      media={<MicIcon className="size-6" />}
      mediaClassName="size-14 rounded-md"
      title="Звонков пока не было"
    >
      <StartCallButton size="lg" variant="secondary" />
      {readiness.length === 0 ? null : (
        <StateList className="max-w-[400px] pt-2" label="Готовность проекта">
          {readiness.map((item) => (
            <StateRow
              key={item.id}
              media={
                item.status === "done" ? (
                  <DoneCheck className="size-3.5" />
                ) : (
                  <span className="flex w-3.5 shrink-0 justify-center">
                    <OpenRing className="size-2" />
                  </span>
                )
              }
              trailing={
                item.action ? (
                  <LinkButton
                    className="text-foreground -my-1"
                    href={links.project}
                    size="sm"
                    variant="ghost"
                  >
                    {item.action}
                  </LinkButton>
                ) : (
                  <StateRowNote>{item.meta}</StateRowNote>
                )
              }
            >
              {item.label}
            </StateRow>
          ))}
        </StateList>
      )}
    </CenteredState>
  );
}

export function CallHistoryScreen({
  className,
  filter = { options: PROJECT_FILTERS },
  hoveredCallId = "oct-14",
  months: monthsProp,
  onQueryChange,
  projectId = "telemedia",
  projectName,
  projects,
  query,
  readiness = PROJECT_READINESS,
  search: searchProp = PREVIEW_SEARCH,
  totalCalls,
}: {
  className?: string;
  /** Pills over the calls. */
  filter?: HistoryFilter;
  /** Row drawn in its hover state; `null` for none. */
  hoveredCallId?: string | null;
  /** Calls to list by month; the project's demo calls by default. */
  months?: HistoryMonth[];
  /** Makes the search field live (app). */
  onQueryChange?: (query: string) => void;
  /** Project whose calls are listed, `null` for all; ignored while searching. */
  projectId?: string | null;
  /** Eyebrow over the title; the project's name by default. */
  projectName?: string;
  /** Projects of the sidebar with their call counts. */
  projects?: HistoryProject[];
  /** Search across all projects. */
  query?: string;
  /** «Готовность проекта» of a project without calls; none hides it. */
  readiness?: ReadinessItem[];
  search?: HistorySearch;
  totalCalls?: number;
}) {
  const searching = Boolean(query);
  const all = projectId === null;
  const months = monthsProp ?? PROJECT_HISTORY[projectId ?? ""] ?? [];
  const project = HISTORY_PROJECTS.find((item) => item.id === projectId);
  const isEmpty = !searching && months.length === 0;
  const live = onQueryChange !== undefined;

  let eyebrow = projectName ?? project?.name ?? "";
  if (searching || all) {
    eyebrow = "Все проекты";
  }

  let search: ReactNode = (
    <SearchField
      label="Поиск по звонкам"
      onQueryChange={onQueryChange}
      placeholder="Поиск по звонкам"
      query={live ? query : undefined}
      shortcut="⌘K"
    />
  );
  if (searching) {
    search = (
      <SearchField
        className="w-80"
        label="Поиск по звонкам"
        onQueryChange={onQueryChange}
        placeholder="Поиск по звонкам"
        preview={live ? undefined : "focus"}
        query={query}
      />
    );
  } else if (isEmpty && !all) {
    search = null;
  }

  return (
    <HistoryWindow
      active={searching || all ? "all" : (projectId ?? "all")}
      className={className}
      projects={projects}
      total={totalCalls}
    >
      <PanelPage className="flex-1 pb-12">
        <HistoryHeader action={search} eyebrow={eyebrow} title="Звонки" />
        {searching && query ? (
          <SearchResults query={query} search={searchProp} />
        ) : null}
        {isEmpty ? <NoCalls readiness={readiness} /> : null}
        {searching || isEmpty ? null : (
          <ProjectCalls
            filter={filter}
            hoveredCallId={hoveredCallId}
            months={months}
          />
        )}
      </PanelPage>
    </HistoryWindow>
  );
}
