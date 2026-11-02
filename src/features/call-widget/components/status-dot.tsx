import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

const TONE_CLASS = {
  /** The meeting app holds the microphone. */
  accent: "bg-accent",
  /** A project marker in the picker. */
  ink: "bg-foreground",
  /** Recording is on. */
  recording: "bg-recording",
} as const;

export type StatusDotTone = keyof typeof TONE_CLASS;

/** Decorative 8px dot before a status line or a project name. */
export function StatusDot({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & { tone: StatusDotTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full",
        TONE_CLASS[tone],
        className
      )}
      {...props}
    />
  );
}
