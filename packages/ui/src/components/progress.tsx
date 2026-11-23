"use client"

import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { cva, type VariantProps } from "class-variance-authority"
import { CheckIcon } from "lucide-react"
import { cn } from "cn"

/*
 * Paper "09 Обратная связь", "Загрузка и прогресс": a title (14/500) with the
 * percent in JetBrains Mono on the right, a 6px bar on the surface track and a
 * muted caption row underneath. Tone:
 * - active: orange bar
 * - paused: gray bar, muted percent (the consumer shows the red reason and
 *   the "Повторить" action in ProgressCaption)
 * - done: green bar and "✓ 100%"
 * Without `tone`, a full bar is `done` and anything else is `active`.
 * `size="sm"` is the 4px bar from the environment check rows in "08".
 */
const progressTrackVariants = cva(
  "relative flex w-full items-center overflow-hidden rounded-full bg-surface",
  {
    variants: {
      size: {
        default: "h-1.5",
        sm: "h-1",
      },
    },
    defaultVariants: {
      size: "default",
    },
  }
)

type ProgressTone = "active" | "paused" | "done"

type ProgressProps = ProgressPrimitive.Root.Props &
  VariantProps<typeof progressTrackVariants> & {
    tone?: ProgressTone
  }

function Progress({
  className,
  children,
  value,
  max = 100,
  tone,
  size = "default",
  locale = "ru-RU",
  ...props
}: ProgressProps) {
  const resolvedTone: ProgressTone =
    tone ?? (value !== null && value >= max ? "done" : "active")

  return (
    <ProgressPrimitive.Root
      value={value}
      max={max}
      // A fixed locale keeps the server and client percent text identical,
      // otherwise hydration fails on "62%" vs "62 %".
      locale={locale}
      data-slot="progress"
      data-tone={resolvedTone}
      className={cn(
        "group/progress flex flex-wrap items-baseline gap-x-3 gap-y-2.5",
        className
      )}
      {...props}
    >
      {children}
      <ProgressTrack size={size}>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  )
}

function ProgressTrack({
  className,
  size = "default",
  ...props
}: ProgressPrimitive.Track.Props & VariantProps<typeof progressTrackVariants>) {
  return (
    <ProgressPrimitive.Track
      className={cn(progressTrackVariants({ size }), "order-1", className)}
      data-slot="progress-track"
      {...props}
    />
  )
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn(
        "h-full rounded-full bg-accent transition-[width] duration-300 ease-out group-data-[tone=done]/progress:bg-confirmed group-data-[tone=paused]/progress:bg-border-strong motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

function ProgressLabel({ className, ...props }: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      className={cn("text-base font-medium text-foreground", className)}
      data-slot="progress-label"
      {...props}
    />
  )
}

// Intl formats percents with a narrow space in some locales ("62 %"); the
// design always shows "62%".
const PERCENT_SPACE = /\s/g

function ProgressValue({
  className,
  children,
  ...props
}: ProgressPrimitive.Value.Props) {
  return (
    <span
      data-slot="progress-value"
      className={cn(
        "ml-auto inline-flex items-center gap-1 font-mono text-xs text-foreground tabular-nums group-data-[tone=done]/progress:text-confirmed group-data-[tone=paused]/progress:text-muted-foreground",
        className
      )}
    >
      <CheckIcon
        aria-hidden
        strokeWidth={3}
        className="hidden size-3 shrink-0 group-data-[tone=done]/progress:block"
      />
      <ProgressPrimitive.Value {...props}>
        {children ??
          ((formattedValue) =>
            formattedValue === null || formattedValue === "indeterminate"
              ? null
              : formattedValue.replace(PERCENT_SPACE, ""))}
      </ProgressPrimitive.Value>
    </span>
  )
}

/**
 * Caption row under the bar: details on the left, time or action on the right.
 * Render it next to Progress, not inside: everything inside a progressbar is
 * presentational for screen readers, so an action there can't be reached.
 */
function ProgressCaption({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="progress-caption"
      className={cn(
        "flex w-full items-center justify-between gap-3 text-sm text-muted-foreground tabular-nums",
        className
      )}
      {...props}
    />
  )
}

export {
  Progress,
  ProgressCaption,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
}
export type { ProgressProps, ProgressTone }
