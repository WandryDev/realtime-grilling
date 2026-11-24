import * as React from "react"
import { cn } from "cn"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "./item"
import { Progress } from "./progress"
import { RowStatus } from "./row-status"
import { Spinner } from "./spinner"

/*
 * Paper "08 Строки списков", "Шаг проверки окружения": a 24px status mark,
 * title (optionally with a brand mark) and detail, and a 150px right column.
 * Rows are divided by a hairline.
 * - done: green check on soft green, "готово" in green
 * - missing: dashed gray circle, an action ("Войти")
 * - fixing: spinner, 4px orange progress bar (320px) under the detail and the
 *   percent in mono on the right
 * - error: red "!" on soft red, the reason in red, an action
 *   ("Открыть настройки")
 */
type SetupStepStatus = "done" | "missing" | "fixing" | "error"

// Spoken status for marks that have no visible text next to them
const STATUS_LABEL: Record<SetupStepStatus, string> = {
  done: "готово",
  missing: "не хватает",
  fixing: "исправляем",
  error: "ошибка",
}

function SetupStepMark({ status }: { status: SetupStepStatus }) {
  switch (status) {
    case "done":
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-confirmed-soft text-confirmed">
          <svg
            aria-hidden
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="size-3"
          >
            <path d="M3 7.5L5.8 10L11 4" />
          </svg>
        </span>
      )
    case "missing":
      return (
        <span
          aria-hidden
          className="size-[18px] rounded-full border-[1.5px] border-dashed border-border-strong"
        />
      )
    case "fixing":
      return (
        <Spinner
          aria-hidden
          aria-label={undefined}
          role={undefined}
          className="size-[18px] text-foreground"
        />
      )
    case "error":
      return (
        <span className="flex size-6 items-center justify-center rounded-full bg-contradiction-soft text-contradiction">
          <svg
            aria-hidden
            viewBox="0 0 12 12"
            fill="none"
            className="size-3"
          >
            <path
              d="M6 3V6.5"
              stroke="currentColor"
              strokeWidth={1.6}
              strokeLinecap="round"
            />
            <circle cx="6" cy="9" r="0.9" fill="currentColor" />
          </svg>
        </span>
      )
    default:
      return null
  }
}

type SetupStepProps = Omit<React.ComponentProps<"div">, "title"> & {
  status: SetupStepStatus
  title: React.ReactNode
  /** Brand mark before the title, 14px. */
  icon?: React.ReactNode
  /** Path and version, what we'll do, or why it failed. */
  description?: React.ReactNode
  /** Button for the right column, shown when missing or failed. */
  action?: React.ReactNode
  /** Percent done while fixing, 0–100. */
  progress?: number
}

function SetupStep({
  className,
  status,
  title,
  icon,
  description,
  action,
  progress,
  ...props
}: SetupStepProps) {
  const titleId = React.useId()
  const showProgress = status === "fixing" && progress !== undefined

  return (
    <Item
      variant="divided"
      data-status={status}
      className={className}
      {...props}
    >
      <ItemMedia variant="icon">
        <SetupStepMark status={status} />
        {status === "done" ? null : (
          <span className="sr-only">{STATUS_LABEL[status]}</span>
        )}
      </ItemMedia>
      <ItemContent className={cn(showProgress && "gap-2")}>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            {icon ? (
              <span
                aria-hidden
                className="flex shrink-0 [&>svg]:size-3.5"
              >
                {icon}
              </span>
            ) : null}
            <ItemTitle id={titleId}>{title}</ItemTitle>
          </span>
          {description ? (
            <ItemDescription
              className={cn(
                "tabular-nums",
                status === "error" && "text-contradiction"
              )}
            >
              {description}
            </ItemDescription>
          ) : null}
        </span>
        {showProgress ? (
          <Progress
            aria-labelledby={titleId}
            className="w-80 max-w-full"
            size="sm"
            tone="active"
            value={progress}
          />
        ) : null}
      </ItemContent>
      <ItemActions className="w-[150px]">
        {status === "done" ? (
          <RowStatus tone="confirmed">{STATUS_LABEL.done}</RowStatus>
        ) : null}
        {showProgress ? (
          <span
            aria-hidden
            className="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {Math.round(progress)}%
          </span>
        ) : null}
        {status === "missing" || status === "error" ? action : null}
      </ItemActions>
    </Item>
  )
}

export { SetupStep }
export type { SetupStepProps, SetupStepStatus }
