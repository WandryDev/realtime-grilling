"use client";

import { appearClassName, useAppear } from "@/components/ui/appear";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import { CheckIcon, MicOffIcon } from "../icons";
import type { FinishingData, FinishingStep, MicReleasedData } from "../types";

/*
 * Panels drawn over the call window. Both sit on the white popover surface
 * with the float shadow; the caller positions them. Arriving during the
 * call, the microphone panel rises from the bottom edge and the finishing
 * card scales up from 97% (200ms).
 */

const OVERLAY_SURFACE =
  "bg-popover text-popover-foreground shadow-float rounded-lg";

/**
 * Nobody holds the microphone any more: offer to end the call, with the
 * auto-end countdown (none when Settings say the call never ends itself).
 */
export function MicReleasedPanel({
  className,
  panel,
}: {
  className?: string;
  panel: MicReleasedData;
}) {
  const { onEnd, onMicContinue } = useCallActions();
  const entering = useAppear();

  return (
    <section
      aria-labelledby="mic-released-title"
      className={cn(
        OVERLAY_SURFACE,
        "flex w-[580px] max-w-[calc(100%-2rem)] flex-col gap-4 py-5 pr-5 pl-[22px]",
        appearClassName("rise"),
        className
      )}
      data-entering={entering ? "" : undefined}
    >
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden="true"
          className="bg-surface flex size-9 shrink-0 items-center justify-center rounded-full"
        >
          <MicOffIcon className="size-[18px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="text-lg font-semibold" id="mic-released-title">
            {panel.title}
          </h2>
          <p className="text-muted-foreground text-base">{panel.description}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 pl-[50px]">
        {panel.countdown === undefined ? (
          <span aria-hidden="true" className="flex-1" />
        ) : (
          <Progress
            aria-label={`${panel.countdownLabel} ${panel.countdown}`}
            className="[&_[data-slot=progress-track]]:bg-border flex-1 flex-col items-start gap-y-1.5 [&_[data-slot=progress-track]]:h-[3px] [&_[data-slot=progress-track]]:w-[140px]"
            value={panel.progress}
          >
            <span className="text-muted-foreground flex items-baseline gap-1.5 text-sm">
              {panel.countdownLabel}
              <span className="text-foreground font-mono text-xs tabular-nums">
                {panel.countdown}
              </span>
            </span>
          </Progress>
        )}
        <Button
          className="h-9 px-4 text-base"
          onClick={onMicContinue}
          variant="secondary"
        >
          Продолжить
        </Button>
        <Button className="h-9 px-4 text-base" onClick={onEnd}>
          Завершить
        </Button>
      </div>
    </section>
  );
}

/** "Собираю итоги…": the steps after the call ends, and the progress. */
export function FinishingCard({
  className,
  finishing,
}: {
  className?: string;
  finishing: FinishingData;
}) {
  const { onCancelFinish, onCloseWindow } = useCallActions();
  const entering = useAppear();

  return (
    <section
      aria-labelledby="finishing-title"
      className={cn(
        OVERLAY_SURFACE,
        "flex w-[460px] max-w-[calc(100%-2rem)] flex-col gap-[22px] p-7",
        appearClassName("pop"),
        className
      )}
      data-entering={entering ? "" : undefined}
      role="dialog"
    >
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <Spinner
            aria-hidden
            aria-label={undefined}
            className="text-accent [&_[data-slot=spinner-track]]:stroke-border size-[22px]"
          />
          <h2
            className="text-2xl font-semibold tracking-tight text-balance"
            id="finishing-title"
          >
            {finishing.title}
          </h2>
        </div>
        <p className="text-muted-foreground text-base">
          {finishing.description}
        </p>
      </header>
      <ol className="flex flex-col gap-3">
        {finishing.steps.map((step) => (
          <FinishingStepRow key={step.id} step={step} />
        ))}
      </ol>
      <div className="flex flex-col gap-5 pt-0.5">
        <Progress
          aria-label={finishing.title}
          className="[&_[data-slot=progress-track]]:bg-border"
          size="sm"
          value={finishing.progress}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {finishing.cancelDisabled ? null : (
            <Button onClick={onCancelFinish} variant="secondary">
              Отменить завершение
            </Button>
          )}
          <Button onClick={onCloseWindow}>Закрыть окно</Button>
        </div>
      </div>
    </section>
  );
}

const STEP_LABELS: Record<FinishingStep["state"], string> = {
  active: "идёт",
  done: "готово",
  pending: "ждёт",
};

function FinishingStepRow({ step }: { step: FinishingStep }) {
  return (
    <li
      aria-current={step.state === "active" ? "step" : undefined}
      className="flex items-center gap-2.5"
    >
      <span aria-hidden="true" className="flex w-5 shrink-0 justify-center">
        <StepMark state={step.state} />
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 text-base",
          step.state === "active"
            ? "text-foreground font-medium"
            : "text-muted-foreground"
        )}
      >
        {step.label}
        <span className="sr-only">, {STEP_LABELS[step.state]}</span>
      </span>
      {step.meta ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          {step.meta}
        </span>
      ) : null}
    </li>
  );
}

function StepMark({ state }: { state: FinishingStep["state"] }) {
  if (state === "done") {
    return <CheckIcon className="text-confirmed size-4" strokeWidth={1.31} />;
  }
  if (state === "active") {
    return (
      <Spinner
        aria-hidden
        aria-label={undefined}
        className="text-foreground [&_[data-slot=spinner-track]]:stroke-border"
      />
    );
  }
  return <span className="bg-border-strong size-1.5 rounded-full" />;
}
