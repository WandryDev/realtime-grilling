import { appearClassName, useAppear } from "@grill/ui/appear";
import { Button } from "@grill/ui/button";
import { CallWidget } from "@grill/ui/call-widget";
import { cn } from "@/lib/utils";

import { CloseIcon } from "../icons";
import { StatusDot } from "./status-dot";

/*
 * Shows under the overlay pill for 8 seconds when an important question
 * arrives. The whole card expands the overlay; the × closes it at once.
 * Arriving, it drops 4px out from under the pill (200ms).
 */
export function NewQuestionCard({
  className,
  label = "Новый вопрос",
  onClose,
  onOpen,
  question,
}: {
  className?: string;
  label?: string;
  /** × : hide the card at once. */
  onClose?: () => void;
  /** The card itself: expand the overlay. */
  onOpen?: () => void;
  question: string;
}) {
  const entering = useAppear();

  return (
    <CallWidget
      className={cn(
        "relative w-[300px] flex-row items-start gap-2.5 py-3.5 pr-3.5 pl-4",
        appearClassName("drop"),
        className
      )}
      data-entering={entering ? "" : undefined}
      role="status"
    >
      <StatusDot className="mt-[7px] size-1.5" tone="accent" />
      <button
        className="focus-visible:focus-ring flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs text-left"
        onClick={onOpen}
        type="button"
      >
        <span className="text-accent-ink text-sm">{label}</span>
        <span className="text-base font-medium">{question}</span>
      </button>
      <Button
        aria-label="Закрыть"
        className="absolute top-[9px] right-2"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <CloseIcon />
      </Button>
    </CallWidget>
  );
}
