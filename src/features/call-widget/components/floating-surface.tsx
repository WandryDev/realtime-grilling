import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const SHAPE_CLASS = {
  /** The 380px overlay and other floating cards: 26px radius. */
  card: "flex-col rounded-lg",
  /** Collapsed widgets: 48px start pill, 44px overlay pill. */
  pill: "w-fit items-center rounded-full",
} as const;

/*
 * The white floating surface with the float shadow, same as CallWidget. Use
 * CallWidget for the 320px widget; this covers the shapes it doesn't: the
 * wider overlay and the pills. Size and padding come from the call site.
 */
export function FloatingSurface({
  className,
  shape = "card",
  ...props
}: ComponentProps<"div"> & { shape?: keyof typeof SHAPE_CLASS }) {
  return (
    <div
      className={cn(
        "bg-background text-foreground shadow-float flex",
        SHAPE_CLASS[shape],
        className
      )}
      {...props}
    />
  );
}
