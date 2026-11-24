import { cn } from "cn"

import { Counter } from "./counter"

/*
 * Paper "04 Метки и пилюли", "Якорь темы": a 32px gray pill with the topic
 * name and its open-question count. The topic being discussed right now is
 * the only black pill in the call (`active`): orange dot, white text, count
 * at 60%. With no open questions the count goes gray (`countTone="neutral"`).
 */
type TopicAnchorProps = React.ComponentProps<"button"> & {
  /** The topic being discussed right now. */
  active?: boolean
  /** Open questions in the topic. */
  count?: number
  /** `open`: orange count, `neutral`: gray count (nothing new). */
  countTone?: "open" | "neutral"
}

function TopicAnchor({
  className,
  active = false,
  count,
  countTone = "open",
  children,
  type = "button",
  ...props
}: TopicAnchorProps) {
  return (
    <button
      data-slot="topic-anchor"
      data-active={active ? "" : undefined}
      aria-current={active ? "true" : undefined}
      type={type}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-surface px-3.5 text-sm font-medium whitespace-nowrap text-foreground transition-colors outline-none select-none hover:bg-border active:bg-border-strong focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-40",
        "data-active:bg-primary data-active:text-on-ink data-active:hover:bg-ink-hover data-active:active:bg-ink-active",
        className
      )}
      {...props}
    >
      {active ? (
        <span
          aria-hidden
          data-slot="topic-anchor-dot"
          className="size-1.5 shrink-0 rounded-full bg-accent"
        />
      ) : null}
      {children}
      {count === undefined ? null : (
        <>
          <Counter
            aria-hidden
            data-slot="topic-anchor-count"
            variant={countTone}
            className={cn(active && "text-on-ink/60")}
          >
            {count}
          </Counter>
          <span className="sr-only">, вопросов: {count}</span>
        </>
      )}
    </button>
  )
}

export { TopicAnchor }
export type { TopicAnchorProps }
