import { cn } from "cn"

/*
 * Paper "04 Метки и пилюли", "Подсказка клавиш": a 20px key on the surface
 * fill with a 1px inner bottom edge, JetBrains Mono 12/16, muted. Keys of one
 * shortcut sit 4px apart in a KbdGroup; an action label goes 10px away.
 * Inside a tooltip (Paper "09 Обратная связь") keys turn white at 16%.
 */
function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-[6px] bg-surface px-[5px] font-mono text-xs text-muted-foreground shadow-[inset_0_-1px_0_var(--color-border-strong)] select-none in-data-[slot=tooltip-content]:rounded-[5px] in-data-[slot=tooltip-content]:bg-on-ink/16 in-data-[slot=tooltip-content]:px-1 in-data-[slot=tooltip-content]:text-on-ink in-data-[slot=tooltip-content]:shadow-none [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn(
        "inline-flex items-center gap-1 in-data-[slot=tooltip-content]:gap-[3px]",
        className
      )}
      {...props}
    />
  )
}

export { Kbd, KbdGroup }
