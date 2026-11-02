import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import type { ProcessingStepData } from "../mock";
import { DoneCheck } from "./status-mark";

/*
 * "01 Сборка итогов": the steps the agent goes through after the call, the
 * skeleton of the summary underneath and placeholders in the right column.
 */

const STEP_STATUS_LABEL = {
  active: "в работе",
  done: "готово",
  waiting: "ждёт",
} as const;

function StepMark({ status }: { status: ProcessingStepData["status"] }) {
  if (status === "done") {
    return <DoneCheck className="mt-0.5" />;
  }
  if (status === "active") {
    return (
      <Spinner
        aria-hidden="true"
        aria-label={undefined}
        className="text-foreground mt-[5px]"
        role="presentation"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="border-border-strong mt-[7px] size-2.5 rounded-full border-[1.5px]"
    />
  );
}

export function ProcessingStep({
  className,
  step,
}: {
  className?: string;
  step: ProcessingStepData;
}) {
  const waiting = step.status === "waiting";

  return (
    <li className={cn("flex gap-3.5 py-3.5", className)}>
      <span className="flex w-5 shrink-0 justify-center">
        <StepMark status={step.status} />
        <span className="sr-only">{STEP_STATUS_LABEL[step.status]}: </span>
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <p
            className={cn(
              "text-lg font-medium",
              waiting && "text-muted-foreground"
            )}
          >
            {step.title}
          </p>
          <p className="text-muted-foreground text-base">{step.description}</p>
        </div>
        {step.progress === undefined ? null : (
          <Progress
            aria-label={step.title}
            className="**:data-[slot=progress-track]:bg-border"
            size="sm"
            value={step.progress}
          />
        )}
      </div>
      <span className="text-muted-foreground w-16 shrink-0 text-right font-mono text-xs leading-6 tabular-nums">
        {step.meta}
      </span>
    </li>
  );
}

export function ProcessingSteps({
  className,
  steps,
}: {
  className?: string;
  steps: ProcessingStepData[];
}) {
  return (
    <ol aria-label="Шаги" className={cn("flex max-w-160 flex-col", className)}>
      {steps.map((step) => (
        <ProcessingStep key={step.id} step={step} />
      ))}
    </ol>
  );
}

/** Gray block where the short summary will appear. */
export function SummarySkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("border-border border-t pt-7", className)}>
      <div className="bg-surface flex flex-col gap-3 rounded-md px-7 py-6">
        <Skeleton className="h-3 w-[72px]" />
        <Skeleton className="h-4 w-[92%]" />
        <Skeleton className="h-4 w-[78%]" />
        <Skeleton className="h-4 w-[54%]" />
      </div>
    </div>
  );
}

/** Placeholder card in the right column. */
export function SideCardSkeleton({
  lines,
  media,
  titleWidth,
}: {
  /** Widths of the text lines under the title. */
  lines: string[];
  media: "tile" | "avatar";
  titleWidth: string;
}) {
  return (
    <div className="bg-background shadow-card flex flex-col gap-3 rounded-md p-4">
      <div className="flex items-center gap-2.5">
        <Skeleton
          className={cn(
            "size-7",
            media === "tile" ? "rounded-xs" : "rounded-full"
          )}
          tone="surface"
        />
        <Skeleton className={cn("h-3", titleWidth)} tone="surface" />
      </div>
      {lines.map((width) => (
        <Skeleton className={cn("h-3", width)} key={width} tone="surface" />
      ))}
    </div>
  );
}

/** The agent works locally: Claude Code tile and two lines. */
export function AgentLocalStatus({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5 px-2 pt-3.5", className)}>
      <span className="bg-background flex size-7 shrink-0 items-center justify-center rounded-xs">
        <ClaudeIcon aria-hidden="true" className="size-4" />
      </span>
      <div className="flex flex-col text-sm">
        <p className="font-medium">Claude Code</p>
        <p className="text-muted-foreground">работает на вашем компьютере</p>
      </div>
    </div>
  );
}
