import { cn } from "@/lib/utils";

import type { ListeningEmptyData } from "../types";

/*
 * First minutes of the call, before a topic is clear: the agent's orange
 * "listening" dots, a calm 28px line and what to do meanwhile.
 */
export function ListeningEmpty({
  className,
  empty,
}: {
  className?: string;
  empty: ListeningEmptyData;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-3.5 px-7 pt-[72px] pb-16",
        className
      )}
      role="status"
    >
      <span
        aria-hidden="true"
        className="*:bg-accent flex h-4 items-center gap-[5px] *:size-2 *:rounded-full"
      >
        <span />
        <span className="opacity-50" />
        <span className="opacity-25" />
      </span>
      <p className="max-w-[560px] text-2xl/9 font-semibold tracking-tight text-balance">
        {empty.title}
      </p>
      <p className="text-muted-foreground max-w-[520px] text-lg">
        {empty.description}
      </p>
    </div>
  );
}
