import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { CheckIcon } from "lucide-react"
import { cn } from "cn"

/*
 * Paper "04 Метки и пилюли", "Статус вопроса": a 26px pill on a soft fill with
 * a 6px dot (a check for confirmed, nothing for waiting) and 13px lowercase
 * text. Status variants render their marker themselves; pass
 * `indicator={false}` to drop it. `neutral` is the gray tag ("без жаргона").
 */
const badgeVariants = cva(
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border border-transparent text-sm whitespace-nowrap transition-colors focus-visible:focus-ring [&>svg]:pointer-events-none [&>svg]:shrink-0 [&>svg:not([class*='size-'])]:size-3",
  {
    variants: {
      variant: {
        contradiction: "bg-contradiction-soft text-contradiction",
        assumption: "bg-assumption-soft text-assumption",
        confirmed: "bg-confirmed-soft text-confirmed",
        waiting: "bg-accent-soft text-accent-ink",
        empty: "bg-surface text-muted-foreground",
        neutral: "bg-surface text-muted-foreground [a]:hover:bg-border",
        // shadcn names, kept for compatibility
        default: "bg-primary text-primary-foreground [a]:hover:bg-ink-hover",
        secondary: "bg-surface text-muted-foreground [a]:hover:bg-border",
        destructive: "bg-contradiction-soft text-contradiction",
        outline:
          "border-border-strong text-muted-foreground [a]:hover:bg-surface",
        ghost: "text-muted-foreground hover:bg-surface",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[26px] px-2.5",
        sm: "h-6 px-2.5",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "default",
    },
  }
)

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

const DOT_COLOR: Partial<Record<BadgeVariant, string>> = {
  contradiction: "bg-contradiction",
  assumption: "bg-assumption",
  empty: "bg-empty",
}

function BadgeIndicator({ variant }: { variant: BadgeVariant }) {
  if (variant === "confirmed") {
    return <CheckIcon aria-hidden strokeWidth={3} data-slot="badge-icon" />
  }
  const dot = DOT_COLOR[variant]
  if (!dot) {
    return null
  }
  return (
    <span
      aria-hidden
      data-slot="badge-dot"
      className={cn("size-1.5 shrink-0 rounded-full", dot)}
    />
  )
}

function Badge({
  className,
  variant = "neutral",
  size = "default",
  indicator = true,
  render,
  children,
  ...props
}: useRender.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & {
    /** Show the status dot or check. Only status variants have one. */
    indicator?: boolean
  }) {
  const resolvedVariant = variant ?? "neutral"
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
        children: (
          <>
            {indicator ? <BadgeIndicator variant={resolvedVariant} /> : null}
            {children}
          </>
        ),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
export type { BadgeVariant }
