import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Item, ItemGroup } from "@/components/ui/item";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

import type { CallStatus, CallSummary } from "../mock";

/*
 * One-line call row of home ("Недавние звонки") and the project page
 * ("Звонки"): mono date 120, project 160 (home only), topic (fills), people
 * 140, mono duration 56 and the status 170 on the right. 52 high, gray on
 * hover. A call with unreviewed suggestions stays gray; a click opens the
 * review.
 */
export function CallLine({
  call,
  className,
  href = call.href ?? callHref(call),
}: {
  call: CallSummary;
  className?: string;
  href?: string;
}) {
  return (
    <Item
      className={cn(
        "h-13 shrink-0 gap-6 py-0",
        call.highlighted && "bg-muted",
        className
      )}
      render={<Link href={href} />}
    >
      <span className="text-muted-foreground w-[120px] shrink-0 font-mono text-xs">
        {call.when}
      </span>
      {call.project === undefined ? null : (
        <span className="text-foreground w-40 shrink-0 truncate text-base font-medium">
          {call.project}
        </span>
      )}
      <span className="text-foreground min-w-0 flex-1 truncate text-base">
        {call.topic}
      </span>
      <span className="text-muted-foreground w-[140px] shrink-0 truncate text-sm">
        {call.people}
      </span>
      <span className="text-muted-foreground w-14 shrink-0 text-right font-mono text-xs tabular-nums">
        {call.duration}
      </span>
      <span className="flex w-[170px] shrink-0 justify-end">
        <CallLineStatus status={call.status} />
      </span>
    </Item>
  );
}

/** Unreviewed suggestions open the review, other calls their summary. */
export function callHref(call: CallSummary) {
  return call.highlighted
    ? routes.callProposals(call.id)
    : routes.callSummary(call.id);
}

function CallLineStatus({ status }: { status: CallStatus }) {
  if (status.kind === "proposals") {
    return (
      <Badge className="text-xs" size="sm" variant="waiting">
        <span
          aria-hidden="true"
          className="bg-accent size-1.5 shrink-0 rounded-full"
        />
        {status.label}
      </Badge>
    );
  }
  return (
    <span
      className={cn(
        "text-sm",
        status.kind === "waiting" ? "text-accent-ink" : "text-muted-foreground"
      )}
    >
      {status.label}
    </span>
  );
}

/** Calls 8px apart. `empty` is shown when there are none. */
export function CallLineList({
  calls,
  className,
  empty,
}: {
  calls: CallSummary[];
  className?: string;
  empty?: string;
}) {
  if (calls.length === 0 && empty) {
    return <p className="text-muted-foreground px-4 py-3 text-sm">{empty}</p>;
  }
  return (
    <ItemGroup className={cn("gap-2", className)}>
      {calls.map((call) => (
        <CallLine call={call} key={call.id} />
      ))}
    </ItemGroup>
  );
}
