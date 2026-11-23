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
 * The line needs a wide list (`@4xl/calls`); narrower, a row takes two
 * lines: project, topic and status on top, date, people and duration below.
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
  const hasProject = call.project !== undefined;
  return (
    <Item
      className={cn(
        // Fixed first column, so the rows line up.
        "grid shrink-0 gap-x-4 gap-y-1 py-2.5",
        hasProject
          ? "grid-cols-[9rem_minmax(0,1fr)_auto]"
          : "grid-cols-[7rem_minmax(0,1fr)_auto]",
        "@4xl/calls:flex @4xl/calls:h-13 @4xl/calls:gap-6 @4xl/calls:py-0",
        call.highlighted && "bg-muted",
        className
      )}
      render={<Link href={href} />}
    >
      <span className="text-muted-foreground col-start-1 row-start-2 font-mono text-xs @4xl/calls:w-[120px] @4xl/calls:shrink-0">
        {call.when}
      </span>
      {hasProject ? (
        <span className="text-foreground col-start-1 row-start-1 truncate text-base font-medium @4xl/calls:w-40 @4xl/calls:shrink-0">
          {call.project}
        </span>
      ) : null}
      <span
        className={cn(
          "text-foreground row-start-1 min-w-0 truncate text-base @4xl/calls:flex-1",
          hasProject ? "col-start-2" : "col-span-2 col-start-1"
        )}
      >
        {call.topic}
      </span>
      <span className="text-muted-foreground col-start-2 row-start-2 truncate text-sm @4xl/calls:w-[140px] @4xl/calls:shrink-0">
        {call.people}
      </span>
      <span className="text-muted-foreground col-start-3 row-start-2 text-right font-mono text-xs tabular-nums @4xl/calls:w-14 @4xl/calls:shrink-0">
        {call.duration}
      </span>
      <span className="col-start-3 row-start-1 flex justify-end @4xl/calls:w-[170px] @4xl/calls:shrink-0">
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
    <ItemGroup className={cn("@container/calls gap-2", className)}>
      {calls.map((call) => (
        <CallLine call={call} key={call.id} />
      ))}
    </ItemGroup>
  );
}
