import { Alert, AlertDescription, AlertTitle } from "@grill/ui/alert";
import { Button } from "@grill/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grill/ui/empty";
import { CircleAlertIcon } from "lucide-react";
import type { LimitOutlook } from "@/bindings";
import { MainWindow } from "@/features/shell/main-window";
import { nearTitle, reachedTitle, resetLine } from "@/lib/agent-limit";

/*
 * The warning of the thresholds of Grill before a call (agent-limit-guard
 * design.md, decision 9). The start widget, which «Начать звонок» opens,
 * offers «Начать без агента» and «Начать сверх лимита».
 */
function LimitWarning({ limit }: { limit: LimitOutlook }) {
  if (limit.kind === "ok") {
    return null;
  }
  const reset = resetLine(limit.hit.resetsAt);
  const near = limit.kind === "near";
  return (
    <Alert className="text-left" variant="warning">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>
        {near ? nearTitle(limit.hit) : reachedTitle(limit.hit)}
      </AlertTitle>
      <AlertDescription>
        {near
          ? `Агент может встать посреди звонка, ${reset}.`
          : `Звонок можно начать без агента или сверх лимита, ${reset}.`}
      </AlertDescription>
    </Alert>
  );
}

const OK: LimitOutlook = { kind: "ok" };

/*
 * The call window without a call in progress (Tauri): it says so and
 * offers to start one. «Начать звонок» opens the start widget.
 */
export function NoCallScreen({
  className,
  limit = OK,
  onStartCall,
}: {
  className?: string;
  /** The thresholds of Grill: a warning when close or reached. */
  limit?: LimitOutlook;
  onStartCall: () => void;
}) {
  return (
    <MainWindow className={className} panelClassName="justify-center">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <h1>Звонка нет</h1>
          </EmptyTitle>
          <EmptyDescription>
            Начните звонок, и здесь появятся расшифровка и вопросы.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <LimitWarning limit={limit} />
          <Button onClick={onStartCall}>Начать звонок</Button>
        </EmptyContent>
      </Empty>
    </MainWindow>
  );
}
