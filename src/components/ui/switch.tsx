"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

/*
 * Paper "03 Выбор": 36x22 track with an 18px thumb. Off is the strong border
 * gray, on is ink. Reads hover and focus from a surrounding ChoiceField row.
 * `sm` is not in the design, it is kept for shadcn compatibility.
 */
function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full p-0.5 transition-colors outline-none after:absolute after:-inset-x-3 after:-inset-y-2 data-[size=default]:h-[22px] data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7",
        "data-unchecked:bg-border-strong data-unchecked:not-data-disabled:hover:bg-toggle-hover data-unchecked:not-data-disabled:group-hover/choice:bg-toggle-hover",
        "data-checked:bg-foreground data-checked:not-data-disabled:hover:bg-ink-hover data-checked:not-data-disabled:group-hover/choice:bg-ink-hover",
        "focus-visible:focus-ring group-focus-visible/choice:focus-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-40",
        "aria-invalid:ring-2 aria-invalid:ring-destructive",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-background shadow-[0_1px_2px_rgb(17_17_17/20%)] transition-transform group-data-[size=default]/switch:size-[18px] group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:data-checked:translate-x-3.5 group-data-[size=sm]/switch:data-checked:translate-x-3 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
