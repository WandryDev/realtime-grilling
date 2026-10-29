import { cn } from "cn"

/*
 * Thin arc on a pale track. Size comes from className (14 by default, 20 and 28
 * in feedback), the stroke stays 1.5px at every size. The arc uses
 * currentColor; the track is border-strong and can be overridden on dark fills
 * with `[&_[data-slot=spinner-track]]:stroke-on-ink/30`.
 */
function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <svg
      data-slot="spinner"
      role="status"
      aria-label="Загрузка"
      viewBox="0 0 14 14"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      className={cn("size-3.5 shrink-0 animate-spin", className)}
      {...props}
    >
      <circle
        data-slot="spinner-track"
        cx="7"
        cy="7"
        r="5.5"
        vectorEffect="non-scaling-stroke"
        className="stroke-border-strong"
      />
      <path
        d="M7 1.5A5.5 5.5 0 0 1 12.5 7"
        vectorEffect="non-scaling-stroke"
        stroke="currentColor"
      />
    </svg>
  )
}

export { Spinner }
