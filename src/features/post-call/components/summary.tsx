"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { ClickUpIcon } from "@/components/ui/brand-icons";
import {
  QuestionHistoryAnswer,
  QuestionHistoryContent,
  QuestionHistoryItem,
  QuestionHistoryList,
  QuestionHistoryNote,
  QuestionHistoryQuestion,
  QuestionHistoryTime,
} from "@/components/ui/question-history";
import { cn } from "@/lib/utils";

import { CalendarIcon, ClockIcon, PeopleIcon } from "../icons";
import {
  type ClickUpAnswer,
  SUMMARY_TLDR,
  type SummaryPointData,
  type UnaskedQuestion,
} from "../mock";
import { TRANSCRIPT_DELETED, usePostCallLinks } from "./links";
import { StatusDot } from "./status-mark";

/*
 * "02 Итоги звонка": the meta line under the title, the short summary, what
 * was said per topic, what we did not get to ask and the answers for
 * ClickUp tasks.
 */

export function CallMeta({
  className,
  date,
  duration,
  participants,
}: {
  className?: string;
  date: string;
  duration: string;
  participants: string;
}) {
  return (
    <ul className={cn("flex items-center gap-5 text-base", className)}>
      <li className="flex items-center gap-1.5">
        <CalendarIcon className="text-muted-foreground size-3.5 shrink-0" />
        {date}
      </li>
      <li className="flex items-center gap-1.5">
        <ClockIcon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="sr-only">Длительность </span>
        <span className="font-mono text-sm tabular-nums">{duration}</span>
      </li>
      <li className="flex items-center gap-1.5">
        <PeopleIcon className="text-muted-foreground size-3.5 shrink-0" />
        {participants}
      </li>
    </ul>
  );
}

export function SummaryTldr({
  className,
  tldr = SUMMARY_TLDR,
}: {
  className?: string;
  tldr?: typeof SUMMARY_TLDR;
}) {
  return (
    <section
      aria-labelledby="summary-tldr"
      className={cn(
        "bg-surface flex flex-col gap-3 rounded-md px-8 py-7",
        className
      )}
    >
      <h2
        className="text-muted-foreground text-sm font-medium"
        id="summary-tldr"
      >
        Коротко
      </h2>
      <p className="text-xl leading-[30px] font-medium">{tldr.text}</p>
      {tldr.chips.length > 0 ? (
        <ul className="flex flex-wrap gap-2 pt-1">
          {tldr.chips.map((chip) => (
            <li key={chip.id}>
              <Badge
                className="bg-background text-foreground"
                indicator={false}
              >
                {"accent" in chip ? <StatusDot tone="accent" /> : null}
                {chip.label}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Section of the summary: 20px heading, a count, a note on the right. */
export function SummarySection({
  children,
  className,
  count,
  countTone = "muted",
  divided = false,
  icon,
  id,
  meta,
  title,
}: {
  children: ReactNode;
  className?: string;
  count?: ReactNode;
  countTone?: "muted" | "accent";
  /** Hairline on top, 28px above the heading. */
  divided?: boolean;
  icon?: ReactNode;
  id: string;
  meta?: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "flex flex-col gap-2",
        divided && "border-border border-t pt-7",
        className
      )}
    >
      <header
        className={cn(
          "flex justify-between gap-4 px-1 pb-1",
          icon ? "items-center" : "items-baseline"
        )}
      >
        <div
          className={cn(
            "flex gap-2.5",
            icon ? "items-center" : "items-baseline"
          )}
        >
          {icon}
          <h2 className="text-xl font-semibold text-balance" id={id}>
            {title}
          </h2>
          {count === undefined ? null : (
            <span
              className={cn(
                "font-mono text-sm tabular-nums",
                countTone === "accent"
                  ? "text-accent-ink"
                  : "text-muted-foreground"
              )}
            >
              {count}
            </span>
          )}
        </div>
        {meta ? (
          <p className="text-muted-foreground text-sm tabular-nums">{meta}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

const POINT_TONE = {
  assumption: { dot: "bg-assumption", note: "text-assumption" },
  contradiction: { dot: "bg-contradiction", note: "text-contradiction" },
} as const;

/**
 * Clickable time code: opens the transcript at that moment; plain text
 * once the retention period deleted the transcript.
 */
export function TimeLink({
  className,
  moment,
  time,
}: {
  className?: string;
  /** The `?moment=` of the link; the time code itself when absent. */
  moment?: string;
  time: string;
}) {
  const { Link, transcript, transcriptDeleted } = usePostCallLinks();
  if (transcriptDeleted) {
    return (
      <span
        className={cn(
          "text-muted-foreground w-14 shrink-0 text-right font-mono text-xs leading-6 tabular-nums",
          className
        )}
        title={TRANSCRIPT_DELETED}
      >
        {time}
      </span>
    );
  }
  return (
    <Link
      aria-label={`Открыть расшифровку на ${time}`}
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:focus-ring w-14 shrink-0 rounded-xs text-right font-mono text-xs leading-6 tabular-nums",
        className
      )}
      href={transcript(moment ?? time)}
    >
      {time}
    </Link>
  );
}

export function SummaryPoints({
  className,
  points,
}: {
  className?: string;
  points: SummaryPointData[];
}) {
  return (
    <ul className={cn("flex flex-col gap-2", className)}>
      {points.map((point) => {
        const tone = point.status ? POINT_TONE[point.status] : null;
        return (
          <li className="flex gap-3.5 px-1 py-2" key={point.id}>
            <span className="flex w-5 shrink-0 justify-center pt-2">
              <span
                aria-hidden="true"
                className={cn(
                  "size-[5px] rounded-full",
                  tone?.dot ?? "bg-foreground"
                )}
              />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-lg">{point.text}</p>
              {point.note ? (
                <p className={cn("text-base", tone?.note)}>{point.note}</p>
              ) : null}
            </div>
            <TimeLink moment={point.moment} time={point.time} />
          </li>
        );
      })}
    </ul>
  );
}

/* QuestionHistory rows retuned to the summary's 16px questions */
const SUMMARY_QUESTION_ITEM =
  "gap-3.5 px-1 [&>[data-slot=question-history-mark]]:pt-[7px]";

export function UnaskedQuestions({
  className,
  questions,
}: {
  className?: string;
  questions: UnaskedQuestion[];
}) {
  return (
    <QuestionHistoryList aria-label="Не успели спросить" className={className}>
      {questions.map((item) => (
        <QuestionHistoryItem
          className={SUMMARY_QUESTION_ITEM}
          key={item.id}
          status="unanswered"
          statusLabel="Не успели спросить"
        >
          <QuestionHistoryContent className="gap-0.5">
            <QuestionHistoryQuestion className="text-lg font-medium">
              {item.question}
            </QuestionHistoryQuestion>
            <QuestionHistoryNote className="text-muted-foreground text-base">
              {item.note}
            </QuestionHistoryNote>
          </QuestionHistoryContent>
          <span aria-hidden="true" className="w-14 shrink-0" />
        </QuestionHistoryItem>
      ))}
    </QuestionHistoryList>
  );
}

export function ClickUpTile({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-surface flex size-7 shrink-0 items-center justify-center rounded-xs",
        className
      )}
    >
      <ClickUpIcon className="size-4" />
    </span>
  );
}

export function ClickUpAnswers({
  answers,
  className,
}: {
  answers: ClickUpAnswer[];
  className?: string;
}) {
  return (
    <QuestionHistoryList
      aria-label="Ответы для ClickUp"
      className={cn("gap-1", className)}
    >
      {answers.map((item) => (
        <QuestionHistoryItem
          className={cn(
            "gap-3.5 px-1 py-3.5",
            item.answer
              ? "[&>[data-slot=question-history-mark]]:pt-1"
              : "[&>[data-slot=question-history-mark]]:pt-[5px]"
          )}
          key={item.id}
          status={item.answer ? "answered-task" : "unanswered"}
        >
          <QuestionHistoryContent className="gap-1.5">
            <a
              className="group/task focus-visible:focus-ring flex w-fit items-center gap-2 rounded-xs"
              href={`https://app.clickup.com/t/${item.taskId}`}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="text-muted-foreground font-mono text-xs">
                {item.taskId}
              </span>
              <span className="text-base font-medium underline-offset-2 group-hover/task:underline">
                {item.title}
              </span>
            </a>
            <QuestionHistoryQuestion className="text-muted-foreground">
              {item.question}
            </QuestionHistoryQuestion>
            {item.answer ? (
              <QuestionHistoryAnswer className="flex gap-2.5 text-lg">
                <span
                  aria-hidden="true"
                  className="bg-border-strong w-0.5 shrink-0 rounded-full"
                />
                {item.answer}
              </QuestionHistoryAnswer>
            ) : (
              <QuestionHistoryNote className="text-base">
                {item.missedNote}
              </QuestionHistoryNote>
            )}
          </QuestionHistoryContent>
          {item.time ? (
            <QuestionHistoryTime className="w-14">
              {item.time}
            </QuestionHistoryTime>
          ) : (
            <span aria-hidden="true" className="w-14 shrink-0" />
          )}
        </QuestionHistoryItem>
      ))}
    </QuestionHistoryList>
  );
}
