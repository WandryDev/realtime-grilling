import { Progress } from "@grill/ui/progress";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { IconTile } from "./icon-tile";

/*
 * Building blocks of the model part of the speech step, under the language
 * picker: a section set apart by space, a row with an icon tile, and a
 * progress bar on the hairline-gray track used by the onboarding.
 */

/** 16px more above it than the step's 32px gap: a part of its own. */
export function ModelSection({
  className,
  ...props
}: ComponentProps<"section">) {
  return (
    <section
      className={cn("flex flex-col gap-3.5 pt-4", className)}
      {...props}
    />
  );
}

/*
 * Icon tile, a semibold title over a muted line, an optional action on the
 * right. `align="start"` is the error layout: the tile sits at the top and
 * the text is a little tighter to it.
 */
export function ModelRow({
  action,
  align = "center",
  className,
  description,
  icon,
  title,
  tone,
}: {
  action?: ReactNode;
  align?: "center" | "start";
  className?: string;
  description: ReactNode;
  icon: ReactNode;
  title: ReactNode;
  tone?: "neutral" | "confirmed" | "contradiction";
}) {
  return (
    <div
      className={cn(
        "flex",
        align === "start" ? "items-start gap-3" : "items-center gap-3.5",
        className
      )}
    >
      <IconTile tone={tone}>{icon}</IconTile>
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          align === "start" ? "gap-1" : "gap-0.5"
        )}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      {action ? (
        <div className="flex w-[132px] shrink-0 justify-end">{action}</div>
      ) : null}
    </div>
  );
}

const BAR_COLOR = {
  accent: "",
  contradiction: "[&_[data-slot=progress-indicator]]:bg-contradiction",
} as const;

/*
 * A 6px bar on the hairline track. `tone` comes from Progress (active
 * orange, paused gray); `color="contradiction"` paints a full disk red.
 */
export function ModelBar({
  className,
  color = "accent",
  ...props
}: ComponentProps<typeof Progress> & { color?: keyof typeof BAR_COLOR }) {
  return (
    <Progress
      className={cn(
        "[&_[data-slot=progress-track]]:bg-border",
        BAR_COLOR[color],
        className
      )}
      locale="ru-RU"
      {...props}
    />
  );
}

/** Caption row under a bar: details on the left, status on the right. */
export function ModelBarCaption({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center justify-between gap-3 text-xs tabular-nums",
        className
      )}
      {...props}
    />
  );
}
