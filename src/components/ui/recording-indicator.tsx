import { cva, type VariantProps } from "class-variance-authority"
import { PauseIcon } from "lucide-react"
import { cn } from "cn"

import { Spinner } from "@/components/ui/spinner"

/*
 * Paper "04 Метки и пилюли", "Запись и прослушивание".
 *
 * RecordingIndicator: a 32px white chip (it sits on the surface fill) with an
 * 8px red dot and the call time in JetBrains Mono. Paused swaps the dot for a
 * pause mark and grays everything out. A `label` ("идёт запись") adds a soft
 * red halo around the dot, used right after the recording starts. The
 * `inline` variant drops the chip, as in call history rows.
 *
 * The root is a `timer` (implicitly aria-live="off") so screen readers don't
 * announce every second.
 */
const recordingIndicatorVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-2 whitespace-nowrap text-foreground data-paused:text-muted-foreground",
  {
    variants: {
      variant: {
        chip: "h-8 rounded-full bg-background px-3",
        inline: "",
      },
    },
    defaultVariants: {
      variant: "chip",
    },
  }
)

type RecordingIndicatorProps = React.ComponentProps<"span"> &
  VariantProps<typeof recordingIndicatorVariants> & {
    /** Elapsed call time, already formatted: "24:18". */
    time: string
    paused?: boolean
    /** Text before the time. Paused defaults to "пауза". */
    label?: React.ReactNode
  }

function RecordingIndicator({
  className,
  variant = "chip",
  time,
  paused = false,
  label,
  ...props
}: RecordingIndicatorProps) {
  const text = label ?? (paused ? "пауза" : null)

  // A span, so the indicator can sit inside row buttons (CallRow).
  return (
    <span
      data-slot="recording-indicator"
      data-paused={paused ? "" : undefined}
      role="timer"
      aria-label={paused ? `Запись на паузе, ${time}` : `Идёт запись, ${time}`}
      className={cn(recordingIndicatorVariants({ variant }), className)}
      {...props}
    >
      {paused ? (
        <PauseIcon
          aria-hidden
          data-slot="recording-indicator-pause"
          className="size-2.5 shrink-0 fill-current stroke-none"
        />
      ) : (
        <span
          aria-hidden
          data-slot="recording-indicator-dot"
          className={cn(
            "size-2 shrink-0 rounded-full bg-recording",
            label && "ring-4 ring-recording/18"
          )}
        />
      )}
      {text ? (
        <span data-slot="recording-indicator-label" className="text-sm">
          {text}
        </span>
      ) : null}
      <span
        data-slot="recording-indicator-time"
        className="font-mono text-xs tabular-nums"
      >
        {time}
      </span>
    </span>
  )
}

/*
 * Agent status next to the transcript: three fading orange dots for
 * "слушаю", a spinner for "думаю над вопросами". Muted 13px text.
 * `tone` recolors the dots when the agent can't work as usual (Paper
 * "Звонок", 05 and 07): `muted` gray for "тишина" or "вопросы на паузе",
 * `destructive` red for "слышу только вас".
 */
const AGENT_STATUS_DOT_TONES = {
  accent: "*:bg-accent",
  muted: "*:bg-subtle",
  destructive: "*:bg-contradiction",
} as const

type AgentStatusTone = keyof typeof AGENT_STATUS_DOT_TONES

const AGENT_STATUS_LABELS = {
  listening: "слушаю",
  thinking: "думаю над вопросами",
} as const

type AgentState = keyof typeof AGENT_STATUS_LABELS

function AgentStatus({
  className,
  state,
  tone = "accent",
  children,
  ...props
}: React.ComponentProps<"div"> & {
  state: AgentState
  /** Dot color of the listening state. */
  tone?: AgentStatusTone
}) {
  return (
    <div
      data-slot="agent-status"
      data-state={state}
      data-tone={tone}
      role="status"
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-2 text-sm whitespace-nowrap text-muted-foreground",
        className
      )}
      {...props}
    >
      {state === "listening" ? (
        <span
          aria-hidden
          data-slot="agent-status-dots"
          className={cn(
            "flex gap-[3px] *:size-1 *:rounded-full",
            AGENT_STATUS_DOT_TONES[tone]
          )}
        >
          <span />
          <span className="opacity-50" />
          <span className="opacity-25" />
        </span>
      ) : (
        <Spinner
          aria-hidden
          aria-label={undefined}
          role={undefined}
          className="text-foreground"
        />
      )}
      <span>{children ?? AGENT_STATUS_LABELS[state]}</span>
    </div>
  )
}

export { AgentStatus, RecordingIndicator, recordingIndicatorVariants }
export type { AgentState, AgentStatusTone, RecordingIndicatorProps }
