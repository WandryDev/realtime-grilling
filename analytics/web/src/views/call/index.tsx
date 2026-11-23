"use client";

// «Звонок» (spec «Таймлайн звонка»): the call's totals at the top, the line
// of phrases and agent calls, the details of what is picked beside it. The
// pick lives apart from the data: a live re-read never closes or moves it
// (spec «Чтение во время звонка»).

import { Button } from "@grill/ui/button";
import { Toggle } from "@grill/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@grill/ui/tooltip";
import { ArrowDownToLineIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useRef, useState } from "react";
import { Kpi, Panel, ScrollPanel, Shell } from "@/components/shell";
import { LoadError, Loading, NotFound } from "@/components/states";
import { date, KIND_NAMES, span, tokens, usd } from "@/lib/format";
import { useQuery } from "@/lib/query";
import { anchors, items, type Selection, type Timeline, totals } from "./model";
import {
  AgentCallPanel,
  DetailsHead,
  FindingPanel,
  QuestionPanel,
} from "./panels";
import { StickyBar, useScrolledPast } from "./sticky-bar";
import { TimelineList } from "./timeline";

/** A column of the chat and the details: the screen less the compact head. */
const COLUMN = "h-[calc(100dvh-7.5rem)] min-h-[480px]";

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
  const changeFollow = useCallback(
    (checked: boolean) => setFollow(checked),
    []
  );
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
  const totalsRef = useRef<HTMLDivElement>(null);
  const past = useScrolledPast(totalsRef);

  return (
    <>
      <StickyBar
        live={live}
        project={timeline.call.projectName}
        shown={past}
        stats={{
          calls: sums.all.calls,
          cost: usd(sums.all.costUsd),
          failures,
          tokens: tokens(sums.all.tokens),
        }}
        title={timeline.call.title || "Без названия"}
      />
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
        ref={totalsRef}
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
      {/* Both columns as tall as the screen; each scrolls inside. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ScrollPanel
          aside={
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      aria-label="Следовать за последней фразой"
                      className="text-muted-foreground aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background aria-pressed:hover:bg-ink-hover"
                      onPressedChange={changeFollow}
                      pressed={follow}
                      size="sm"
                      variant="outline"
                    />
                  }
                >
                  <ArrowDownToLineIcon aria-hidden />
                </TooltipTrigger>
                <TooltipContent align="end" side="bottom">
                  {follow
                    ? "Следую за последней фразой · нажмите, чтобы остановиться"
                    : "Следовать за последней фразой"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          }
          className={COLUMN}
          head={
            <h2 className="text-xl font-semibold tracking-tight">Ход звонка</h2>
          }
        >
          {list.length === 0 ? (
            <p className="text-muted-foreground h-full px-6 py-5 text-sm">
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
        </ScrollPanel>
        {selected ? (
          <ScrollPanel
            aside={
              <Button onClick={close} size="sm" variant="ghost">
                <XIcon />
                Закрыть
              </Button>
            }
            className={COLUMN}
            head={<DetailsHead selection={selected} timeline={timeline} />}
          >
            <div className="h-full overflow-y-auto overscroll-contain px-6 py-5 sm:px-7">
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
            </div>
          </ScrollPanel>
        ) : (
          <Panel className="self-start">
            <p className="text-muted-foreground text-sm">
              Нажмите на вызов агента, вопрос или находку в ходе звонка — здесь
              откроется, что ушло в Claude Code, что вернулось и что из этого
              вышло.
            </p>
          </Panel>
        )}
      </div>
    </>
  );
};
