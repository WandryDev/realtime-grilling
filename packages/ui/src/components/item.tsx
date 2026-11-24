import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Separator } from "./separator"

/*
 * Paper "08 Строки списков": the base every list row is built on (calls,
 * projects, people, integrations, environment checks).
 *
 * A row is media, content and fixed-width trailing slots (ItemMeta,
 * ItemActions), so status and action columns line up across rows even when a
 * slot is empty. Two kinds of rows:
 * - default: 12px radius, gray on hover. Selected adds the gray fill and a
 *   2px black bar on the left (`selected`). Render it as a link or button with
 *   `render` when the whole row is clickable.
 * - divided: hairline under each row, no hover, for dense lists. Drop the
 *   line on the last row with `border-b-0`.
 * - plain: no line, no hover, no vertical padding: the list spaces the rows
 *   with its gap (integrations, documents, people).
 * Inside a gray row, gray parts (tiles, avatars) turn white.
 */
const itemVariants = cva(
  "group/item relative flex w-full items-center gap-3.5 px-4 text-left text-foreground outline-none transition-colors",
  {
    variants: {
      variant: {
        default:
          "rounded-sm py-3 hover:bg-muted focus-visible:focus-ring data-selected:bg-muted data-selected:before:absolute data-selected:before:inset-y-3 data-selected:before:left-0 data-selected:before:w-0.5 data-selected:before:rounded-full data-selected:before:bg-foreground",
        divided: "border-b border-border py-3.5",
        plain: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

type ItemProps = useRender.ComponentProps<"div"> &
  VariantProps<typeof itemVariants> & {
    /** Gray fill and a black bar on the left. Set aria-current/aria-selected yourself. */
    selected?: boolean
  }

function Item({
  className,
  variant = "default",
  selected = false,
  render,
  ...props
}: ItemProps) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "item",
      variant,
      selected,
    },
    // shadcn's data-selected variant matches "true", not an empty attribute
    stateAttributesMapping: {
      selected: (value) => (value ? { "data-selected": "true" } : null),
    },
  })
}

/** Rows of the default kind sit 4px apart; divided rows touch. */
function ItemGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-group"
      className={cn("flex w-full flex-col gap-1", className)}
      {...props}
    />
  )
}

function ItemSeparator({
  className,
  ...props
}: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-slot="item-separator"
      orientation="horizontal"
      className={cn("my-1", className)}
      {...props}
    />
  )
}

/*
 * Leading slot. `tile`: 32px gray square with radius 8 for a logo or a letter
 * (white inside a hovered or selected row). `icon`: 24px slot for a status
 * mark. `default`: no box, for avatars.
 */
const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "",
        tile: "size-8 rounded-xs bg-muted text-sm font-semibold text-foreground transition-colors group-data-selected/item:bg-background group-data-[variant=default]/item:group-hover/item:bg-background [&>svg]:size-[18px]",
        icon: "size-6",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <span
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  )
}

// Content parts are spans so a whole row can be a <button> or <a>.
function ItemContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-content"
      className={cn("flex min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  )
}

function ItemTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-title"
      className={cn(
        "truncate text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function ItemDescription({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-description"
      className={cn("truncate text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Fixed-width column between the content and the action: status, time, people. */
function ItemMeta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-meta"
      className={cn("flex shrink-0 items-center gap-1.5", className)}
      {...props}
    />
  )
}

/** Trailing column, right-aligned. Give it a width so actions line up. */
function ItemActions({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="item-actions"
      className={cn(
        "flex shrink-0 items-center justify-end gap-2",
        className
      )}
      {...props}
    />
  )
}

function ItemHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-header"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className
      )}
      {...props}
    />
  )
}

function ItemFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-footer"
      className={cn(
        "flex basis-full items-center justify-between gap-2",
        className
      )}
      {...props}
    />
  )
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemMeta,
  ItemSeparator,
  ItemTitle,
  ItemDescription,
  ItemHeader,
  ItemFooter,
  itemVariants,
}
export type { ItemProps }
