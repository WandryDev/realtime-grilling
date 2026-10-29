import { cn } from "cn"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemMeta,
  ItemTitle,
  type ItemProps,
} from "@/components/ui/item"
import { RowStatus, formatOpenQuestions } from "@/components/ui/row-status"

/*
 * Paper "08 Строки списков", "Проект": a letter tile, name and last activity,
 * client participants (110px column of 26px avatars), status (110px):
 * "5 открытых" in accent ink, or "бриф устарел" in blue. On hover the status
 * gives way to a white "Открыть" pill. The whole row is one button (or a link
 * via `render`), so the pill is only a visual cue, not a second control.
 */
type ProjectParticipant = {
  name: string
  initials: string
}

type ProjectRowProps = Omit<ItemProps, "title"> & {
  name: string
  /** "Последний звонок сегодня, бриф обновлён вчера". */
  description?: React.ReactNode
  /** Tile letter. Defaults to the first letter of the name. */
  letter?: string
  participants?: ProjectParticipant[]
  /** Open questions across the project's calls. */
  openCount?: number
  /** The brief needs a refresh before the next call; wins over openCount. */
  briefOutdated?: boolean
  /** Text of the hover pill. */
  actionLabel?: string
}

function ProjectStatus({
  briefOutdated,
  openCount,
}: {
  briefOutdated: boolean
  openCount: number | undefined
}) {
  if (briefOutdated) {
    return (
      <RowStatus tone="assumption" dot>
        бриф устарел
      </RowStatus>
    )
  }
  if (!openCount) {
    return null
  }
  return <RowStatus tone="open">{formatOpenQuestions(openCount)}</RowStatus>
}

function ProjectRow({
  className,
  name,
  description,
  letter,
  participants = [],
  openCount,
  briefOutdated = false,
  actionLabel = "Открыть",
  render = <button type="button" />,
  ...props
}: ProjectRowProps) {
  return (
    <Item render={render} className={className} {...props}>
      <ItemMedia aria-hidden variant="tile">
        {letter ?? name.charAt(0).toUpperCase()}
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
      </ItemContent>
      <ItemMeta className="w-[110px] gap-1">
        {participants.map((person) => (
          <Avatar
            aria-hidden
            className="ring-2 ring-background transition-[box-shadow] group-hover/item:ring-muted group-data-selected/item:ring-muted"
            key={person.name}
            size="sm"
          >
            <AvatarFallback>{person.initials}</AvatarFallback>
          </Avatar>
        ))}
        {participants.length > 0 ? (
          <span className="sr-only">
            , участники: {participants.map((person) => person.name).join(", ")}
          </span>
        ) : null}
      </ItemMeta>
      <ItemActions className="w-[110px]">
        {/* Visually swapped for the pill, still read by screen readers */}
        <span className="inline-flex group-hover/item:sr-only group-focus-visible/item:sr-only">
          <ProjectStatus briefOutdated={briefOutdated} openCount={openCount} />
        </span>
        <span
          aria-hidden
          className={cn(
            "hidden h-7 items-center rounded-full bg-background px-3 text-sm font-medium text-foreground",
            "group-hover/item:inline-flex group-focus-visible/item:inline-flex"
          )}
        >
          {actionLabel}
        </span>
      </ItemActions>
    </Item>
  )
}

export { ProjectRow }
export type { ProjectParticipant, ProjectRowProps }
