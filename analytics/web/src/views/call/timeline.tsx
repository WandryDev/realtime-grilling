"use client";

// The line of the call as a chat (Paper «06 Сообщения расшифровки»): the
// client's phrases on the left in white bubbles, the manager's on the right
// in ink, the agent's calls and findings on the left in its own bubbles
// between them. Questions and facts sit under the phrase they rest on. The
// chat scrolls inside its column; a long call is virtualized, and «Следовать
// за последней фразой» keeps the end in view as phrases come.

import { AvatarFallback } from "@grill/ui/avatar";
import { ClaudeIcon, ClickUpIcon, OutlineIcon } from "@grill/ui/brand-icons";
import { Bubble } from "@grill/ui/bubble";
import { Button } from "@grill/ui/button";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageGroup,
  MessageHeader,
} from "@grill/ui/message";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, FileTextIcon } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { inline } from "@/components/markdown";
import {
  clock,
  KIND_NAMES,
  OP_NAMES,
  OUTCOME_NAMES,
  seconds,
  usd,
} from "@/lib/format";
import {
  type AgentCall,
  type Finding,
  type Item,
  type Selection,
  type Turn,
  turns as turnsOf,
} from "./model";

/** Up to this many items the chat is plain; over it, virtualized. */
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

/** A mark under a phrase that opens what it names beside the chat. */
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
  const className = `max-w-full truncate rounded-full px-2.5 py-0.5 text-[12px] ${tone}`;
  return target && onSelect ? (
    <button
      className={`${className} text-left hover:underline`}
      onClick={open}
      type="button"
    >
      {children}
    </button>
  ) : (
    <span className={className}>{children}</span>
  );
};

/** What the agent's patch did, in a few words. */
const opsSummary = (call: AgentCall): string => {
  const applied = new Map<string, number>();
  let rejected = 0;
  for (const op of call.ops) {
    if (op.applied) {
      const name = OP_NAMES[op.op] ?? op.op;
      applied.set(name, (applied.get(name) ?? 0) + 1);
    } else {
      rejected += 1;
    }
  }
  const parts = [...applied].map(([name, count]) =>
    count > 1 ? `${name} ×${count}` : name
  );
  if (rejected > 0) {
    parts.push(`отклонено ${rejected}`);
  }
  return parts.length > 0 ? parts.join(" · ") : "без изменений";
};

/** An agent call in the chat: what it was, what it did, what it cost. */
const AgentBubble = ({
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
      className={`flex w-full max-w-[460px] flex-col gap-1 rounded-[18px] px-3.5 py-2.5 text-left text-[13px] transition-shadow ${
        failed ? "bg-contradiction-soft" : "bg-accent-soft"
      } ${active ? "ring-foreground ring-2" : "hover:ring-border-strong hover:ring-1"}`}
      data-testid="agent-call"
      onClick={open}
      type="button"
    >
      <span className="flex w-full min-w-0 items-center gap-2 tabular-nums">
        <span
          className={`size-1.5 shrink-0 rounded-full ${failed ? "bg-contradiction" : "bg-accent"}`}
        />
        <span className="truncate font-medium">
          {KIND_NAMES[call.kind] ?? call.kind}
        </span>
        {/* Narrow, only a failure says its outcome: the kind needs the room. */}
        <span
          className={`whitespace-nowrap ${
            failed
              ? "text-contradiction"
              : "text-muted-foreground hidden sm:inline"
          }`}
        >
          {OUTCOME_NAMES[call.outcome] ?? call.outcome}
        </span>
        <span className="text-muted-foreground ml-auto hidden whitespace-nowrap sm:inline">
          {seconds(call.durationMs)}
        </span>
        <span className="ml-auto shrink-0 font-medium whitespace-nowrap sm:ml-0">
          {usd(call.costUsd)}
        </span>
      </span>
      <span className="text-muted-foreground flex w-full min-w-0 gap-2 text-[12px]">
        <span className="shrink-0 tabular-nums">{clock(at)}</span>
        <span className="truncate">
          {call.error && failed ? call.error : opsSummary(call)}
        </span>
      </span>
    </button>
  );
};

const SourceMark = ({ kind }: { kind: string }) => {
  if (kind === "outline") {
    return <OutlineIcon className="size-3.5" />;
  }
  if (kind === "clickup") {
    return <ClickUpIcon className="size-3.5" />;
  }
  return <FileTextIcon aria-hidden className="size-3.5 shrink-0" />;
};

/** A finding of the slow loop in the chat: the document and its quote. */
const FindingBubble = ({
  at,
  finding,
  props,
}: {
  at: number;
  finding: Finding;
  props: Props;
}) => {
  const { onSelect, selected } = props;
  const open = useCallback(
    () => onSelect({ id: finding.id, kind: "finding" }),
    [onSelect, finding.id]
  );
  const active = selected?.kind === "finding" && selected.id === finding.id;
  return (
    <button
      aria-pressed={active}
      className={`bg-assumption-soft flex w-full max-w-[460px] flex-col gap-1 rounded-[18px] px-3.5 py-2.5 text-left text-[13px] transition-shadow ${
        active
          ? "ring-foreground ring-2"
          : "hover:ring-border-strong hover:ring-1"
      }`}
      onClick={open}
      type="button"
    >
      <span className="text-assumption flex w-full min-w-0 items-center gap-1.5 font-medium">
        <SourceMark kind={finding.sourceKind} />
        <span className="truncate">Находка · {finding.sourceName}</span>
        <span className="text-muted-foreground ml-auto shrink-0 font-normal tabular-nums">
          {clock(at)}
        </span>
      </span>
      <span className="text-foreground line-clamp-2">
        «{inline(finding.quote)}»
      </span>
    </button>
  );
};

/** A phrase: its bubble, and the questions and facts that rest on it. */
const Phrase = ({
  item,
  last,
  props,
}: {
  item: Extract<Item, { kind: "phrase" }>;
  last: boolean;
  props: Props;
}) => {
  const { highlighted, onSelect } = props;
  const { segment } = item;
  const client = segment.channel === "others";
  const lit = highlighted.has(segment.id);
  return (
    <div
      className="flex max-w-[min(100%,640px)] min-w-0 flex-col gap-1.5 group-data-[align=end]/message:items-end"
      data-highlighted={lit || undefined}
      data-testid="phrase"
    >
      <Bubble
        className={`text-[14px] leading-5 wrap-anywhere ${
          // Only the last bubble of a turn has the tail.
          last ? "" : "rounded-br-[18px]! rounded-bl-[18px]!"
        } ${
          // On the white chat the client's bubble is gray, without the shadow
          // it has on the gray column of the call window.
          client ? "bg-surface shadow-none!" : ""
        } ${lit ? "ring-accent ring-offset-card ring-2 ring-offset-2" : ""}`}
        variant={client ? "card" : "default"}
      >
        <span>
          {segment.text}
          <span className="ml-2 text-[11px] whitespace-nowrap tabular-nums opacity-50">
            {clock(item.at)}
          </span>
        </span>
      </Bubble>
      {item.questions.length + item.facts.length > 0 ? (
        <div className="flex max-w-full flex-wrap gap-1.5 group-data-[align=end]/message:justify-end">
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
  );
};

const TurnItems = ({ props, turn }: { props: Props; turn: Turn }) =>
  turn.items.map((item, index) => {
    if (item.kind === "agentCall") {
      return (
        <AgentBubble
          at={item.at}
          call={item.call}
          key={item.key}
          props={props}
        />
      );
    }
    if (item.kind === "finding") {
      return (
        <FindingBubble
          at={item.at}
          finding={item.finding}
          key={item.key}
          props={props}
        />
      );
    }
    return (
      <Phrase
        item={item}
        key={item.key}
        last={index === turn.items.length - 1}
        props={props}
      />
    );
  });

const TurnView = ({ props, turn }: { props: Props; turn: Turn }) => {
  if (turn.speaker === "manager") {
    return (
      <Message align="end">
        <MessageContent>
          <MessageHeader>Менеджер</MessageHeader>
          <TurnItems props={props} turn={turn} />
        </MessageContent>
      </Message>
    );
  }
  const agent = turn.speaker === "agent";
  return (
    <Message>
      <MessageAvatar>
        <AvatarFallback className={agent ? "bg-accent-soft" : ""}>
          {agent ? <ClaudeIcon className="size-3.5" /> : "К"}
        </AvatarFallback>
      </MessageAvatar>
      <MessageContent>
        <MessageHeader>{agent ? "Агент" : "Клиент"}</MessageHeader>
        <TurnItems props={props} turn={turn} />
      </MessageContent>
    </Message>
  );
};

const SCROLLER =
  "bg-card h-full overflow-y-auto overscroll-contain px-4 py-5 sm:px-6";

/** Keeps the end of `scroller` in view while `follow` and `count` grows. */
const useFollow = (
  scroller: React.RefObject<HTMLDivElement | null>,
  follow: boolean,
  count: number,
  toEnd?: () => void
) => {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new item is what moves the end
  useEffect(() => {
    const element = scroller.current;
    if (!(follow && element)) {
      return;
    }
    if (toEnd) {
      toEnd();
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, [follow, count]);
};

/** How close to the end still counts as being at the latest phrase. */
const AT_END = 80;

/** Whether `scroller` shows its end; read on scroll and as items come. */
const useAtEnd = (
  scroller: React.RefObject<HTMLDivElement | null>,
  count: number
): boolean => {
  const [atEnd, setAtEnd] = useState(true);
  const measure = useCallback(() => {
    const element = scroller.current;
    if (element) {
      setAtEnd(
        element.scrollHeight - element.scrollTop - element.clientHeight < AT_END
      );
    }
  }, [scroller]);
  useEffect(() => {
    const element = scroller.current;
    element?.addEventListener("scroll", measure, { passive: true });
    return () => element?.removeEventListener("scroll", measure);
  }, [scroller, measure]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new items move the end away
  useEffect(measure, [count, measure]);
  return atEnd;
};

/** «К последней фразе»: shown while the chat is read above its end. */
const ToEnd = ({ onClick, shown }: { onClick: () => void; shown: boolean }) => (
  <Button
    aria-hidden={!shown}
    aria-label="К последней фразе"
    className={`shadow-touch absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full transition-[opacity,translate] duration-200 ${
      shown ? "" : "pointer-events-none translate-y-2 opacity-0"
    }`}
    onClick={onClick}
    size="icon"
    tabIndex={shown ? 0 : -1}
    variant="secondary"
  >
    <ArrowDownIcon aria-hidden />
  </Button>
);

/** The chat's scroller with its «К последней фразе» button over it. */
const Scroller = ({
  children,
  count,
  scroller,
  toEnd,
}: {
  children: ReactNode;
  count: number;
  scroller: React.RefObject<HTMLDivElement | null>;
  toEnd: () => void;
}) => {
  const atEnd = useAtEnd(scroller, count);
  return (
    <div className="relative h-full">
      <div className={SCROLLER} ref={scroller}>
        {children}
      </div>
      <ToEnd onClick={toEnd} shown={!atEnd} />
    </div>
  );
};

const Plain = ({ props, turns }: { props: Props; turns: readonly Turn[] }) => {
  const scroller = useRef<HTMLDivElement>(null);
  useFollow(scroller, props.follow, props.items.length);
  const toEnd = useCallback(() => {
    const element = scroller.current;
    if (!element) {
      return;
    }
    if (typeof element.scrollTo === "function") {
      element.scrollTo({ behavior: "smooth", top: element.scrollHeight });
    } else {
      element.scrollTop = element.scrollHeight;
    }
  }, []);
  return (
    <Scroller count={props.items.length} scroller={scroller} toEnd={toEnd}>
      <MessageGroup>
        {turns.map((turn) => (
          <TurnView key={turn.key} props={props} turn={turn} />
        ))}
      </MessageGroup>
    </Scroller>
  );
};

/** The space between two turns, as in MessageGroup. */
const TURN_GAP = 18;

const Virtual = ({
  props,
  turns,
}: {
  props: Props;
  turns: readonly Turn[];
}) => {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: turns.length,
    estimateSize: () => 96,
    getItemKey: (index) => turns[index]?.key ?? index,
    getScrollElement: () => scroller.current,
    overscan: 8,
  });
  const toEnd = useCallback(() => {
    if (turns.length > 0) {
      virtualizer.scrollToIndex(turns.length - 1, { align: "end" });
    }
  }, [turns.length, virtualizer]);
  useFollow(scroller, props.follow, props.items.length, toEnd);
  return (
    <Scroller count={props.items.length} scroller={scroller} toEnd={toEnd}>
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((row) => {
          const turn = turns[row.index];
          return turn ? (
            <div
              className="absolute top-0 left-0 w-full"
              data-index={row.index}
              key={row.key}
              ref={virtualizer.measureElement}
              style={{
                paddingBottom: TURN_GAP,
                transform: `translateY(${row.start}px)`,
              }}
            >
              <TurnView props={props} turn={turn} />
            </div>
          ) : null;
        })}
      </div>
    </Scroller>
  );
};

export const TimelineList = (props: Props) => {
  const turns = useMemo(() => turnsOf(props.items), [props.items]);
  return props.items.length > PLAIN_LIMIT ? (
    <Virtual props={props} turns={turns} />
  ) : (
    <Plain props={props} turns={turns} />
  );
};
