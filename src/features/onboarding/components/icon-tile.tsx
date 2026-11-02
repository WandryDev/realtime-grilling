import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

/*
 * Rounded square behind a line icon: 28px in the welcome feature list, 36px
 * next to permission and model rows. The tone tints the fill and the icon:
 * neutral (gray), confirmed (soft green) or contradiction (soft red, errors).
 */
const iconTileVariants = cva(
  "flex shrink-0 items-center justify-center rounded-xs",
  {
    defaultVariants: {
      size: "default",
      tone: "neutral",
    },
    variants: {
      size: {
        default: "size-9 [&>svg]:size-[18px]",
        sm: "size-7 [&>svg]:size-4",
      },
      tone: {
        confirmed: "bg-confirmed-soft text-confirmed",
        contradiction: "bg-contradiction-soft text-contradiction",
        neutral: "bg-surface text-foreground",
      },
    },
  }
);

export function IconTile({
  className,
  size,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof iconTileVariants>) {
  return (
    <span
      aria-hidden="true"
      className={cn(iconTileVariants({ size, tone }), className)}
      {...props}
    />
  );
}
