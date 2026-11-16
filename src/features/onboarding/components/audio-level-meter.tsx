import { cn } from "@/lib/utils";

/*
 * Live level of the system sound on the Windows permissions step: 4px bars,
 * 3px apart, in a 72×24 box. The first `active` bars are orange, the rest
 * stay gray. `levels` are bar heights in px (4 is the resting dot).
 */
export function AudioLevelMeter({
  active,
  className,
  label = "Уровень системного звука",
  levels,
}: {
  active: number;
  className?: string;
  label?: string;
  levels: readonly number[];
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        "flex h-6 w-[72px] shrink-0 items-center gap-[3px]",
        className
      )}
      role="img"
    >
      {levels.map((height, index) => (
        <span
          className={cn(
            "w-1 shrink-0 rounded-full",
            index < active ? "bg-accent" : "bg-border-strong"
          )}
          // Bars are positional: the index is their identity
          // biome-ignore lint/suspicious/noArrayIndexKey: static meter bars
          key={index}
          style={{ height }}
        />
      ))}
    </div>
  );
}
