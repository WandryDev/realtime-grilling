import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Button } from "@/components/ui/button"

/*
 * Paper "06 Сообщения расшифровки", system messages: centered on the column,
 * no bubble, 13px muted text with a 14px icon or a 6px dot. An action is a
 * ghost button whose label lines up with the text (MarkerAction).
 *
 *   <Marker>
 *     <MarkerIcon><ClockIcon /></MarkerIcon>
 *     <MarkerContent>Агент не ответил за 20 с</MarkerContent>
 *     <MarkerAction>Повторить</MarkerAction>
 *   </Marker>
 *
 * `tone="destructive"` turns text and dot red (no client audio).
 * `variant="separator"` is a break in the log between two hairlines
 * ("пауза в записи 12:32–12:34").
 */
const markerVariants = cva(
  "group/marker flex w-full min-w-0 items-center justify-center gap-2 text-center text-sm [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: "",
        separator:
          "gap-2.5 before:h-px before:min-w-0 before:flex-1 before:bg-border after:h-px after:min-w-0 after:flex-1 after:bg-border",
      },
      tone: {
        muted: "text-muted-foreground",
        destructive: "text-contradiction",
      },
    },
    defaultVariants: {
      variant: "default",
      tone: "muted",
    },
  }
)

function Marker({
  className,
  variant = "default",
  tone = "muted",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof markerVariants>) {
  return (
    <div
      data-slot="marker"
      data-variant={variant}
      className={cn(markerVariants({ variant, tone }), className)}
      {...props}
    />
  )
}

/** A 14px icon slot; the icon takes the text color. */
function MarkerIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="marker-icon"
      className={cn("flex shrink-0 items-center", className)}
      {...props}
    />
  )
}

/** A 6px dot in the text color, for alerts like "Нет звука клиента". */
function MarkerDot({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      aria-hidden
      data-slot="marker-dot"
      className={cn("size-1.5 shrink-0 rounded-full bg-current", className)}
      {...props}
    />
  )
}

function MarkerContent({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-content"
      className={cn("min-w-0 wrap-break-word", className)}
      {...props}
    />
  )
}

/** Time and durations inside a marker, in JetBrains Mono: "40 с". */
function MarkerTime({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="marker-time"
      className={cn("font-mono text-xs tabular-nums", className)}
      {...props}
    />
  )
}

/**
 * Ghost 28px button in ink. Negative margins keep the row 18px tall and the
 * label 8px after the text, as in the design.
 */
function MarkerAction({
  className,
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      data-slot="marker-action"
      variant="ghost"
      size="sm"
      className={cn("-mx-2.5 -my-[5px] text-foreground", className)}
      {...props}
    />
  )
}

export {
  Marker,
  MarkerAction,
  MarkerContent,
  MarkerDot,
  MarkerIcon,
  MarkerTime,
  markerVariants,
}
