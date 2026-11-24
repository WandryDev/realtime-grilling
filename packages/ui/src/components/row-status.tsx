import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/*
 * Paper "08 Строки списков": the 13px status text at the right of a row
 * ("3 открытых", "всё закрыто", "бриф устарел", "предложено обновить
 * профиль"). `dot` puts a 6px dot of the same hue before the text.
 */
const rowStatusVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 text-sm whitespace-nowrap",
  {
    variants: {
      tone: {
        muted: "text-muted-foreground",
        open: "text-accent-ink tabular-nums",
        confirmed: "text-confirmed",
        assumption: "text-assumption",
        contradiction: "text-contradiction",
        suggestion: "text-accent-ink",
      },
    },
    defaultVariants: {
      tone: "muted",
    },
  }
)

type RowStatusTone = NonNullable<
  VariantProps<typeof rowStatusVariants>["tone"]
>

const DOT_COLOR: Record<RowStatusTone, string> = {
  muted: "bg-empty",
  open: "bg-accent",
  confirmed: "bg-confirmed",
  assumption: "bg-assumption",
  contradiction: "bg-contradiction",
  suggestion: "bg-accent",
}

function RowStatus({
  className,
  tone = "muted",
  dot = false,
  children,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof rowStatusVariants> & {
    dot?: boolean
  }) {
  const resolvedTone = tone ?? "muted"
  return (
    <span
      data-slot="row-status"
      data-tone={resolvedTone}
      className={cn(rowStatusVariants({ tone }), className)}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden
          data-slot="row-status-dot"
          className={cn("size-1.5 shrink-0 rounded-full", DOT_COLOR[resolvedTone])}
        />
      ) : null}
      {children}
    </span>
  )
}

const pluralRules = new Intl.PluralRules("ru")

/** "1 открытый", "3 открытых", "21 открытый". */
function formatOpenQuestions(count: number) {
  return `${count} ${pluralRules.select(count) === "one" ? "открытый" : "открытых"}`
}

export { RowStatus, formatOpenQuestions, rowStatusVariants }
export type { RowStatusTone }
