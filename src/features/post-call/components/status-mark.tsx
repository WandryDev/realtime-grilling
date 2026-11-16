import { cn } from "@/lib/utils";

import { CheckIcon } from "../icons";
import type { FactStatus } from "../mock";

/*
 * Small status marks of the after-call screens: the 6px dot (a hollow ring
 * for "пусто"), the orange ring of an open question and the green check.
 * Decorative: the status is always spelled out next to them.
 */

type DotTone = FactStatus | "accent" | "subtle" | "idle";

const DOT_TONE: Record<DotTone, string> = {
  accent: "bg-accent",
  assumption: "bg-assumption",
  confirmed: "bg-confirmed",
  contradiction: "bg-contradiction",
  empty: "border-[1.5px] border-empty",
  idle: "bg-border-strong",
  subtle: "bg-subtle",
};

export function StatusDot({
  className,
  tone,
}: {
  className?: string;
  tone: DotTone;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        DOT_TONE[tone],
        className
      )}
    />
  );
}

/** Orange ring: a question still waits for an answer. 10px, `size-2` in rows. */
export function OpenRing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "border-accent size-2.5 shrink-0 rounded-full border-2",
        className
      )}
    />
  );
}

export function DoneCheck({ className }: { className?: string }) {
  return (
    <CheckIcon className={cn("text-confirmed size-4 shrink-0", className)} />
  );
}

export const FACT_STATUS_LABEL: Record<FactStatus, string> = {
  assumption: "допущение",
  confirmed: "подтверждено",
  contradiction: "противоречие",
  empty: "пусто",
};
