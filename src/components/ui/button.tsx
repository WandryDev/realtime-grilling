import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { Spinner } from "@/components/ui/spinner"

/*
 * Paper "01 Кнопки": every button is a pill. One black primary per screen,
 * the rest are gray (secondary) or text-only (ghost). Destructive only in
 * dialogs. Icon buttons are circles: 28/32/40 with a 14/16/18 icon.
 */
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-transparent font-medium whitespace-nowrap transition-colors outline-none select-none focus-visible:focus-ring data-disabled:pointer-events-none data-disabled:not-data-loading:opacity-40 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-ink-hover active:bg-ink-active [&_[data-slot=spinner-track]]:stroke-on-ink/30",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-border active:bg-border-strong aria-expanded:bg-border",
        ghost:
          "text-muted-foreground hover:bg-surface hover:text-foreground active:bg-border active:text-foreground focus-visible:text-foreground aria-expanded:bg-surface aria-expanded:text-foreground",
        destructive:
          "bg-destructive text-on-ink hover:bg-destructive-hover active:bg-destructive-active [&_[data-slot=spinner-track]]:stroke-on-ink/35",
        // Not in the design: a bordered pill for shadcn internals (dialog
        // close, pagination, carousel) that ask for "outline".
        outline:
          "border-border-strong bg-background text-foreground hover:bg-surface active:bg-border aria-expanded:bg-surface",
        link: "h-auto px-0 text-foreground underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 gap-1 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 px-3 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-8 px-3.5 text-sm",
        lg: "h-10 px-4.5 text-base [&_svg:not([class*='size-'])]:size-4.5",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 [&_svg:not([class*='size-'])]:size-3.5",
        icon: "size-8",
        "icon-lg": "size-10 [&_svg:not([class*='size-'])]:size-4.5",
      },
    },
    compoundVariants: [
      // Text buttons sit 2px tighter than filled ones
      { variant: "ghost", size: "sm", className: "px-2.5" },
      { variant: "ghost", size: "default", className: "px-3" },
      { variant: "ghost", size: "lg", className: "px-4" },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Disables the button and shows a spinner before the label. */
    loading?: boolean
  }

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  focusableWhenDisabled,
  children,
  ...props
}: ButtonProps) {
  // An icon button swaps its icon for the spinner, a labelled one keeps both
  const isIconOnly = size?.startsWith("icon") ?? false

  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      // Keep focus on the button while it is busy
      focusableWhenDisabled={focusableWhenDisabled ?? loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading ? <Spinner /> : null}
      {loading && isIconOnly ? null : children}
    </ButtonPrimitive>
  )
}

export { Button, buttonVariants, type ButtonProps }
