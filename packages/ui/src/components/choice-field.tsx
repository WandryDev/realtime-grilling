import * as React from "react"
import { cn } from "cn"

/*
 * Paper "03 Выбор": a checkbox, radio or switch with its label. The whole
 * row is a <label>, so clicking the text toggles the control. The control
 * reads hover and focus from this row (`group/choice`), so
 * <ChoiceField data-preview="hover"> pins the hover look in /dev.
 */
function ChoiceField({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      data-slot="choice-field"
      className={cn(
        "group/choice flex cursor-pointer items-center gap-2.5 text-base text-foreground select-none has-data-disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  )
}

/** Main text of the row. Fades with the control when it is disabled. */
function ChoiceFieldLabel({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="choice-field-label"
      className={cn(
        "min-w-0 flex-1 group-has-data-disabled/choice:opacity-40",
        className
      )}
      {...props}
    />
  )
}

/** Secondary text on the right, e.g. a role in the "Кто на звонке" list. */
function ChoiceFieldMeta({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="choice-field-meta"
      className={cn(
        "shrink-0 text-sm text-muted-foreground group-has-data-disabled/choice:opacity-40",
        className
      )}
      {...props}
    />
  )
}

export { ChoiceField, ChoiceFieldLabel, ChoiceFieldMeta }
