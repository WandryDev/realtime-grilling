import { Avatar, AvatarFallback } from "./avatar"
import { Badge } from "./badge"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  type ItemProps,
} from "./item"
import { RowStatus } from "./row-status"

/*
 * Paper "08 Строки списков", "Человек клиента", profile rows: a 36px avatar,
 * name and role, and on the right either the person's tags ("без жаргона")
 * or, after a call, the orange "предложено обновить профиль". The whole row
 * is one button (or a link via `render`) that opens the profile.
 */
type ProfileRowProps = Omit<ItemProps, "title"> & {
  name: React.ReactNode
  initials: string
  /** Role and how to talk to them. */
  description?: React.ReactNode
  /** How to talk to the person: "без жаргона". */
  tags?: string[]
  /** The agent suggests updating the profile after a call; hides the tags. */
  updateSuggested?: boolean
}

function ProfileRow({
  className,
  name,
  initials,
  description,
  tags = [],
  updateSuggested = false,
  render = <button type="button" />,
  ...props
}: ProfileRowProps) {
  return (
    <Item render={render} className={className} {...props}>
      <ItemMedia aria-hidden>
        <Avatar size="lg">
          <AvatarFallback className="transition-colors group-hover/item:bg-background group-data-selected/item:bg-background">
            {initials}
          </AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{name}</ItemTitle>
        {description ? <ItemDescription>{description}</ItemDescription> : null}
      </ItemContent>
      <ItemActions className="gap-1.5">
        {updateSuggested ? (
          <RowStatus tone="suggestion" dot>
            предложено обновить профиль
          </RowStatus>
        ) : (
          tags.map((tag) => (
            <Badge
              className="transition-colors group-hover/item:bg-background group-data-selected/item:bg-background"
              key={tag}
              size="sm"
              variant="neutral"
            >
              {tag}
            </Badge>
          ))
        )}
      </ItemActions>
    </Item>
  )
}

export { ProfileRow }
export type { ProfileRowProps }
