import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * Heading of a block: the title, a muted note on its baseline and an action
 * on the right. `xl` (20px) for the sections of the project page, `lg`
 * (16px) for blocks on home.
 */
export function SectionHeading({
  action,
  className,
  id,
  meta,
  size = "xl",
  title,
}: {
  action?: ReactNode;
  className?: string;
  /** Id of the title, for aria-labelledby on the section. */
  id?: string;
  meta?: ReactNode;
  size?: "lg" | "xl";
  title: ReactNode;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6", className)}>
      <div className="flex min-w-0 items-baseline gap-3">
        <h2
          className={cn(
            "text-foreground shrink-0 font-semibold text-balance",
            size === "xl" ? "text-xl" : "text-lg"
          )}
          id={id}
        >
          {title}
        </h2>
        {meta ? (
          <div className="text-muted-foreground min-w-0 text-sm">{meta}</div>
        ) : null}
      </div>
      {action ? (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      ) : null}
    </div>
  );
}
