"use client"

import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { cn } from "cn"

type SegmentedControlProps = Omit<
  ToggleGroupPrimitive.Props,
  "value" | "defaultValue" | "onValueChange" | "multiple"
> & {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
}

/*
 * Paper "03 Выбор", "Сегменты": a gray track with the selected segment in
 * white. Exactly one segment is always selected: clicking the selected one
 * does nothing. Arrow keys move between segments.
 */
function SegmentedControl({
  className,
  value,
  defaultValue,
  onValueChange,
  ...props
}: SegmentedControlProps) {
  const [uncontrolledValue, setUncontrolledValue] =
    React.useState(defaultValue)
  const isControlled = value !== undefined
  const currentValue = isControlled ? value : uncontrolledValue

  return (
    <ToggleGroupPrimitive
      data-slot="segmented-control"
      value={currentValue === undefined ? [] : [currentValue]}
      onValueChange={(groupValue) => {
        const [nextValue] = groupValue
        if (nextValue === undefined) {
          return
        }
        if (!isControlled) {
          setUncontrolledValue(nextValue)
        }
        onValueChange?.(nextValue)
      }}
      className={cn(
        "group/segmented-control inline-flex w-fit items-center rounded-full bg-surface p-[3px] data-disabled:opacity-40",
        className
      )}
      {...props}
    />
  )
}

function SegmentedControlItem({ className, ...props }: TogglePrimitive.Props) {
  return (
    <TogglePrimitive
      data-slot="segmented-control-item"
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none select-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        "not-data-pressed:not-data-disabled:hover:bg-border not-data-pressed:not-data-disabled:hover:text-foreground",
        "data-pressed:bg-background data-pressed:text-foreground data-pressed:shadow-touch",
        "focus-visible:ring-2 focus-visible:ring-ring",
        "data-disabled:cursor-not-allowed group-not-data-disabled/segmented-control:data-disabled:opacity-40",
        className
      )}
      {...props}
    />
  )
}

export { SegmentedControl, SegmentedControlItem, type SegmentedControlProps }
