"use client"

import * as React from "react"
import { cn } from "cn"

import { appearClassName, useAppear } from "./appear"
import { Button, type ButtonProps } from "./button"

/*
 * Paper "05 Вопрос", "История в теме": questions already discussed in the
 * topic, under "Обсудили в этой теме" with a count. Each row has a status
 * mark in a 20px lane, the question, an optional client quote and note, and a
 * time or a "Вернуть" button in an 80px lane on the right.
 *
 * - `answered`: green check, gray question, the quote in ink.
 * - `answered-task`: the same, the note says the answer goes to ClickUp.
 * - `unanswered`: orange ring, the question in ink, accent note, "Вернуть".
 * - `hidden`: hidden by you, gray cross, "Вернуть".
 * - `irrelevant`: dropped by the agent, gray dash, reason and time.
 *
 * Inside an AppearScope a row added later drops 4px into place, the way the
 * question left its list.
 */
type QuestionHistoryStatus =
  | "answered"
  | "answered-task"
  | "unanswered"
  | "hidden"
  | "irrelevant"

function CheckMark() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-4" fill="none">
      <path
        d="M3 7.5L5.8 10L11 4"
        className="stroke-confirmed"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function Ring() {
  return (
    <span
      aria-hidden
      className="size-2.5 rounded-full border-2 border-accent"
    />
  )
}

function Cross() {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3.5" fill="none">
      <path
        d="M4 4L10 10M10 4L4 10"
        className="stroke-subtle"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Dash() {
  return <span aria-hidden className="h-0.5 w-2.5 rounded-full bg-subtle" />
}

const STATUSES: Record<
  QuestionHistoryStatus,
  {
    label: string
    mark: () => React.JSX.Element
    /** Top offset that centers the mark on the first 20px line. */
    markOffset: string
    question: string
    note: string
  }
> = {
  answered: {
    label: "Отвечен",
    mark: CheckMark,
    markOffset: "pt-[3px]",
    question: "text-muted-foreground",
    note: "text-confirmed",
  },
  "answered-task": {
    label: "Отвечен по задаче ClickUp",
    mark: CheckMark,
    markOffset: "pt-[3px]",
    question: "text-muted-foreground",
    note: "text-confirmed",
  },
  unanswered: {
    label: "Спросили без ответа",
    mark: Ring,
    markOffset: "pt-[5px]",
    question: "text-foreground",
    note: "text-accent-ink",
  },
  hidden: {
    label: "Скрыт вами",
    mark: Cross,
    markOffset: "pt-[3px]",
    question: "text-muted-foreground",
    note: "text-muted-foreground",
  },
  irrelevant: {
    label: "Неактуален",
    mark: Dash,
    markOffset: "pt-2.5",
    question: "text-muted-foreground",
    note: "text-muted-foreground",
  },
}

const HistoryContext = React.createContext<{ titleId: string } | null>(null)

const ItemContext = React.createContext<{
  status: QuestionHistoryStatus
  questionId: string
} | null>(null)

function useItem() {
  const context = React.useContext(ItemContext)
  if (!context) {
    throw new Error(
      "QuestionHistoryItem parts must be rendered inside <QuestionHistoryItem>"
    )
  }
  return context
}

function QuestionHistory({ className, ...props }: React.ComponentProps<"div">) {
  const titleId = React.useId()
  const context = React.useMemo(() => ({ titleId }), [titleId])

  return (
    <HistoryContext.Provider value={context}>
      <div
        data-slot="question-history"
        className={cn("flex flex-col pt-2 pb-4", className)}
        {...props}
      />
    </HistoryContext.Provider>
  )
}

type QuestionHistoryHeaderProps = React.ComponentProps<"div"> & {
  /** Questions discussed in the topic, in JetBrains Mono on the right. */
  count?: number
}

/** "Обсудили в этой теме" and the count. Labels the list below. */
function QuestionHistoryHeader({
  className,
  count,
  children,
  ...props
}: QuestionHistoryHeaderProps) {
  const titleId = React.useContext(HistoryContext)?.titleId

  return (
    <div
      data-slot="question-history-header"
      className={cn(
        "flex items-center justify-between gap-4 px-7 pt-2 pb-1",
        className
      )}
      {...props}
    >
      <p id={titleId} className="text-sm font-medium text-muted-foreground">
        {children}
      </p>
      {count === undefined ? null : (
        <span
          data-slot="question-history-count"
          className="font-mono text-xs text-muted-foreground"
        >
          {count}
        </span>
      )}
    </div>
  )
}

function QuestionHistoryList({
  className,
  ...props
}: React.ComponentProps<"ul">) {
  const titleId = React.useContext(HistoryContext)?.titleId

  return (
    <ul
      aria-labelledby={titleId}
      data-slot="question-history-list"
      className={cn("flex flex-col", className)}
      {...props}
    />
  )
}

type QuestionHistoryItemProps = React.ComponentProps<"li"> & {
  status: QuestionHistoryStatus
  /** Read before the question by screen readers. Defaults per status. */
  statusLabel?: string
}

function QuestionHistoryItem({
  className,
  status,
  statusLabel,
  children,
  ...props
}: QuestionHistoryItemProps) {
  const questionId = React.useId()
  const context = React.useMemo(
    () => ({ status, questionId }),
    [status, questionId]
  )
  const { label, mark: Mark, markOffset } = STATUSES[status]
  const entering = useAppear()

  return (
    <ItemContext.Provider value={context}>
      <li
        data-slot="question-history-item"
        data-status={status}
        data-entering={entering ? "" : undefined}
        className={cn(
          "flex gap-3.5 px-7 py-3",
          appearClassName("drop"),
          className
        )}
        {...props}
      >
        <span
          data-slot="question-history-mark"
          className={cn("flex w-5 shrink-0 justify-center", markOffset)}
        >
          <Mark />
          <span className="sr-only">{statusLabel ?? label}: </span>
        </span>
        {children}
      </li>
    </ItemContext.Provider>
  )
}

/** Text column: question, quote, note. */
function QuestionHistoryContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="question-history-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}
      {...props}
    />
  )
}

function QuestionHistoryQuestion({
  className,
  ...props
}: React.ComponentProps<"p">) {
  const { status, questionId } = useItem()

  return (
    <p
      id={questionId}
      data-slot="question-history-question"
      className={cn("text-base", STATUSES[status].question, className)}
      {...props}
    />
  )
}

/** The client's answer, quoted, in ink. */
function QuestionHistoryAnswer({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="question-history-answer"
      className={cn("text-base text-foreground", className)}
      {...props}
    />
  )
}

/** One line under the question, colored by status. */
function QuestionHistoryNote({
  className,
  ...props
}: React.ComponentProps<"p">) {
  const { status } = useItem()

  return (
    <p
      data-slot="question-history-note"
      className={cn("text-sm", STATUSES[status].note, className)}
      {...props}
    />
  )
}

/** Time in the 80px right lane, JetBrains Mono, on the first line. */
function QuestionHistoryTime({
  className,
  ...props
}: React.ComponentProps<"time">) {
  return (
    <time
      data-slot="question-history-time"
      className={cn(
        "w-20 shrink-0 text-right font-mono text-xs leading-5 text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/**
 * "Вернуть" in the 80px right lane. Puts the question back in the open list;
 * the button is described by the question it restores.
 */
function QuestionHistoryRestore({
  className,
  children = "Вернуть",
  ...props
}: ButtonProps) {
  const { questionId } = useItem()

  return (
    <div
      data-slot="question-history-restore"
      className="flex w-20 shrink-0 justify-end"
    >
      <Button
        variant="secondary"
        size="sm"
        aria-describedby={questionId}
        className={className}
        {...props}
      >
        {children}
      </Button>
    </div>
  )
}

export {
  QuestionHistory,
  QuestionHistoryHeader,
  QuestionHistoryList,
  QuestionHistoryItem,
  QuestionHistoryContent,
  QuestionHistoryQuestion,
  QuestionHistoryAnswer,
  QuestionHistoryNote,
  QuestionHistoryTime,
  QuestionHistoryRestore,
}
export type { QuestionHistoryStatus, QuestionHistoryItemProps }
