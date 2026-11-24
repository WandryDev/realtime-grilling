import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Paper "09 Обратная связь", "Скелетон вопросов" and "Скелетон карточки
 * контекста": gray pill bars that follow the rhythm of the lines they stand
 * in for (14px for a title line, 10px for meta). Size them with className.
 * On white use the default hairline gray; inside a white card that sits on the
 * surface panel use `tone="surface"`. Square tiles and blocks override the
 * radius (`rounded-xs`, `rounded-sm`).
 */
const skeletonVariants = cva(
  "animate-pulse rounded-full motion-reduce:animate-none",
  {
    variants: {
      tone: {
        default: "bg-border",
        surface: "bg-surface",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  }
)

function Skeleton({
  className,
  tone = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(skeletonVariants({ tone }), className)}
      {...props}
    />
  )
}

export { Skeleton, skeletonVariants }
