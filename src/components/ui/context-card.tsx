import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react"
import { cn } from "cn"

import {
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons"
import { buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

/*
 * Paper "07 Карточки контекста": what the agent found in the integrations.
 * White cards with the small card shadow on the gray context column, a source
 * logo tile in the header. Questions never look like this.
 *
 *   <ContextCard>
 *     <ContextCardHeader>
 *       <ContextCardSource source="github" />
 *       <ContextCardHeading>
 *         <ContextCardTitle>GitHub</ContextCardTitle>
 *         <ContextCardMeta mono>telemedia/backend</ContextCardMeta>
 *       </ContextCardHeading>
 *       <ContextCardTime>12:22</ContextCardTime>
 *     </ContextCardHeader>
 *     <ContextCardBody>…</ContextCardBody>
 *     <ContextCardCode>…</ContextCardCode>
 *     <ContextCardQuestionLink>к вопросу про …</ContextCardQuestionLink>
 *   </ContextCard>
 *
 * Hovering the card (or focusing inside it) deepens the shadow, reveals
 * ContextCardOpen and darkens the question link. ContextCardSearching and
 * ContextCardEmpty are the states of the column without a result.
 */

function ContextCard({ className, ...props }: React.ComponentProps<"article">) {
  return (
    <article
      data-slot="context-card"
      className={cn(
        "group/context-card flex min-w-0 flex-col gap-3 rounded-md bg-background p-3.5 shadow-card-sm transition-shadow hover:shadow-card",
        className
      )}
      {...props}
    />
  )
}

function ContextCardHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-header"
      className={cn("flex min-w-0 items-center gap-2.5", className)}
      {...props}
    />
  )
}

const SOURCE_ICONS = {
  github: GitHubIcon,
  outline: OutlineIcon,
  clickup: ClickUpIcon,
} as const

type ContextSource = keyof typeof SOURCE_ICONS

/*
 * 28px logo tile. `default` is gray with a 16px mark (card header), `outline`
 * is white with a hairline ring and a faded 14px mark (empty state).
 * Decorative: the source name is in the title next to it.
 */
const contextCardSourceVariants = cva(
  "flex size-7 shrink-0 items-center justify-center rounded-xs",
  {
    variants: {
      variant: {
        default: "bg-surface [&_svg]:size-4",
        outline:
          "bg-background ring-1 ring-foreground/6 [&_svg]:size-3.5 [&_svg]:opacity-50",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function ContextCardSource({
  className,
  source,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof contextCardSourceVariants> & { source: ContextSource }) {
  const Icon = SOURCE_ICONS[source]
  return (
    <span
      aria-hidden
      data-slot="context-card-source"
      data-source={source}
      className={cn(contextCardSourceVariants({ variant }), className)}
      {...props}
    >
      <Icon />
    </span>
  )
}

/** Title and meta stacked next to the logo; takes the free width. */
function ContextCardHeading({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-heading"
      className={cn("flex min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  )
}

/** Source name, 13px semibold. Use `render` for a heading element. */
function ContextCardTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("text-sm font-semibold text-foreground", className) },
      props
    ),
    render,
    state: { slot: "context-card-title" },
  })
}

/**
 * What exactly was found: a document title (13px) or, with `mono`, a repo or
 * task id in JetBrains Mono (12px).
 */
function ContextCardMeta({
  className,
  mono = false,
  ...props
}: React.ComponentProps<"div"> & { mono?: boolean }) {
  return (
    <div
      data-slot="context-card-meta"
      className={cn(
        "truncate text-muted-foreground",
        mono ? "font-mono text-xs" : "text-sm",
        className
      )}
      {...props}
    />
  )
}

/** When it was found, top right of the header. */
function ContextCardTime({
  className,
  ...props
}: React.ComponentProps<"time">) {
  return (
    <time
      data-slot="context-card-time"
      className={cn(
        "shrink-0 font-mono text-xs text-muted-foreground tabular-nums",
        className
      )}
      {...props}
    />
  )
}

/*
 * Header status: `new` is an orange dot with "новое" that fades out after
 * 10 seconds (instantly under reduced motion; pass `fade={false}` to keep
 * it), `error` is a red dot with a hidden "ошибка" label.
 */
function ContextCardStatus({
  className,
  status,
  fade = true,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  status: "new" | "error"
  /** Fade "новое" out after 10 seconds. */
  fade?: boolean
}) {
  const isNew = status === "new"
  return (
    <span
      data-slot="context-card-status"
      data-status={status}
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-sm text-accent-ink",
        isNew &&
          fade &&
          "animate-out fade-out fill-mode-forwards delay-[10s] duration-300 motion-reduce:duration-0",
        className
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isNew ? "bg-accent" : "bg-contradiction"
        )}
      />
      <span className={cn(!isNew && "sr-only")}>
        {children ?? (isNew ? "новое" : "ошибка")}
      </span>
    </span>
  )
}

/**
 * "Open in source": a 28px gray circle, shown while the card is hovered or
 * has focus inside. Renders a link; the label defaults to "Открыть в
 * источнике".
 */
function ContextCardOpen({
  className,
  children,
  "aria-label": ariaLabel = "Открыть в источнике",
  ...props
}: React.ComponentProps<"a">) {
  return (
    <a
      data-slot="context-card-open"
      aria-label={ariaLabel}
      className={cn(
        buttonVariants({ variant: "secondary", size: "icon-sm" }),
        "opacity-0 transition-[opacity,background-color] group-focus-within/context-card:opacity-100 group-hover/context-card:opacity-100",
        className
      )}
      {...props}
    >
      {children ?? (
        <ArrowUpRightIcon
          aria-hidden
          absoluteStrokeWidth
          strokeWidth={1.4}
          className="size-3"
        />
      )}
    </a>
  )
}

/** Main finding, 14px ink. */
function ContextCardBody({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="context-card-body"
      className={cn("text-base text-foreground", className)}
      {...props}
    />
  )
}

/** File path and functions on a gray plate, JetBrains Mono 12/18. */
function ContextCardCode({
  className,
  ...props
}: React.ComponentProps<"pre">) {
  return (
    <pre
      data-slot="context-card-code"
      className={cn(
        "rounded-sm bg-surface px-3 py-2.5 font-mono text-xs/[18px] wrap-anywhere whitespace-pre-wrap text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

/** A quote from a document or comment, with a 2px gray rule on the left. */
function ContextCardQuote({
  className,
  children,
  ...props
}: React.ComponentProps<"blockquote">) {
  return (
    <blockquote
      data-slot="context-card-quote"
      className={cn(
        "flex gap-2.5 text-sm text-foreground before:w-0.5 before:shrink-0 before:rounded-full before:bg-border-strong",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-col gap-0.5">{children}</div>
    </blockquote>
  )
}

/** Who said it and when, above the quote: "Андрей, 2 дня назад". */
function ContextCardQuoteMeta({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-quote-meta"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

/**
 * "→ к вопросу про …": jumps to the question this finding relates to. A
 * button by default, pass `render={<a href="…" />}` for a link. Negative
 * margins give it a 28px hit area without moving the text.
 */
function ContextCardQuestionLink({
  className,
  render,
  children,
  ...props
}: useRender.ComponentProps<"button">) {
  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(
      {
        ...(render ? {} : { type: "button" as const }),
        className: cn(
          "-mx-2 -my-[5px] flex h-7 w-fit max-w-[calc(100%+16px)] items-center gap-1.5 rounded-full px-2 text-left text-sm text-muted-foreground transition-colors outline-none group-hover/context-card:text-foreground hover:bg-surface hover:text-foreground focus-visible:focus-ring",
          className
        ),
        children: (
          <>
            <ArrowRightIcon
              aria-hidden
              absoluteStrokeWidth
              strokeWidth={1.5}
              className="size-3 shrink-0"
            />
            <span className="truncate">{children}</span>
          </>
        ),
      },
      props
    ),
    render,
    state: { slot: "context-card-question-link" },
  })
}

/** Error title and explanation, 4px apart. */
function ContextCardAlert({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-alert"
      className={cn("flex flex-col gap-1", className)}
      {...props}
    />
  )
}

function ContextCardAlertTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-alert-title"
      className={cn("text-base font-medium text-contradiction", className)}
      {...props}
    />
  )
}

function ContextCardAlertDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="context-card-alert-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Row of small buttons: "Войти заново" (secondary) and "Скрыть" (ghost). */
function ContextCardActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-actions"
      className={cn("flex flex-wrap gap-1.5", className)}
      {...props}
    />
  )
}

/** The agent is looking: dashed outline, spinner and what it searches for. */
function ContextCardSearching({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-searching"
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-md border border-dashed border-border-strong px-3.5 py-3 text-sm text-muted-foreground",
        className
      )}
      {...props}
    >
      <Spinner
        aria-hidden
        aria-label={undefined}
        role={undefined}
        className="text-foreground"
      />
      {children}
    </div>
  )
}

/** Nothing found yet: logos of connected sources, text and a setup button. */
function ContextCardEmpty({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-empty"
      className={cn(
        "flex flex-col items-center gap-3 px-5 py-7 text-center",
        className
      )}
      {...props}
    />
  )
}

function ContextCardEmptySources({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-empty-sources"
      className={cn("flex gap-1.5", className)}
      {...props}
    />
  )
}

function ContextCardEmptyContent({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-empty-content"
      className={cn("flex flex-col items-center gap-1 text-sm", className)}
      {...props}
    />
  )
}

function ContextCardEmptyTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-card-empty-title"
      className={cn("font-medium text-foreground", className)}
      {...props}
    />
  )
}

function ContextCardEmptyDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="context-card-empty-description"
      className={cn("text-pretty text-muted-foreground", className)}
      {...props}
    />
  )
}

/** Header of the context column: "Контекст" and a muted note on the right. */
function ContextColumnHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-column-header"
      className={cn(
        "flex items-center justify-between gap-3 px-2 pt-2 pb-1.5 text-sm",
        className
      )}
      {...props}
    />
  )
}

/** Column title, 13px semibold. Use `render` for a heading element. */
function ContextColumnTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("font-semibold text-foreground", className) },
      props
    ),
    render,
    state: { slot: "context-column-title" },
  })
}

function ContextColumnDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="context-column-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  ContextCard,
  ContextCardActions,
  ContextCardAlert,
  ContextCardAlertDescription,
  ContextCardAlertTitle,
  ContextCardBody,
  ContextCardCode,
  ContextCardEmpty,
  ContextCardEmptyContent,
  ContextCardEmptyDescription,
  ContextCardEmptySources,
  ContextCardEmptyTitle,
  ContextCardHeader,
  ContextCardHeading,
  ContextCardMeta,
  ContextCardOpen,
  ContextCardQuestionLink,
  ContextCardQuote,
  ContextCardQuoteMeta,
  ContextCardSearching,
  ContextCardSource,
  ContextCardStatus,
  ContextCardTime,
  ContextCardTitle,
  ContextColumnDescription,
  ContextColumnHeader,
  ContextColumnTitle,
  contextCardSourceVariants,
}
export type { ContextSource }
