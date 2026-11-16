import type { ComponentProps } from "react";

import {
  CallWidgetAddPerson,
  CallWidgetPerson,
} from "@/components/ui/call-widget";
import { PersonChipRemove } from "@/components/ui/person-chip";
import { cn } from "@/lib/utils";

/*
 * Participants of the start widget: the widget's person chip one step taller
 * (30px) with a gray avatar, and the × always on view, since the widget is
 * where people are picked for the call. The 24px avatar holds one letter:
 * two would not fit.
 */
export function ParticipantChip({
  className,
  detail,
  initials,
  name,
  onRemove,
}: {
  className?: string;
  /** The hover hint: the full name and the tech level. */
  detail?: string;
  initials: string;
  name: string;
  onRemove?: () => void;
}) {
  return (
    <CallWidgetPerson
      className={cn(
        "[&_[data-slot=avatar-fallback]]:bg-border h-[30px] gap-1.5 pr-1 pl-1 has-data-[slot=person-chip-remove]:focus-within:pr-1 has-data-[slot=person-chip-remove]:hover:pr-1",
        className
      )}
      initials={Array.from(initials).at(0) ?? ""}
      name={name}
      title={detail}
    >
      <PersonChipRemove
        className="text-subtle -ml-1.5 w-6 opacity-100"
        onClick={onRemove}
      />
    </CallWidgetPerson>
  );
}

/** Dashed 30px circle that adds someone from the client's people. */
export function ParticipantAdd({
  className,
  ...props
}: ComponentProps<typeof CallWidgetAddPerson>) {
  return (
    <CallWidgetAddPerson
      className={cn(
        "border-border-strong size-[30px] border border-dashed inset-ring-0",
        className
      )}
      {...props}
    />
  );
}
