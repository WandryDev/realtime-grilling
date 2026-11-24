import { Button } from "@grill/ui/button";
import { cn } from "@/lib/utils";

import { CloseIcon, ExpandIcon } from "../icons";
import { FloatingSurface } from "./floating-surface";
import { StatusDot } from "./status-dot";

/*
 * The start widget after "Не сейчас": a 48px pill that stays while the
 * microphone is busy and goes away with the call. "Начать" still starts
 * recording; the arrows bring the widget back.
 */
export function StartPill({
  app,
  className,
  onExpand,
  onHide,
  onStart,
  project,
}: {
  app: string;
  className?: string;
  /** Arrows: back to the full widget. */
  onExpand?: () => void;
  /** ×: hide until the next call. */
  onHide?: () => void;
  onStart?: () => void;
  project: string;
}) {
  return (
    <FloatingSurface
      className={cn("h-12 gap-2.5 pr-2.5 pl-4", className)}
      shape="pill"
    >
      <StatusDot tone="accent" />
      <span className="text-base font-medium">{project}</span>
      <span className="text-muted-foreground text-sm">звонок в {app}</span>
      <Button className="h-9" onClick={onStart}>
        Начать
      </Button>
      <div className="-ml-1 flex shrink-0 items-center gap-0.5">
        <Button
          aria-label="Развернуть виджет"
          onClick={onExpand}
          size="icon-sm"
          variant="ghost"
        >
          <ExpandIcon />
        </Button>
        <Button
          aria-label="Скрыть"
          onClick={onHide}
          size="icon-sm"
          variant="ghost"
        >
          <CloseIcon />
        </Button>
      </div>
    </FloatingSurface>
  );
}
