import type { ComponentProps } from "react";

import { CallWidgetFooter } from "@/components/ui/call-widget";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";

import type { BriefStepItem } from "../mock";
import { ActionButton } from "./action-button";
import { BriefSteps } from "./brief-steps";
import { WidgetCard } from "./widget-card";
import {
  WidgetHeader,
  WidgetHeading,
  WidgetMinimizeButton,
  WidgetStatus,
} from "./widget-header";

/*
 * Right after "Начать": recording is on, the brief is being refreshed step
 * by step under an orange bar. The call window or the overlay can be opened
 * right away.
 */
export function LaunchCard({
  callHref,
  caption,
  className,
  description,
  onMinimize,
  overlayHref,
  progress,
  steps,
  time,
  ...props
}: ComponentProps<"div"> & {
  /** "Открыть окно звонка" leads here. */
  callHref?: string;
  caption: string;
  description: string;
  onMinimize?: () => void;
  /** "Оверлей" leads here. */
  overlayHref?: string;
  /** Percent of the brief prepared. */
  progress: number;
  steps: BriefStepItem[];
  time: string;
}) {
  return (
    <WidgetCard className={className} {...props}>
      <WidgetHeader action={<WidgetMinimizeButton onClick={onMinimize} />}>
        <WidgetStatus time={time} tone="recording">
          Запись идёт
        </WidgetStatus>
      </WidgetHeader>
      <WidgetHeading
        description={description}
        icon={
          <span aria-hidden="true" className="flex">
            <Spinner className="text-accent [&_[data-slot=spinner-track]]:stroke-border size-[18px]" />
          </span>
        }
        title="Готовлю бриф"
      />
      <BriefSteps steps={steps} />
      <div className="flex flex-col gap-2">
        <Progress
          aria-label="Готовность брифа"
          className="[&_[data-slot=progress-track]]:bg-border"
          size="sm"
          tone="active"
          value={progress}
        />
        <p className="text-muted-foreground text-sm">{caption}</p>
      </div>
      <CallWidgetFooter className="items-center pt-0.5">
        <ActionButton
          className="flex-1"
          href={callHref}
          size="lg"
          variant="secondary"
        >
          Открыть окно звонка
        </ActionButton>
        <ActionButton href={overlayHref} size="lg" variant="ghost">
          Оверлей
        </ActionButton>
      </CallWidgetFooter>
    </WidgetCard>
  );
}
