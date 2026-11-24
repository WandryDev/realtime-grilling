import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Paper "04 Метки и пилюли", "Счётчики". Numbers are always JetBrains Mono
 * 12/16 with tabular figures.
 * - open: bare number in accent ink, there are open questions
 * - neutral: bare gray number
 * - new: orange circle, ink number (new items)
 * - soft: soft orange pill with a label before the number
 * - nav: gray circle used in navigation
 */
const counterVariants = cva(
  "inline-flex shrink-0 items-center justify-center font-mono text-xs tabular-nums whitespace-nowrap",
  {
    variants: {
      variant: {
        open: "text-accent-ink",
        neutral: "text-muted-foreground",
        new: "h-5 min-w-5 rounded-full bg-accent px-1.5 font-medium text-foreground",
        soft: "h-[26px] gap-1.5 rounded-full bg-accent-soft px-2.5 text-accent-ink",
        nav: "h-[22px] min-w-[22px] rounded-full bg-surface px-[7px] text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "open",
    },
  }
)

function Counter({
  className,
  variant = "open",
  label,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof counterVariants> & {
    /** Text before the number, used with the `soft` variant. */
    label?: React.ReactNode
  }) {
  return (
    <span
      data-slot="counter"
      data-variant={variant}
      className={cn(counterVariants({ variant }), className)}
      {...props}
    >
      {label ? (
        <>
          <span data-slot="counter-label" className="font-sans text-sm">
            {label}
          </span>
          <span data-slot="counter-value" className="font-medium">
            {children}
          </span>
        </>
      ) : (
        children
      )}
    </span>
  )
}

export { Counter, counterVariants }
