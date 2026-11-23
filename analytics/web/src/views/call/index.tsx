"use client";

// «Звонок» (spec «Таймлайн звонка»): the call's totals at the top, the line
// of phrases and agent calls, the details of what is picked beside it. The
// pick lives apart from the data: a live re-read never closes or moves it
// (spec «Чтение во время звонка»).

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Kpi, Panel, Shell } from "@/components/shell";
import { LoadError, Loading, NotFound } from "@/components/states";
import { date, KIND_NAMES, span, tokens, usd } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { anchors, items, type Selection, type Timeline, totals } from "./model";
import { AgentCallPanel, FindingPanel, QuestionPanel } from "./panels";
import { TimelineList } from "./timeline";

export const CallView = () => {
  const id = useSearchParams().get("id") ?? "";
  const { connection, query } = useQuery(
    `call:${id}`,
    (api) => api.read.call({ params: { id } }),
    { call: id }
  );
  const crumbs =
    query.status === "ready" ? (
      <>
        <Link className="hover:underline" href="/">
          Проекты
        </Link>{" "}
        /{" "}
        <Link
          className="hover:underline"
          href={`/project?id=${encodeURIComponent(query.data.call.projectId)}`}
        >
          {query.data.call.projectName}
        </Link>
      </>
    ) : (
      <Link className="hover:underline" href="/">
        Проекты
      </Link>
    );
  return (
    <Shell connection={connection} crumbs={crumbs}>
      {query.status === "loading" ? <Loading rows={6} /> : null}
      {query.status === "notFound" ? <NotFound what="Звонок" /> : null}
      {query.status === "error" ? (
        <LoadError message={query.message} retry={query.retry} />
      ) : null}
      {query.status === "ready" ? <Call timeline={query.data} /> : null}
    </Shell>
  );
};

const Call = ({ timeline }: { timeline: Timeline }) => {
  const [selected, setSelected] = useState<Selection | null>(null);
  const [follow, setFollow] = useState(timeline.call.status !== "finished");
  const list = useMemo(() => items(timeline), [timeline]);
  const sums = useMemo(() => totals(timeline), [timeline]);
  const close = useCallback(() => setSelected(null), []);
  const toggleFollow = useCallback(() => setFollow((value) => !value), []);
  // The phrases the picked call was given, and the one that set it off.
  const highlighted = useMemo(() => {
    if (selected?.kind !== "agentCall") {
      return new Set<string>();
    }
    const call = timeline.agentCalls.find((item) => item.id === selected.id);
    const anchor = anchors(timeline);
    return new Set(
      [...(call?.windowSegments ?? []), call?.triggerSegmentId ?? ""].map(
        anchor
      )
    );
  }, [selected, timeline]);
  const failures = timeline.agentCalls.filter(
    (call) => !["ok", "empty"].includes(call.outcome)
  ).length;
  const live = timeline.call.status !== "finished";

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[28px] font-semibold tracking-tight">
          {timeline.call.title || "Без названия"}
          {live ? (
            <span className="text-accent-ink ml-3 align-middle text-[13px] font-medium">
              ● идёт звонок
            </span>
          ) : null}
        </h1>
        <p className="text-muted-foreground text-sm">
          {date(timeline.call.startedAt)} ·{" "}
          {span(timeline.call.startedAt, timeline.call.endedAt)} ·{" "}
          {timeline.recordings.length} записей
        </p>
      </div>
      <div
        className="grid grid-cols-2 gap-4 lg:grid-cols-4"
        data-testid="call-totals"
      >
        <Kpi label="Расход агента" value={usd(sums.all.costUsd)} />
        <Kpi label="Токены" value={tokens(sums.all.tokens)} />
        <Kpi label="Вызовов агента" value={sums.all.calls} />
        <Kpi
          hint={failures > 0 ? "таймауты, ошибки, лимит" : "все вызовы прошли"}
          label="Сбои вызовов"
          tone={failures > 0 ? "text-contradiction" : ""}
          value={failures}
        />
      </div>
      <Panel aside="токены и $" title="Итог звонка">
        <table
          className="w-full text-sm tabular-nums"
          data-testid="kind-totals"
        >
          <tbody>
            {sums.byKind.map((total) => (
              <tr
                className="border-border border-b last:border-0"
                key={total.kind}
              >
                <td className="py-2.5">
                  {KIND_NAMES[total.kind] ?? total.kind}
                </td>
                <td className="text-muted-foreground py-2.5 text-right">
                  {total.calls} вызовов
                </td>
                <td className="text-muted-foreground py-2.5 text-right">
                  {tokens(total.tokens)}
                </td>
                <td className="py-2.5 text-right font-medium">
                  {usd(total.costUsd)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Panel
          aside={
            <label className="flex cursor-pointer items-center gap-2">
              <input checked={follow} onChange={toggleFollow} type="checkbox" />
              Следовать за последней фразой
            </label>
          }
          title="Ход звонка"
        >
          {list.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Агент пока ничего не делал: первый вызов уходит после первой фразы
              клиента.
            </p>
          ) : (
            <TimelineList
              follow={follow}
              highlighted={highlighted}
              items={list}
              onSelect={setSelected}
              selected={selected}
            />
          )}
        </Panel>
        <aside className="xl:sticky xl:top-5">
          {selected ? (
            <Panel
              aside={
                <button
                  className="hover:underline"
                  onClick={close}
                  type="button"
                >
                  Закрыть
                </button>
              }
            >
              {selected.kind === "agentCall" ? (
                <AgentCallPanel
                  id={selected.id}
                  onSelect={setSelected}
                  timeline={timeline}
                />
              ) : null}
              {selected.kind === "question" ? (
                <QuestionPanel
                  id={selected.id}
                  onSelect={setSelected}
                  timeline={timeline}
                />
              ) : null}
              {selected.kind === "finding" ? (
                <FindingPanel
                  id={selected.id}
                  onSelect={setSelected}
                  timeline={timeline}
                />
              ) : null}
            </Panel>
          ) : (
            <Panel>
              <p className="text-muted-foreground text-sm">
                Нажмите на вызов агента, вопрос или находку в ходе звонка —
                здесь откроется, что ушло в Claude Code, что вернулось и что из
                этого вышло.
              </p>
            </Panel>
          )}
        </aside>
      </div>
    </>
  );
};
