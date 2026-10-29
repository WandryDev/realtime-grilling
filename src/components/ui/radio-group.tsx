"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"
import { cn } from "cn"

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid w-full gap-3", className)}
      {...props}
    />
  )
}

/*
 * Paper "03 Выбор": 18px circle with a 1.5px border, checked is ink with a
 * 6px paper dot. Reads hover and focus from a surrounding ChoiceField row.
 */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "peer relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] border-subtle bg-background transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2",
        "data-unchecked:not-data-disabled:hover:border-muted-foreground data-unchecked:not-data-disabled:hover:bg-surface data-unchecked:not-data-disabled:group-hover/choice:border-muted-foreground data-unchecked:not-data-disabled:group-hover/choice:bg-surface",
        "data-checked:border-foreground data-checked:bg-foreground data-checked:not-data-disabled:hover:border-ink-hover data-checked:not-data-disabled:hover:bg-ink-hover data-checked:not-data-disabled:group-hover/choice:border-ink-hover data-checked:not-data-disabled:group-hover/choice:bg-ink-hover",
        "focus-visible:focus-ring group-focus-visible/choice:focus-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-40 data-disabled:data-unchecked:border-border-strong data-disabled:data-unchecked:bg-surface",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="size-1.5 rounded-full bg-background"
      />
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem }
