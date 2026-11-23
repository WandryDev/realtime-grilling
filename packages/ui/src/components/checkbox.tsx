"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"

/*
 * Paper "03 Выбор": 18px box, radius 6, 1.5px border. Checked is ink, never
 * orange. Hover and focus also apply when the surrounding ChoiceField row is
 * hovered or pinned with data-preview, so the whole row reads as one target.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative inline-flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border-[1.5px] border-subtle bg-background text-primary-foreground transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2",
        "data-unchecked:not-data-disabled:hover:border-muted-foreground data-unchecked:not-data-disabled:hover:bg-surface data-unchecked:not-data-disabled:group-hover/choice:border-muted-foreground data-unchecked:not-data-disabled:group-hover/choice:bg-surface",
        "data-checked:border-foreground data-checked:bg-foreground data-checked:not-data-disabled:hover:border-ink-hover data-checked:not-data-disabled:hover:bg-ink-hover data-checked:not-data-disabled:group-hover/choice:border-ink-hover data-checked:not-data-disabled:group-hover/choice:bg-ink-hover",
        "data-indeterminate:border-foreground data-indeterminate:bg-foreground",
        "focus-visible:focus-ring group-focus-visible/choice:focus-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-40 data-disabled:data-unchecked:border-border-strong data-disabled:data-unchecked:bg-surface",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="group/checkbox-indicator grid place-content-center"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 14 14"
          className="size-3 group-data-indeterminate/checkbox-indicator:hidden"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 7.5L5.8 10L11 4" />
        </svg>
        <svg
          aria-hidden="true"
          viewBox="0 0 14 14"
          className="hidden size-3 group-data-indeterminate/checkbox-indicator:block"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <path d="M3.5 7H10.5" />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
