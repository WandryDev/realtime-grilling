import { cn } from "cn"

import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMeta,
  ItemTitle,
  type ItemProps,
} from "@/components/ui/item"
import { RecordingIndicator } from "@/components/ui/recording-indicator"
import { RowStatus, formatOpenQuestions } from "@/components/ui/row-status"

/*
 * Paper "08 Строки списков", "Звонок в истории". The whole row is one button
 * (pass `render={<a href="…" />}` for a link). Columns: date and mono time
 * (64px), client and topics, duration (110px, mono; a red dot and ink time
 * while live), status (110px, right-aligned):
 * - live: "идёт сейчас"
 * - openCount > 0: "3 открытых" in accent ink
 * - openCount 0: "всё закрыто" in green
 * Hover is the gray fill; `selected` adds the black bar and aria-current.
 */
type CallRowProps = Omit<ItemProps, "title"> & {
  /** "Сегодня", "Вчера", "15 окт". */
  date: React.ReactNode
  /** Start time, "12:00". */
  time: string
  /** Client or project name. */
  title: React.ReactNode
  /** Topics discussed. */
  topics?: React.ReactNode
  /** Call length "38:12", or elapsed time while live. */
  duration: string
  /** The call is happening now. */
  live?: boolean
  /** Questions left open after the call. */
  openCount?: number
}

function CallStatus({
  live,
  openCount,
}: {
  live: boolean
  openCount: number | undefined
}) {
  if (live) {
    return <RowStatus>идёт сейчас</RowStatus>
  }
  if (openCount === undefined) {
    return null
  }
  if (openCount === 0) {
    return <RowStatus tone="confirmed">всё закрыто</RowStatus>
  }
  return <RowStatus tone="open">{formatOpenQuestions(openCount)}</RowStatus>
}

function CallRow({
  className,
  date,
  time,
  title,
  topics,
  duration,
  live = false,
  openCount,
  selected = false,
  render = <button type="button" />,
  ...props
}: CallRowProps) {
  return (
    <Item
      render={render}
      selected={selected}
      aria-current={selected ? "true" : undefined}
      data-live={live ? "" : undefined}
      className={cn("gap-4", className)}
      {...props}
    >
      <span className="flex w-16 shrink-0 flex-col">
        <span className="text-sm text-foreground">{date}</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {time}
        </span>
      </span>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        {topics ? <ItemDescription>{topics}</ItemDescription> : null}
      </ItemContent>
      <ItemMeta className="w-[110px] gap-2">
        {live ? (
          <RecordingIndicator variant="inline" time={duration} />
        ) : (
          <>
            <span aria-hidden className="size-2 shrink-0" />
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {duration}
            </span>
          </>
        )}
      </ItemMeta>
      <ItemActions className="w-[110px]">
        <CallStatus live={live} openCount={openCount} />
      </ItemActions>
    </Item>
  )
}

export { CallRow }
export type { CallRowProps }
