"use client";

import { AvatarFallback } from "@grill/ui/avatar";
import { Badge, type BadgeVariant } from "@grill/ui/badge";
import { ClaudeIcon, OutlineIcon } from "@grill/ui/brand-icons";
import { Bubble } from "@grill/ui/bubble";
import { Button } from "@grill/ui/button";
import { Message, MessageAvatar, MessageContent } from "@grill/ui/message";
import { type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";

import {
  ArrowRightIcon,
  ChevronUpIcon,
  PlaySmallIcon,
  SpeechIcon,
} from "../icons";
import type {
  FactSourceKind,
  FactStatus,
  NextQuestion,
  TaskFactData,
} from "../mock";
import { LinkButton } from "./link-button";
import { TRANSCRIPT_DELETED, usePostCallLinks } from "./links";
import { FACT_STATUS_LABEL, StatusDot } from "./status-mark";

/*
 * "03 Карточки задач": a card per topic with seven fields. Every fact has a
 * status on the right and its source under the text; a source with a quote
 * expands into the phrase from the transcript.
 */

const STATUS_BADGE: Record<FactStatus, BadgeVariant> = {
  assumption: "assumption",
  confirmed: "confirmed",
  contradiction: "contradiction",
  empty: "empty",
};

export function FactBadge({
  className,
  status,
}: {
  className?: string;
  status: FactStatus;
}) {
  return (
    <Badge
      className={className}
      indicator={false}
      variant={STATUS_BADGE[status]}
    >
      <StatusDot tone={status} />
      {FACT_STATUS_LABEL[status]}
    </Badge>
  );
}

/** Dot legend of the statuses next to the topic tabs. */
export function StatusLegend({ className }: { className?: string }) {
  const statuses: FactStatus[] = [
    "confirmed",
    "assumption",
    "contradiction",
    "empty",
  ];
  return (
    <ul
      aria-label="Статусы"
      className={cn("flex flex-wrap items-center gap-x-3.5 gap-y-1", className)}
    >
      {statuses.map((status) => (
        <li
          className="text-muted-foreground flex items-center gap-1.5 text-sm"
          key={status}
        >
          <StatusDot tone={status} />
          {FACT_STATUS_LABEL[status]}
        </li>
      ))}
    </ul>
  );
}

const SOURCE_ICON: Record<FactSourceKind, ReactNode> = {
  agent: <ClaudeIcon aria-hidden="true" className="size-3 shrink-0" />,
  docs: <OutlineIcon aria-hidden="true" className="size-3 shrink-0" />,
  none: null,
  said: <SpeechIcon className="size-3 shrink-0" />,
};

/** "сказал клиент, 12:04" with the mark of where it came from. */
export function FactSource({
  expanded,
  kind,
  onToggle,
  text,
}: {
  /** Set when the source has a quote: the line becomes a toggle. */
  expanded?: boolean;
  kind: FactSourceKind;
  onToggle?: () => void;
  text: string;
}) {
  const content = (
    <>
      {SOURCE_ICON[kind]}
      <span>{text}</span>
    </>
  );

  if (expanded === undefined) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-sm">
        {content}
      </p>
    );
  }

  return (
    <Button
      aria-expanded={expanded}
      className="text-muted-foreground -mx-2 -my-[5px] w-fit gap-1.5 px-2 font-normal"
      onClick={onToggle}
      size="sm"
      variant="ghost"
    >
      {content}
      <ChevronUpIcon
        className={cn("size-3 shrink-0", expanded ? null : "rotate-180")}
      />
    </Button>
  );
}

/** The phrase a fact was taken from, with listen and open actions. */
export function FactQuote({
  initial,
  moment,
  onListen,
  text,
  time,
}: NonNullable<TaskFactData["quote"]> & {
  /** "Послушать": plays the fragment. */
  onListen?: () => void;
}) {
  const links = usePostCallLinks();
  return (
    <div className="flex flex-col gap-1.5">
      <Message>
        <MessageAvatar>
          <AvatarFallback>{initial}</AvatarFallback>
        </MessageAvatar>
        <MessageContent>
          <Bubble className="max-w-[520px]" variant="card">
            {text}
          </Bubble>
        </MessageContent>
      </Message>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 pl-[34px]">
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {time}
        </span>
        <Button
          className="text-foreground -mx-2 -my-[5px] gap-1.5 px-2"
          onClick={onListen}
          size="sm"
          variant="ghost"
        >
          <PlaySmallIcon className="size-3" />
          Послушать
        </Button>
        {links.transcriptDeleted ? (
          <span className="text-muted-foreground text-sm">
            {TRANSCRIPT_DELETED}
          </span>
        ) : (
          <LinkButton
            className="text-foreground -mx-2 -my-[5px] gap-1.5 px-2"
            href={links.transcript(moment ?? time)}
            size="sm"
            variant="ghost"
          >
            <ArrowRightIcon className="size-3" />
            Открыть в расшифровке
          </LinkButton>
        )}
      </div>
    </div>
  );
}

export function TaskFact({
  className,
  expanded = false,
  fact,
  onListen,
  onToggle,
}: {
  className?: string;
  /** Show the quote under the fact. */
  expanded?: boolean;
  fact: TaskFactData;
  onListen?: (fact: TaskFactData) => void;
  /** The source line was clicked: open or close the quote. */
  onToggle?: (factId: string) => void;
}) {
  const isEmpty = fact.status === "empty";
  const toggle = useCallback(() => onToggle?.(fact.id), [fact.id, onToggle]);
  const listen = useCallback(() => onListen?.(fact), [fact, onListen]);

  return (
    <div className={cn("flex flex-col gap-3.5", className)}>
      <div className="flex gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className={cn("text-lg", isEmpty && "text-muted-foreground")}>
            {fact.text}
          </p>
          <FactSource
            expanded={fact.quote ? expanded : undefined}
            kind={fact.source.kind}
            onToggle={onToggle ? toggle : undefined}
            text={fact.source.text}
          />
        </div>
        <div className="flex w-32 shrink-0 justify-end">
          <FactBadge status={fact.status} />
        </div>
      </div>
      {expanded && fact.quote ? (
        <FactQuote {...fact.quote} onListen={onListen ? listen : undefined} />
      ) : null}
    </div>
  );
}

/**
 * One field of a card: 168px label on the left, its facts on the right;
 * the label over the facts on a narrow panel. `highlighted` puts the facts
 * on gray, while a source is open.
 */
export function TaskCardField({
  children,
  className,
  highlighted = false,
  label,
}: {
  children: ReactNode;
  className?: string;
  highlighted?: boolean;
  label: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 px-1 py-[18px] @2xl/panel:flex-row @2xl/panel:gap-6",
        className
      )}
    >
      <dt className="text-muted-foreground shrink-0 text-base leading-6 font-medium @2xl/panel:w-[168px]">
        {label}
      </dt>
      <dd
        className={cn(
          "flex min-w-0 flex-1 flex-col gap-3.5",
          highlighted &&
            "bg-surface -mx-[18px] -mb-[18px] rounded-md px-[18px] pt-4 pb-[18px] @2xl/panel:-mt-4"
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/** Title of a topic card and when it was discussed. */
export function TaskCardHeading({
  actions,
  className,
  id,
  meta,
  title,
}: {
  /** Decisions on the card (app): accept, edit, discard, send. */
  actions?: ReactNode;
  className?: string;
  id: string;
  meta: string;
  title: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 px-1 pt-1", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2
          className="text-2xl font-semibold tracking-tight text-balance"
          id={id}
        >
          {title}
        </h2>
        <p className="text-muted-foreground text-sm">{meta}</p>
      </div>
      {actions}
    </div>
  );
}

const ORIGIN_TONE: Record<NextQuestion["origin"], string> = {
  assumption: "text-assumption",
  contradiction: "text-contradiction",
  empty: "text-muted-foreground",
};

/** A question the agent derived from a gap, for the next call. */
export function NextQuestionCard({
  className,
  question,
}: {
  className?: string;
  question: NextQuestion;
}) {
  return (
    <li
      className={cn(
        "bg-background shadow-card flex flex-col gap-2.5 rounded-md p-4",
        className
      )}
    >
      <p
        className={cn(
          "flex items-center gap-1.5 text-sm",
          ORIGIN_TONE[question.origin]
        )}
      >
        <StatusDot tone={question.origin} />
        {question.label}
      </p>
      <p className="text-base font-medium">{question.question}</p>
    </li>
  );
}
