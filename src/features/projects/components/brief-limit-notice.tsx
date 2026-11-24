import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@grill/ui/alert";
import { Button } from "@grill/ui/button";
import type { LimitOutlook } from "@/bindings";
import { hitSentence } from "@/lib/agent-limit";

/*
 * «Бриф не собран: достигнут лимит Grill» (agent-limit-guard design.md,
 * decision 8): a threshold of Grill held the build back before the agent.
 * The wizard shows it in place of the build's progress, its footer offers
 * «Собрать сверх лимита»; the project page shows it in «Бриф» with the
 * button in the banner.
 */

/** The threshold reached now and its reset; once none is, only that. */
export function briefLimitDetail(outlook: LimitOutlook) {
  if (outlook.kind !== "reached") {
    return "Порог лимита Grill больше не достигнут: бриф можно собрать.";
  }
  return `${hitSentence(outlook.hit)} Проект сохранён, бриф можно собрать после сброса или сразу, сверх лимита.`;
}

export function BriefLimitNotice({
  className,
  onOverLimit,
  outlook,
}: {
  className?: string;
  /** «Собрать сверх лимита» in the banner; hidden without it. */
  onOverLimit?: () => void;
  outlook: LimitOutlook;
}) {
  return (
    <Alert className={className} variant="warning">
      <AlertTitle>Бриф не собран: достигнут лимит Grill</AlertTitle>
      <AlertDescription>{briefLimitDetail(outlook)}</AlertDescription>
      {onOverLimit ? (
        <AlertAction>
          <Button onClick={onOverLimit} size="sm">
            Собрать сверх лимита
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
