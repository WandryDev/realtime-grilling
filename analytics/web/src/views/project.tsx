"use client";

// «Сводка проекта» (spec «Сводка проекта»): its calls, the agent's tokens
// and cost by kind (the call itself, the review after it, the brief apart),
// what became of the questions, and the sources the agent leaned on.

import type { KindCost, ProjectSummary } from "@grill/analytics-server/api";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Kpi, Panel, Shell } from "@/components/shell";
import { LoadError, Loading, NotFound } from "@/components/states";
import {
  AFTER_KINDS,
  date,
  KIND_NAMES,
  LIVE_KINDS,
  percent,
  span,
  tokens,
  usd,
} from "@/lib/format";
import { useQuery } from "@/lib/query";

type Summary = typeof ProjectSummary.Type;
type Cost = typeof KindCost.Type;

const SOURCE_KINDS: Record<string, string> = {
  clickup: "ClickUp",
  file: "Файл",
  outline: "Outline",
};

const sum = (rows: readonly Cost[], kinds: readonly string[]) =>
  rows
    .filter((row) => kinds.includes(row.kind))
    .reduce((total, row) => total + row.costUsd, 0);

export const ProjectView = () => {
  const id = useSearchParams().get("id") ?? "";
  const { connection, query } = useQuery(
    `project:${id}`,
    (api) => api.read.project({ params: { id } }),
    { project: id }
  );
  const name = query.status === "ready" ? query.data.name : "Проект";
  return (
    <Shell
      connection={connection}
      crumbs={
        <>
          <Link className="hover:underline" href="/">
            Проекты
          </Link>{" "}
          / {name}
        </>
      }
    >
      {query.status === "loading" ? <Loading rows={6} /> : null}
      {query.status === "notFound" ? <NotFound what="Проект" /> : null}
      {query.status === "error" ? (
        <LoadError message={query.message} retry={query.retry} />
      ) : null}
      {query.status === "ready" ? <Overview summary={query.data} /> : null}
    </Shell>
  );
};

const Overview = ({ summary }: { summary: Summary }) => {
  const live = sum(summary.costByKind, LIVE_KINDS);
  const after = sum(summary.costByKind, AFTER_KINDS);
  const { questions } = summary;
  const useful = questions.answered + questions.asked + questions.pinned;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[28px] font-semibold tracking-tight">
          {summary.name}
        </h1>
        <p className="text-muted-foreground text-sm">
          {summary.calls.length} звонков · расход агента по ценам API
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          hint="быстрый, проверка темы, медленный"
          label="Во время звонков"
          value={usd(live)}
        />
        <Kpi
          hint="итоги и предложения"
          label="Разбор после звонков"
          value={usd(after)}
        />
        <Kpi
          hint={`${summary.brief.calls} сборок`}
          label="Бриф проекта"
          value={usd(summary.brief.costUsd)}
        />
        <Kpi
          hint={`${useful} из ${questions.shown} показанных заданы, отвечены или закреплены`}
          label="Полезность вопросов"
          value={percent(useful, questions.shown)}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.6fr_1fr]">
        <Panel aside="новые сверху" title="Звонки">
          <Calls summary={summary} />
        </Panel>
        <Panel aside="за всё время" title="Вопросы">
          <Questions summary={summary} />
        </Panel>
      </div>
      <Panel aside="токены и $" title="Расход по видам вызовов">
        <Kinds summary={summary} />
      </Panel>
      <Panel
        aside="кандидаты · находки · основания вопросов"
        title="Outline и ClickUp"
      >
        <Sources summary={summary} />
      </Panel>
    </>
  );
};

const Calls = ({ summary }: { summary: Summary }) =>
  summary.calls.length === 0 ? (
    <p className="text-muted-foreground text-sm">
      Звонков за это время не было.
    </p>
  ) : (
    <table className="w-full text-sm tabular-nums">
      <thead>
        <tr className="border-border text-muted-foreground border-b text-left text-[12px]">
          <th className="pb-3 font-normal">Звонок</th>
          <th className="pb-3 text-right font-normal">Длительность</th>
          <th className="pb-3 text-right font-normal">Сбои</th>
          <th className="pb-3 text-right font-normal">Расход</th>
        </tr>
      </thead>
      <tbody>
        {summary.calls.map((call) => (
          <tr className="border-border border-b last:border-0" key={call.id}>
            <td className="py-3.5">
              <Link
                className="font-medium hover:underline"
                href={`/call?id=${encodeURIComponent(call.id)}`}
              >
                {call.title || "Без названия"}
              </Link>
              <div className="text-muted-foreground text-[12px]">
                {date(call.startedAt)}
                {call.status === "finished" ? "" : " · идёт"}
              </div>
            </td>
            <td className="py-3.5 text-right">
              {span(call.startedAt, call.endedAt)}
            </td>
            <td
              className={`py-3.5 text-right ${call.failures > 0 ? "text-contradiction" : "text-muted-foreground"}`}
            >
              {call.failures}
            </td>
            <td className="py-3.5 text-right">{usd(call.costUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

const KindRow = ({ cost, max }: { cost: Cost; max: number }) => (
  <tr className="border-border border-b last:border-0">
    <td className="py-3 pr-4">{KIND_NAMES[cost.kind] ?? cost.kind}</td>
    <td className="hidden w-1/3 py-3 sm:table-cell">
      <div className="bg-muted h-2 rounded-full">
        <div
          className="bg-foreground h-2 rounded-full"
          style={{ width: `${max === 0 ? 0 : (cost.costUsd / max) * 100}%` }}
        />
      </div>
    </td>
    <td className="py-3 text-right">{cost.calls}</td>
    <td className="hidden py-3 text-right md:table-cell">
      {tokens(cost.inputTokens + cost.cacheRead + cost.cacheWrite)}
    </td>
    <td className="hidden py-3 text-right md:table-cell">
      {tokens(cost.outputTokens)}
    </td>
    <td className="py-3 text-right font-medium">{usd(cost.costUsd)}</td>
  </tr>
);

const Kinds = ({ summary }: { summary: Summary }) => {
  const max = Math.max(
    ...summary.costByKind.map((cost) => cost.costUsd),
    summary.brief.costUsd
  );
  const group = (title: string, kinds: readonly string[]) => (
    <>
      <tr>
        <td
          className="text-muted-foreground pt-4 pb-1 text-[12px] font-medium"
          colSpan={6}
        >
          {title} · {usd(sum(summary.costByKind, kinds))}
        </td>
      </tr>
      {summary.costByKind
        .filter((cost) => kinds.includes(cost.kind))
        .map((cost) => (
          <KindRow cost={cost} key={cost.kind} max={max} />
        ))}
    </>
  );
  return (
    <table className="w-full text-sm tabular-nums" data-testid="kinds">
      <thead>
        <tr className="border-border text-muted-foreground border-b text-left text-[12px]">
          <th className="pb-3 font-normal">Вид</th>
          <th className="hidden pb-3 sm:table-cell" />
          <th className="pb-3 text-right font-normal">Вызовов</th>
          <th className="hidden pb-3 text-right font-normal md:table-cell">
            Вход + кеш
          </th>
          <th className="hidden pb-3 text-right font-normal md:table-cell">
            Выход
          </th>
          <th className="pb-3 text-right font-normal">$</th>
        </tr>
      </thead>
      <tbody>
        {group("Во время звонков", LIVE_KINDS)}
        {group("Разбор после звонков", AFTER_KINDS)}
        <tr>
          <td
            className="text-muted-foreground pt-4 pb-1 text-[12px] font-medium"
            colSpan={6}
          >
            Проект
          </td>
        </tr>
        <KindRow cost={summary.brief} max={max} />
      </tbody>
    </table>
  );
};

const Questions = ({ summary }: { summary: Summary }) => {
  const { questions } = summary;
  const rows: [string, number][] = [
    ["Создано", questions.created],
    ["Показано", questions.shown],
    ["Закреплено", questions.pinned],
    ["Задано", questions.asked],
    ["Отвечено", questions.answered],
    ["Скрыто", questions.hidden],
    ["Ушло в очередь без действия", questions.requeued],
  ];
  return (
    <dl className="flex flex-col text-sm tabular-nums" data-testid="questions">
      {rows.map(([label, value]) => (
        <div
          className="border-border flex items-baseline justify-between border-b py-2.5 last:border-0"
          key={label}
        >
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="flex gap-3">
            <span className="font-medium">{value}</span>
            {label === "Создано" || label === "Показано" ? null : (
              <span className="text-muted-foreground w-12 text-right">
                {percent(value, questions.shown)}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
};

const Sources = ({ summary }: { summary: Summary }) =>
  summary.sources.length === 0 ? (
    <p className="text-muted-foreground text-sm">
      Медленный контур ещё не искал в документах этого проекта.
    </p>
  ) : (
    <table className="w-full text-sm tabular-nums" data-testid="sources">
      <thead>
        <tr className="border-border text-muted-foreground border-b text-left text-[12px]">
          <th className="pb-3 font-normal">Документ или задача</th>
          <th className="pb-3 text-right font-normal">Кандидатов</th>
          <th className="pb-3 text-right font-normal">Находок</th>
          <th className="pb-3 text-right font-normal">Оснований</th>
        </tr>
      </thead>
      <tbody>
        {summary.sources.map((source) => (
          <tr
            className="border-border border-b last:border-0"
            key={`${source.sourceKind}:${source.sourceName}`}
          >
            <td className="py-3">
              {source.sourceUrl ? (
                <a
                  className="font-medium hover:underline"
                  href={source.sourceUrl}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {source.sourceName}
                </a>
              ) : (
                <span className="font-medium">{source.sourceName}</span>
              )}
              <span className="text-muted-foreground">
                {" "}
                · {SOURCE_KINDS[source.sourceKind] ?? source.sourceKind}
              </span>
            </td>
            <td className="py-3 text-right">{source.candidates}</td>
            <td className="py-3 text-right">{source.findings}</td>
            <td className="py-3 text-right font-medium">{source.grounds}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
