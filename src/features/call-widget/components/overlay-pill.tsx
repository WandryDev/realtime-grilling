import { Button } from "@grill/ui/button";
import { Counter } from "@grill/ui/counter";
import {
  RecordingIndicator,
  type RecordingLevel,
} from "@grill/ui/recording-indicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@grill/ui/tooltip";
import { cn } from "@/lib/utils";

import { ExpandIcon } from "../icons";
import { FloatingSurface } from "./floating-surface";

const pluralRules = new Intl.PluralRules("ru");

const OPEN_QUESTION_FORMS = {
  few: "открытых вопроса",
  many: "открытых вопросов",
  one: "открытый вопрос",
  other: "открытых вопросов",
} as const;

/** "5 открытых вопросов", "2 открытых вопроса", "1 открытый вопрос". */
function formatOpenQuestions(count: number) {
  const form = pluralRules.select(count) as keyof typeof OPEN_QUESTION_FORMS;
  return `${count} ${OPEN_QUESTION_FORMS[form] ?? OPEN_QUESTION_FORMS.other}`;
}

/*
 * The collapsed overlay, 44px: recording time, the current topic with its
 * open question count (hover shows "5 открытых вопросов") and a gray circle
 * that expands the overlay back.
 */
export function OverlayPill({
  className,
  level,
  onExpand,
  openQuestions,
  time,
  topic,
  warning,
}: {
  className?: string;
  /** Live levels next to the recording dot. */
  level?: RecordingLevel | null;
  onExpand?: () => void;
  openQuestions: number;
  time: string;
  topic: string;
  /** A channel that doesn't capture, on the recording indicator. */
  warning?: string | null;
}) {
  const countLabel = formatOpenQuestions(openQuestions);

  return (
    <FloatingSurface
      className={cn("h-11 gap-3 pr-1.5 pl-4", className)}
      shape="pill"
    >
      <RecordingIndicator
        level={level}
        time={time}
        variant="inline"
        warning={warning}
      />
      <span aria-hidden="true" className="bg-border h-4 w-px shrink-0" />
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium">{topic}</span>
        <Tooltip>
          <TooltipTrigger
            aria-label={countLabel}
            render={
              <Counter className="bg-accent-soft h-5 min-w-5 rounded-full px-1.5" />
            }
          >
            {openQuestions}
          </TooltipTrigger>
          <TooltipContent>{countLabel}</TooltipContent>
        </Tooltip>
      </div>
      <Button
        aria-label="Развернуть оверлей"
        onClick={onExpand}
        size="icon"
        variant="secondary"
      >
        <ExpandIcon className="size-3.5" />
      </Button>
    </FloatingSurface>
  );
}
