import Link from "next/link";

import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import { ChevronRightIcon } from "../icons";
import type { HomeProject } from "../mock";
import { SourceTile } from "./source-mark";

/*
 * Home, "Проекты": a table of the projects. Fixed columns line up the rows:
 * project (fills), last call 220, open questions 150, sources 120 and the
 * 16px chevron. The whole row is one link to the project's brief; the column
 * titles are visual only, every row reads as one sentence.
 * The columns need a wide table (`@4xl/projects`); narrower, each row
 * stacks: the project on top, its call, questions and sources wrap below.
 */

const COLUMNS = {
  call: "@4xl/projects:w-[220px] @4xl/projects:shrink-0",
  chevron: "w-4 shrink-0",
  open: "@4xl/projects:w-[150px] @4xl/projects:shrink-0",
  sources: "@4xl/projects:w-[120px] @4xl/projects:shrink-0",
};

export function ProjectsTable({
  className,
  projects,
}: {
  className?: string;
  projects: HomeProject[];
}) {
  return (
    <div className={cn("@container/projects flex flex-col", className)}>
      <div
        aria-hidden="true"
        className="border-border text-muted-foreground hidden h-8 shrink-0 items-center gap-6 border-b px-4 text-xs @4xl/projects:flex"
      >
        <span className="min-w-0 flex-1">Проект</span>
        <span className={COLUMNS.call}>Последний звонок</span>
        <span className={COLUMNS.open}>Открытые вопросы</span>
        <span className={COLUMNS.sources}>Источники</span>
        <span className={COLUMNS.chevron} />
      </div>
      <ul aria-label="Проекты" className="flex flex-col">
        {projects.map((project) => (
          <li
            className="border-border border-b last:border-b-0"
            key={project.id}
          >
            <ProjectTableRow project={project} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ProjectTableRow({
  className,
  href,
  project,
}: {
  className?: string;
  href?: string;
  project: HomeProject;
}) {
  return (
    <Link
      className={cn(
        "group/project focus-visible:focus-ring grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 rounded-sm p-4 transition-colors @4xl/projects:flex @4xl/projects:gap-6",
        className
      )}
      href={href ?? routes.project(project.id)}
    >
      <span className="col-start-1 row-start-1 flex min-w-0 flex-1 items-center gap-3.5">
        <span
          aria-hidden="true"
          className="bg-surface text-foreground flex size-9 shrink-0 items-center justify-center rounded-sm text-base font-semibold"
        >
          {project.initial}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground truncate text-lg font-medium">
            {project.name}
          </span>
          <span className="text-muted-foreground truncate text-sm">
            {project.description}
          </span>
        </span>
      </span>
      {/* A wrapping line under the name; dissolves into the row's columns. */}
      <span className="col-start-1 row-start-2 flex flex-wrap items-center gap-x-6 gap-y-2 pl-[50px] @4xl/projects:contents">
        <span className={cn(COLUMNS.call, "flex flex-col gap-0.5")}>
          {project.lastCall ? (
            <>
              <span className="text-foreground text-sm/5 tabular-nums">
                {project.lastCall.when}
              </span>
              <span className="text-muted-foreground text-sm">
                {project.lastCall.people}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground text-sm">
              Звонков ещё не было
            </span>
          )}
        </span>
        <OpenQuestions className={COLUMNS.open} open={project.open} />
        <span className={cn(COLUMNS.sources, "flex gap-1.5")}>
          {project.sources.map((source) => (
            <SourceTile
              key={source.kind}
              kind={source.kind}
              label={source.hint}
            />
          ))}
        </span>
      </span>
      <ChevronRightIcon className="text-subtle group-hover/project:text-foreground col-start-2 row-span-2 row-start-1 size-4 shrink-0 transition-colors" />
    </Link>
  );
}

/**
 * Open questions of a project: a 6px dot (orange when new ones appeared after
 * the last call, gray otherwise), the count in mono and a muted note.
 */
export function OpenQuestions({
  className,
  open,
}: {
  className?: string;
  open: HomeProject["open"];
}) {
  return (
    <span className={cn("flex items-center gap-2 text-sm", className)}>
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          open && (open.fresh ? "bg-accent" : "bg-subtle")
        )}
      />
      {open ? (
        <>
          <span className="text-foreground font-mono">
            {open.count}
            <span className="sr-only"> открытых вопросов</span>
          </span>
          {open.note ? (
            <span className="text-muted-foreground">{open.note}</span>
          ) : null}
        </>
      ) : (
        <span className="text-muted-foreground">всё закрыто</span>
      )}
    </span>
  );
}
