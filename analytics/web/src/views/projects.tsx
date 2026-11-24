"use client";

// «Проекты» (spec «Список проектов»): every project with its calls, the
// last one, the agent's cost, and «идёт звонок» while one goes on; «Без
// проекта» last. Live: the mark comes and goes without a reload.

import type { ProjectListItem } from "@grill/analytics-server/api";
import Link from "next/link";
import { Kpi, Panel, Shell } from "@/components/shell";
import { LoadError, Loading, Problem } from "@/components/states";
import { date, usd } from "@/lib/format";
import { useQuery } from "@/lib/query";

type Project = typeof ProjectListItem.Type;

const NO_PROJECT = "none";

/** «Без проекта» last, the rest by their last call. */
export const ordered = (projects: readonly Project[]): Project[] =>
  [...projects].sort(
    (a, b) =>
      Number(a.id === NO_PROJECT) - Number(b.id === NO_PROJECT) ||
      (b.lastCallAt ?? 0) - (a.lastCallAt ?? 0)
  );

const LiveMark = () => (
  <span className="text-accent-ink inline-flex items-center gap-1.5 text-[12px] font-medium">
    <span className="bg-accent size-1.5 rounded-full" />
    идёт звонок
  </span>
);

export const ProjectsView = () => {
  const { connection, query } = useQuery(
    "projects",
    (api) => api.read.projects(),
    {}
  );

  return (
    <Shell connection={connection}>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[28px] font-semibold tracking-tight">
          Как агент работает на звонках
        </h1>
        <p className="text-muted-foreground text-sm">
          Проекты команды: звонки, расход агента и то, что идёт прямо сейчас
        </p>
      </div>
      {query.status === "loading" ? <Loading /> : null}
      {query.status === "error" ? (
        <LoadError message={query.message} retry={query.retry} />
      ) : null}
      {query.status === "ready" && query.data.length === 0 ? (
        <Problem title="Звонков пока нет">
          Сюда попадают звонки из релизных сборок Grill с аналитикой. Первый
          звонок появится через пару секунд после первой фразы клиента —
          обновлять страницу не нужно.
        </Problem>
      ) : null}
      {query.status === "ready" && query.data.length > 0 ? (
        <ProjectsList projects={query.data} />
      ) : null}
    </Shell>
  );
};

const ProjectsList = ({ projects }: { projects: readonly Project[] }) => {
  const calls = projects.reduce((sum, project) => sum + project.calls, 0);
  const cost = projects.reduce((sum, project) => sum + project.costUsd, 0);
  const live = projects.filter((project) => project.live).length;
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi
          hint="эквивалент по ценам API"
          label="Расход агента"
          value={usd(cost)}
        />
        <Kpi
          hint={`в ${projects.length} проектах`}
          label="Звонков"
          value={calls}
        />
        <Kpi
          hint={live > 0 ? "обновляется вживую" : "сейчас никто не звонит"}
          label="Идут сейчас"
          tone={live > 0 ? "text-accent-ink" : ""}
          value={live}
        />
      </div>
      <Panel aside="по последнему звонку" title="Проекты">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-border text-muted-foreground border-b text-left text-[12px]">
              <th className="pb-3 font-normal">Проект</th>
              <th className="pb-3 text-right font-normal">Звонков</th>
              <th className="hidden pb-3 text-right font-normal sm:table-cell">
                Последний звонок
              </th>
              <th className="pb-3 text-right font-normal">Расход</th>
            </tr>
          </thead>
          <tbody>
            {ordered(projects).map((project) => (
              <tr
                className="border-border border-b last:border-0"
                key={project.id}
              >
                <td className="py-4">
                  <Link
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] font-medium hover:underline"
                    href={`/project?id=${encodeURIComponent(project.id)}`}
                  >
                    {project.name}
                    {project.live ? <LiveMark /> : null}
                  </Link>
                </td>
                <td className="py-4 text-right">{project.calls}</td>
                <td className="text-muted-foreground hidden py-4 text-right sm:table-cell">
                  {date(project.lastCallAt)}
                </td>
                <td className="py-4 text-right">{usd(project.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
};
