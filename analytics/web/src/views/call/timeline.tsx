"use client";

// The line of the call: the phrases of «Менеджер» and «Клиент», the agent's
// calls between them, the questions and facts on the phrases they rest on,
// the findings when they came. A long call is virtualized; «Следовать за
// последней фразой» keeps the end in view as phrases come.

import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import { clock, KIND_NAMES, OUTCOME_NAMES, seconds, usd } from "@/lib/format";
import type { AgentCall, Item, Selection } from "./model";

/** Up to this many items the list is plain; over it, virtualized. */
const PLAIN_LIMIT = 300;

const FAILED = new Set([
  "error",
  "timeout",
  "invalid",
  "rate_limited",
  "not_logged_in",
]);

interface Props {
  readonly follow: boolean;
  readonly highlighted: ReadonlySet<string>;
  readonly items: readonly Item[];
  readonly onSelect: (selection: Selection) => void;
  readonly selected: Selection | null;
}

/** A mark that opens what it names beside the timeline. */
const Chip = ({
  children,
  onSelect,
  target,
  tone,
}: {
  children: ReactNode;
  onSelect?: (selection: Selection) => void;
  target?: Selection;
  tone: string;
}) => {
  const open = useCallback(() => {
    if (target && onSelect) {
      onSelect(target);
    }
  }, [onSelect, target]);
  return target && onSelect ? (
    <button
      className={`max-w-full truncate rounded-md px-2 py-0.5 text-left text-[12px] ${tone} hover:underline`}
      onClick={open}
      type="button"
    >
      {children}
    </button>
  ) : (
    <span
      className={`max-w-full truncate rounded-md px-2 py-0.5 text-[12px] ${tone}`}
    >
      {children}
    </span>
  );
};

/** The mark of an agent call between the phrases. */
const CallMark = ({
  at,
  call,
  props,
}: {
  at: number;
  call: AgentCall;
  props: Props;
}) => {
  const { onSelect, selected } = props;
  const open = useCallback(
    () => onSelect({ id: call.id, kind: "agentCall" }),
    [onSelect, call.id]
  );
  const failed = FAILED.has(call.outcome);
  const active = selected?.kind === "agentCall" && selected.id === call.id;
  return (
    <button
      aria-pressed={active}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-left text-[12px] tabular-nums ${
        active ? "bg-foreground text-background" : "hover:bg-muted"
      }`}
      data-testid="agent-call"
      onClick={open}
      type="button"
    >
      <span className="text-muted-foreground w-14 shrink-0">{clock(at)}</span>
      <span
        className={`size-1.5 shrink-0 rounded-full ${failed ? "bg-contradiction" : "bg-accent"}`}
      />
      <span className="font-medium">{KIND_NAMES[call.kind] ?? call.kind}</span>
      <span
        className={
          failed && !active ? "text-contradiction" : "text-muted-foreground"
        }
      >
        {OUTCOME_NAMES[call.outcome] ?? call.outcome}
      </span>
      <span className="text-muted-foreground ml-auto">
        {seconds(call.durationMs)}
      </span>
      <span className="w-14 text-right">{usd(call.costUsd)}</span>
    </button>
  );
};

const Row = ({ item, props }: { item: Item; props: Props }) => {
  const { highlighted, onSelect } = props;
  if (item.kind === "agentCall") {
    return <CallMark at={item.at} call={item.call} props={props} />;
  }
  if (item.kind === "finding") {
    const { finding } = item;
    return (
      <div className="flex items-center gap-3 px-3 py-1 text-[12px]">
        <span className="text-muted-foreground w-14 shrink-0 tabular-nums">
          {clock(item.at)}
        </span>
        <Chip
          onSelect={onSelect}
          target={{ id: finding.id, kind: "finding" }}
          tone="bg-assumption-soft text-assumption"
        >
          Находка · {finding.sourceName}: «{finding.quote}»
        </Chip>
      </div>
    );
  }
  const { segment } = item;
  const client = segment.channel === "others";
  const lit = highlighted.has(segment.id);
  return (
    <div
      className={`flex gap-3 rounded-lg px-3 py-2 ${lit ? "bg-accent-soft" : ""}`}
      data-highlighted={lit || undefined}
      data-testid="phrase"
    >
      <span className="text-muted-foreground w-14 shrink-0 pt-0.5 text-[12px] tabular-nums">
        {clock(item.at)}
      </span>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="text-[14px] leading-5">
          <span
            className={`mr-2 text-[12px] ${client ? "font-medium" : "text-muted-foreground"}`}
          >
            {client ? "Клиент" : "Менеджер"}
          </span>
          {segment.text}
        </div>
        {item.questions.length + item.facts.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {item.questions.map((question) => (
              <Chip
                key={question.id}
                onSelect={onSelect}
                target={{ id: question.id, kind: "question" }}
                tone="bg-accent-soft text-accent-ink"
              >
                Вопрос · {question.text}
              </Chip>
            ))}
            {item.facts.map((fact) => (
              <Chip
                key={`${fact.field}:${fact.value}`}
                tone="bg-confirmed-soft text-confirmed"
              >
                Факт · {fact.value}
              </Chip>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const Plain = ({ props }: { props: Props }) => {
  const end = useRef<HTMLDivElement>(null);
  const count = props.items.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item is what moves the end
  useEffect(() => {
    if (props.follow) {
      end.current?.scrollIntoView?.({ block: "end" });
    }
  }, [props.follow, count]);
  return (
    <div className="flex flex-col gap-0.5">
      {props.items.map((item) => (
        <Row item={item} key={item.key} props={props} />
      ))}
      <div ref={end} />
    </div>
  );
};

const Virtual = ({ props }: { props: Props }) => {
  const parent = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: props.items.length,
    estimateSize: () => 44,
    getItemKey: (index) => props.items[index]?.key ?? index,
    getScrollElement: () => parent.current,
    overscan: 12,
  });
  const count = props.items.length;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item is what moves the end
  useEffect(() => {
    if (props.follow && count > 0) {
      virtualizer.scrollToIndex(count - 1, { align: "end" });
    }
  }, [props.follow, count]);
  return (
    <div className="h-[70vh] overflow-y-auto" ref={parent}>
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const item = props.items[row.index];
          return item ? (
            <div
              className="absolute top-0 left-0 w-full"
              data-index={row.index}
              key={row.key}
              ref={virtualizer.measureElement}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <Row item={item} props={props} />
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
};

export const TimelineList = (props: Props) =>
  props.items.length > PLAIN_LIMIT ? (
    <Virtual props={props} />
  ) : (
    <Plain props={props} />
  );
