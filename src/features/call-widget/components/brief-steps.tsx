import { Spinner } from "@grill/ui/spinner";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

import { CheckIcon } from "../icons";
import type { BriefStepItem, BriefStepStatus } from "../mock";

// Spoken status, the marks themselves are decorative
const STATUS_LABEL: Record<BriefStepStatus, string> = {
  active: "выполняется",
  done: "готово",
  pending: "в очереди",
};

function BriefStepMark({ status }: { status: BriefStepStatus }) {
  if (status === "done") {
    return <CheckIcon className="text-confirmed size-4" strokeWidth={1.6} />;
  }
  if (status === "active") {
    return (
      <Spinner className="text-foreground [&_[data-slot=spinner-track]]:stroke-border" />
    );
  }
  return <span className="bg-border-strong size-1.5 shrink-0 rounded-full" />;
}

/*
 * One line of "Готовлю бриф": a 20px mark column (green check, spinner, gray
 * dot), the step and, while it runs, a count on the right. The running step
 * is ink and medium, the rest stay muted.
 */
export function BriefStep({
  className,
  label,
  meta,
  status,
  ...props
}: ComponentProps<"li"> & Omit<BriefStepItem, "id">) {
  const active = status === "active";
  return (
    <li
      className={cn("flex items-center gap-2.5", className)}
      data-status={status}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex w-5 shrink-0 items-center justify-center"
      >
        <BriefStepMark status={status} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-base",
          active ? "text-foreground font-medium" : "text-muted-foreground"
        )}
      >
        {label}
        <span className="sr-only">, {STATUS_LABEL[status]}</span>
      </span>
      {active && meta ? (
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {meta}
        </span>
      ) : null}
    </li>
  );
}

export function BriefSteps({
  className,
  steps,
  ...props
}: ComponentProps<"ul"> & { steps: BriefStepItem[] }) {
  return (
    <ul className={cn("flex flex-col gap-3", className)} {...props}>
      {steps.map(({ id, ...step }) => (
        <BriefStep key={id} {...step} />
      ))}
    </ul>
  );
}
