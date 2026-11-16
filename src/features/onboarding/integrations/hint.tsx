import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/*
 * A muted 13px note with a 14px icon on its first line. `panel` puts it on
 * a gray strip (where to find the Outline key), `plain` leaves it bare (what
 * to do after Cancel on GitHub).
 */
export function Hint({
  children,
  className,
  icon,
  variant = "plain",
}: {
  children: ReactNode;
  className?: string;
  icon: ReactNode;
  variant?: "plain" | "panel";
}) {
  return (
    <div
      className={cn(
        "text-muted-foreground flex items-start gap-2.5 text-sm",
        variant === "panel" && "bg-surface rounded-md px-3.5 py-3",
        className
      )}
    >
      <span className="flex h-4.5 w-3.5 shrink-0 items-center justify-center [&>svg]:size-3.5">
        {icon}
      </span>
      <p className="min-w-0 flex-1">{children}</p>
    </div>
  );
}
