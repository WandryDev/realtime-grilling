import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";
import { GrillMarkIcon } from "./icons";

/*
 * The Grill app icon: a 56px black tile with the question bubble. `badge`
 * adds the orange dot on the corner (welcome screen), ringed in the panel
 * white.
 */
export function GrillAppIcon({
  badge = false,
  className,
  ...props
}: ComponentProps<"span"> & { badge?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-foreground text-on-ink relative flex size-14 shrink-0 items-center justify-center rounded-md",
        className
      )}
      {...props}
    >
      <GrillMarkIcon className="size-7" />
      {badge ? (
        <span className="border-background bg-accent absolute -top-[3px] -right-[3px] size-3.5 rounded-full border-[3px]" />
      ) : null}
    </span>
  );
}
