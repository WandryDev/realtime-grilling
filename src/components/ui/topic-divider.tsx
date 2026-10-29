import * as React from "react"
import { cn } from "cn"

/*
 * Paper "06 Сообщения расшифровки", topic divider: where a new topic starts
 * in the transcript. 13px semibold topic, a strong hairline, start time in
 * JetBrains Mono. The topic being discussed now (`current`) gets a 6px
 * orange dot after its name.
 */
type TopicDividerProps = React.ComponentProps<"div"> & {
  /** Start time of the topic, "12:21". */
  time?: string
  /** `datetime` for the time element, if known. */
  dateTime?: string
  /** The topic being discussed right now. */
  current?: boolean
}

function TopicDivider({
  className,
  time,
  dateTime,
  current = false,
  children,
  ...props
}: TopicDividerProps) {
  return (
    <div
      data-slot="topic-divider"
      data-current={current ? "" : undefined}
      className={cn("flex w-full min-w-0 items-center gap-2.5", className)}
      {...props}
    >
      <span
        data-slot="topic-divider-title"
        className="min-w-0 text-sm font-semibold text-foreground"
      >
        {children}
        {current ? <span className="sr-only">, текущая тема</span> : null}
      </span>
      {current ? (
        <span
          aria-hidden
          data-slot="topic-divider-dot"
          className="size-1.5 shrink-0 rounded-full bg-accent"
        />
      ) : null}
      <span aria-hidden className="h-px min-w-4 flex-1 bg-border-strong" />
      {time ? (
        <time
          data-slot="topic-divider-time"
          dateTime={dateTime}
          className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
        >
          {time}
        </time>
      ) : null}
    </div>
  )
}

export { TopicDivider }
export type { TopicDividerProps }
