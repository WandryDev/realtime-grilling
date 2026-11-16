"use client"

import * as React from "react"
import { cn } from "cn"

/*
 * Paper "03 Выбор", "В контексте настроек": title and description on the
 * left, the control on the right. Rows are grouped by space, no lines. The
 * row is a group labelled by its title and described by its description.
 */
const SettingRowContext = React.createContext<{
  titleId: string
  descriptionId: string
} | null>(null)

function useSettingRowIds() {
  const context = React.useContext(SettingRowContext)
  if (!context) {
    throw new Error("SettingRow parts must be rendered inside <SettingRow>")
  }
  return context
}

/** Stack of rows, 28px apart. */
function SettingList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-list"
      className={cn("flex flex-col gap-7", className)}
      {...props}
    />
  )
}

function SettingRow({ className, ...props }: React.ComponentProps<"div">) {
  const id = React.useId()
  const ids = React.useMemo(
    () => ({ titleId: `${id}-title`, descriptionId: `${id}-description` }),
    [id]
  )

  return (
    <SettingRowContext.Provider value={ids}>
      <div
        role="group"
        aria-labelledby={ids.titleId}
        aria-describedby={ids.descriptionId}
        data-slot="setting-row"
        className={cn(
          "flex items-center gap-4",
          className
        )}
        {...props}
      />
    </SettingRowContext.Provider>
  )
}

function SettingRowContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-row-content"
      className={cn("flex min-w-0 flex-1 flex-col gap-0.5", className)}
      {...props}
    />
  )
}

/**
 * Pass `htmlFor` with the control's `id` so clicking the title toggles a
 * switch or checkbox.
 */
function SettingRowTitle({
  className,
  ...props
}: React.ComponentProps<"label">) {
  const { titleId } = useSettingRowIds()

  return (
    <label
      id={titleId}
      data-slot="setting-row-title"
      className={cn("text-base font-medium text-foreground", className)}
      {...props}
    />
  )
}

function SettingRowDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  const { descriptionId } = useSettingRowIds()

  return (
    <p
      id={descriptionId}
      data-slot="setting-row-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function SettingRowControl({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="setting-row-control"
      className={cn("flex shrink-0 items-center", className)}
      {...props}
    />
  )
}

export {
  SettingList,
  SettingRow,
  SettingRowContent,
  SettingRowTitle,
  SettingRowDescription,
  SettingRowControl,
}
