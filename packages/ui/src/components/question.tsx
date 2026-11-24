"use client"

import * as React from "react"
import { cva } from "class-variance-authority"
import { cn } from "cn"

import { useAppear, useExitEnd } from "./appear"
import { Button, type ButtonProps } from "./button"

/*
 * Paper "05 Вопрос": the agent's question hints on the white panel.
 *
 * - `main`: the new question, one per screen. Soft orange card, 28px title,
 *   the "why ask" line in accent ink.
 * - `default`: a 20px row without a card.
 * - `compact`: a 16px row for previous topics.
 *
 * Rows turn gray on hover and reveal `QuestionActions` on the right. The
 * actions stay in the tab order while hidden, so keyboard focus reveals them
 * too. `state="answered"` dims the row to 60%, grays the question and shows
 * the client's quote in ink.
 *
 * Motion: inside an AppearScope a question that arrives later rises into
 * place (rows 4px, the main card 6px, 200ms on the enter curve). `leaving`
 * plays the exit, a 150ms fade with a 4px slide down towards "Обсудили в
 * этой теме", hides the row from input and screen readers, and calls
 * `onExited` when it is over; the list removes the row then.
 */
type QuestionVariant = "main" | "default" | "compact"
type QuestionState = "open" | "answered"

const QuestionContext = React.createContext<{
  variant: QuestionVariant
  state: QuestionState
  titleId: string
} | null>(null)

function useQuestion() {
  const context = React.useContext(QuestionContext)
  if (!context) {
    throw new Error("Question parts must be rendered inside <Question>")
  }
  return context
}

const questionVariants = cva(
  "group/question relative flex gap-4 px-7 transition-[background-color,opacity] duration-200 motion-reduce:transition-none data-entering:animate-in data-entering:fade-in-0 data-entering:ease-enter data-leaving:pointer-events-none data-leaving:animate-out data-leaving:fade-out data-leaving:slide-out-to-bottom-1 data-leaving:duration-150 data-leaving:ease-exit data-leaving:fill-mode-forwards",
  {
    variants: {
      variant: {
        main: "rounded-lg bg-accent-soft py-6 data-entering:slide-in-from-bottom-[6px]",
        default:
          "rounded-md py-[18px] hover:bg-surface focus-within:bg-surface data-entering:slide-in-from-bottom-1",
        compact:
          "rounded-md py-3 hover:bg-surface focus-within:bg-surface data-entering:slide-in-from-bottom-1",
      },
      state: {
        open: "",
        answered: "opacity-60",
      },
    },
    defaultVariants: {
      variant: "default",
      state: "open",
    },
  }
)

type QuestionProps = React.ComponentProps<"div"> & {
  variant?: QuestionVariant
  state?: QuestionState
  /** Plays the exit: fades out and slides down. */
  leaving?: boolean
  /** The exit is over (at once when nothing animates): remove the row. */
  onExited?: () => void
}

function Question({
  className,
  variant = "default",
  state = "open",
  leaving = false,
  onExited,
  ref,
  ...props
}: QuestionProps) {
  const titleId = React.useId()
  const context = React.useMemo(
    () => ({ variant, state, titleId }),
    [variant, state, titleId]
  )
  const entering = useAppear()
  const root = React.useRef<HTMLDivElement | null>(null)
  const setRoot = React.useCallback(
    (node: HTMLDivElement | null) => {
      root.current = node
      if (typeof ref === "function") {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [ref]
  )
  useExitEnd(root, leaving, onExited)

  return (
    <QuestionContext.Provider value={context}>
      <div
        role="group"
        aria-labelledby={titleId}
        aria-hidden={leaving || undefined}
        inert={leaving || undefined}
        data-slot="question"
        data-variant={variant}
        data-state={state}
        data-entering={entering && !leaving ? "" : undefined}
        data-leaving={leaving ? "" : undefined}
        className={cn(questionVariants({ variant, state }), className)}
        ref={setRoot}
        {...props}
      />
    </QuestionContext.Provider>
  )
}

const questionContentVariants = cva("flex min-w-0 flex-1 flex-col", {
  variants: {
    variant: {
      main: "gap-2.5",
      default: "gap-1",
      compact: "gap-0.5",
    },
  },
})

/** Text column: topic or status, title, description. */
function QuestionContent({ className, ...props }: React.ComponentProps<"div">) {
  const { variant } = useQuestion()

  return (
    <div
      data-slot="question-content"
      className={cn(questionContentVariants({ variant }), className)}
      {...props}
    />
  )
}

/** "Новый, только что" above the main question: orange dot, accent ink. */
function QuestionStatus({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="question-status"
      className={cn(
        "flex items-center gap-2 text-sm font-medium text-accent-ink",
        className
      )}
      {...props}
    >
      <span aria-hidden className="size-2 shrink-0 rounded-full bg-accent" />
      {children}
    </div>
  )
}

/** The topic the question came from, above the title in the final check. */
function QuestionTopic({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="question-topic"
      className={cn(
        "flex items-center gap-2 text-sm font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

const questionTitleVariants = cva("", {
  variants: {
    variant: {
      main: "text-[28px] leading-9 font-semibold tracking-tight text-balance",
      default: "text-xl font-medium text-balance",
      compact: "text-lg font-medium",
    },
    state: {
      open: "text-foreground",
      answered: "text-muted-foreground",
    },
  },
})

function QuestionTitle({ className, ...props }: React.ComponentProps<"p">) {
  const { variant, state, titleId } = useQuestion()

  return (
    <p
      id={titleId}
      data-slot="question-title"
      className={cn(questionTitleVariants({ variant, state }), className)}
      {...props}
    />
  )
}

const DESCRIPTION_SIZE: Record<QuestionVariant, string> = {
  main: "text-lg text-pretty",
  default: "text-base",
  compact: "text-sm",
}

type QuestionDescriptionProps = React.ComponentProps<"p"> & {
  /**
   * `accent`: accent ink, for a question asked without an answer
   * ("Спросили в 12:14, ответа не было"). The main question is always accent.
   */
  tone?: "default" | "accent"
}

/** Why ask, the source of the doubt, or the client's quote once answered. */
function QuestionDescription({
  className,
  tone = "default",
  ...props
}: QuestionDescriptionProps) {
  const { variant, state } = useQuestion()

  let color = "text-muted-foreground"
  if (tone === "accent" || variant === "main") {
    color = "text-accent-ink"
  } else if (state === "answered") {
    color = "text-foreground"
  }

  return (
    <p
      data-slot="question-description"
      data-tone={tone}
      className={cn(DESCRIPTION_SIZE[variant], color, className)}
      {...props}
    />
  )
}

/** Right column for a type tag, task link, "закреплён" or "отвечен". */
function QuestionAside({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="question-aside"
      className={cn("flex shrink-0 items-start gap-2", className)}
      {...props}
    />
  )
}

/**
 * Revealed on hover or when one of the actions has keyboard focus. Hidden
 * actions are visually clipped, not removed, so Tab still reaches them.
 */
function QuestionActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="question-actions"
      className={cn(
        "sr-only flex shrink-0 items-start gap-1 group-focus-within/question:not-sr-only group-hover/question:not-sr-only",
        className
      )}
      {...props}
    />
  )
}

/** A 28px white pill on the gray hover background. */
function QuestionAction({
  className,
  variant = "secondary",
  size = "sm",
  ...props
}: ButtonProps) {
  return (
    <Button
      data-slot="question-action"
      variant={variant}
      size={size}
      className={cn(
        variant === "secondary" &&
          "bg-background hover:bg-border active:bg-border-strong",
        className
      )}
      {...props}
    />
  )
}

export {
  Question,
  QuestionContent,
  QuestionStatus,
  QuestionTopic,
  QuestionTitle,
  QuestionDescription,
  QuestionAside,
  QuestionActions,
  QuestionAction,
  questionVariants,
}
export type { QuestionProps, QuestionVariant, QuestionState }
