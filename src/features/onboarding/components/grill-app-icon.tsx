import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";
import { GrillMarkIcon } from "./icons";

/* The Grill app icon: a 56px black tile with the question bubble. */
export function GrillAppIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-foreground text-on-ink flex size-14 shrink-0 items-center justify-center rounded-md",
        className
      )}
      {...props}
    >
      <GrillMarkIcon className="size-7" />
    </span>
  );
}
