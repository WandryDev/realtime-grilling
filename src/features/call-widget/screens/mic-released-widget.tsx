import { Button } from "@/components/ui/button";
import { CallWidgetFooter } from "@/components/ui/call-widget";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import { WidgetCard } from "../components/widget-card";
import {
  WidgetHeader,
  WidgetHeading,
  WidgetMinimizeButton,
  WidgetStatus,
} from "../components/widget-header";
import { CALL_PROJECT, MEETING_APP, MIC_RELEASED } from "../mock";

/*
 * Paper "05 Микрофон освободился — приложение в фоне": nobody but us holds
 * the microphone and the call window is in the background, so the offer to
 * end the call comes as a floating widget. Recording goes on; at zero the
 * call ends by itself.
 */
export function MicReleasedWidget({
  app = MEETING_APP,
  className,
  countdown = MIC_RELEASED.countdown,
  elapsed = MIC_RELEASED.elapsed,
  onContinue,
  onEnd,
  onMinimize,
  project = CALL_PROJECT,
  releasedAt = MIC_RELEASED.releasedAt,
  time = MIC_RELEASED.time,
}: {
  app?: string;
  className?: string;
  /** Time left before the call ends by itself: "6:48". null: never. */
  countdown?: string | null;
  /** Percent of the countdown already passed. */
  elapsed?: number;
  /** "Продолжить": hide until the microphone is free again. */
  onContinue?: () => void;
  /** "Завершить": end the call and collect the summary. */
  onEnd?: () => void;
  onMinimize?: () => void;
  project?: string;
  releasedAt?: string;
  time?: string;
}) {
  return (
    <WidgetCard className={cn("gap-4", className)}>
      <WidgetHeader action={<WidgetMinimizeButton onClick={onMinimize} />}>
        <WidgetStatus time={time} tone="recording">
          {project}
        </WidgetStatus>
      </WidgetHeader>
      <WidgetHeading
        className="gap-1.5"
        description={`${app} отпустил микрофон в ${releasedAt}.`}
        title="Микрофон больше не используется. Завершить звонок?"
      />
      {countdown === null ? null : (
        <Progress
          className="[&_[data-slot=progress-track]]:bg-border gap-y-2 [&_[data-slot=progress-track]]:h-[3px]"
          size="sm"
          tone="active"
          value={elapsed}
        >
          <ProgressLabel className="text-muted-foreground flex items-center gap-1.5 text-sm font-normal">
            Завершу сам через
            <span className="text-foreground font-mono text-xs tabular-nums">
              {countdown}
            </span>
          </ProgressLabel>
        </Progress>
      )}
      <CallWidgetFooter>
        <Button
          className="flex-1"
          onClick={onContinue}
          size="lg"
          variant="secondary"
        >
          Продолжить
        </Button>
        <Button className="flex-1" onClick={onEnd} size="lg">
          Завершить
        </Button>
      </CallWidgetFooter>
    </WidgetCard>
  );
}
