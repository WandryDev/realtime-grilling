import { cn } from "@/lib/utils";

/*
 * Five-step scale of a person: how technical they are, how well they know
 * the project. `sm` is the 20×4 bars of the person cards, `md` the full-width
 * 6px bars of the profile. With `preview` the hovered step of the edit mode
 * is drawn in strong gray.
 */
export function LevelMeter({
  className,
  label,
  level,
  max = 5,
  preview,
  size = "sm",
}: {
  className?: string;
  /** Accessible name, "В технике". */
  label: string;
  level: number;
  max?: number;
  preview?: number;
  size?: "sm" | "md";
}) {
  const steps = Array.from({ length: max }, (_, index) => index + 1);

  return (
    <span className={cn("flex", className)}>
      <span className="sr-only">
        {label}: {level} из {max}
      </span>
      <span
        aria-hidden="true"
        className={cn("flex flex-1", size === "sm" ? "gap-[3px]" : "gap-1")}
      >
        {steps.map((step) => (
          <span
            className={cn(
              "shrink-0 rounded-full",
              size === "sm" ? "h-1 w-5" : "h-1.5 flex-1",
              levelColor({ level, preview, size, step })
            )}
            key={step}
          />
        ))}
      </span>
    </span>
  );
}

function levelColor({
  level,
  preview,
  size,
  step,
}: {
  level: number;
  preview?: number;
  size: "sm" | "md";
  step: number;
}) {
  if (step <= level) {
    return "bg-foreground";
  }
  if (preview !== undefined && step <= preview) {
    return "bg-border-strong";
  }
  return size === "sm" ? "bg-border-strong" : "bg-border";
}
