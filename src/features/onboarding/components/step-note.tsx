import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * One muted 13px line with a 14px mark before it, under a step's content:
 * "Агента можно поменять позже в настройках", "Можно идти дальше…".
 * `icon` is any 14px svg (it gets the subtle/muted color from `iconTone`) or
 * use `dot` for the orange 6px dot that asks for attention.
 */
export function StepNote({
  children,
  className,
  dot = false,
  icon,
  iconTone = "muted",
  ...props
}: ComponentProps<"p"> & {
  dot?: boolean;
  icon?: ReactNode;
  iconTone?: "muted" | "subtle";
}) {
  return (
    <p
      className={cn(
        "text-muted-foreground flex items-center gap-2 text-sm",
        className
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden="true"
          className="bg-accent size-1.5 shrink-0 rounded-full"
        />
      ) : null}
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex shrink-0 [&>svg]:size-3.5",
            iconTone === "subtle" ? "text-subtle" : "text-muted-foreground"
          )}
        >
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
    </p>
  );
}
