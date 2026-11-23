"use client"

import * as React from "react"
import { PlusIcon, XIcon } from "lucide-react"
import { cn } from "cn"

import { Avatar, AvatarFallback } from "./avatar"

/*
 * Paper "08 Строки списков", "Человек клиента", chips: a 32px gray pill with
 * a white 26px avatar and the name (13/500).
 *
 * Put a PersonChipRemove inside to make the chip removable. The × stays
 * collapsed until the chip is hovered or the button gets keyboard focus; the
 * chip then turns hairline-gray and tightens its right padding around the
 * 24px button. Its accessible name is "Убрать <name>".
 *
 * PersonChipAdd is the outlined "+ Добавить" pill that opens the picker.
 */
const PersonChipContext = React.createContext<{ nameId: string } | null>(null)

type PersonChipProps = React.ComponentProps<"div"> & {
  name: string
  initials: string
}

function PersonChip({
  className,
  name,
  initials,
  children,
  ...props
}: PersonChipProps) {
  const nameId = React.useId()
  const context = React.useMemo(() => ({ nameId }), [nameId])

  return (
    <PersonChipContext.Provider value={context}>
      <div
        data-slot="person-chip"
        className={cn(
          "group/chip inline-flex h-8 w-fit shrink-0 items-center gap-2 rounded-full bg-muted pr-3 pl-1 transition-colors",
          "has-data-[slot=person-chip-remove]:hover:bg-border has-data-[slot=person-chip-remove]:hover:pr-0.5",
          "has-data-[slot=person-chip-remove]:focus-within:bg-border has-data-[slot=person-chip-remove]:focus-within:pr-0.5",
          className
        )}
        {...props}
      >
        <Avatar aria-hidden size="sm">
          <AvatarFallback className="bg-background">{initials}</AvatarFallback>
        </Avatar>
        <span
          id={nameId}
          data-slot="person-chip-name"
          className="text-sm font-medium whitespace-nowrap text-foreground"
        >
          {name}
        </span>
        {children}
      </div>
    </PersonChipContext.Provider>
  )
}

function PersonChipRemove({
  className,
  type = "button",
  ...props
}: Omit<React.ComponentProps<"button">, "children">) {
  const context = React.useContext(PersonChipContext)
  const labelId = React.useId()
  if (!context) {
    throw new Error("PersonChipRemove must be rendered inside <PersonChip>")
  }

  return (
    <button
      data-slot="person-chip-remove"
      type={type}
      aria-labelledby={`${labelId} ${context.nameId}`}
      className={cn(
        // Collapsed: no width, and -8px cancels the gap so the chip keeps 12px
        "-ml-2 flex h-6 w-0 shrink-0 items-center justify-center overflow-hidden rounded-full text-muted-foreground opacity-0 transition-colors outline-none",
        "group-hover/chip:-ml-1.5 group-hover/chip:w-6 group-hover/chip:opacity-100",
        "group-focus-within/chip:-ml-1.5 group-focus-within/chip:w-6 group-focus-within/chip:opacity-100",
        "hover:bg-border-strong hover:text-foreground focus-visible:focus-ring",
        className
      )}
      {...props}
    >
      <span id={labelId} className="sr-only">
        Убрать
      </span>
      <XIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
    </button>
  )
}

function PersonChipAdd({
  className,
  type = "button",
  children = "Добавить",
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      data-slot="person-chip-add"
      type={type}
      className={cn(
        "inline-flex h-8 w-fit shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium whitespace-nowrap text-muted-foreground inset-ring inset-ring-border-strong transition-colors outline-none select-none",
        "hover:bg-muted hover:text-foreground active:bg-border focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-40",
        className
      )}
      {...props}
    >
      <PlusIcon aria-hidden className="size-3 shrink-0" strokeWidth={2} />
      {children}
    </button>
  )
}

export { PersonChip, PersonChipAdd, PersonChipRemove }
export type { PersonChipProps }
