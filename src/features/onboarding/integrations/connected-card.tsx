import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { CheckIcon } from "@/features/onboarding/components/icons";
import { cn } from "@/lib/utils";

/** Green check and "Подключено". */
export function ConnectedMark({
  children = "Подключено",
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-confirmed flex h-8 shrink-0 items-center gap-1.5 text-sm font-medium",
        className
      )}
    >
      <CheckIcon className="size-3.5" />
      {children}
    </span>
  );
}

/*
 * White card after a successful connection: the account or workspace with
 * "Подключено", and under a hairline what Grill now sees (repositories,
 * collections, people) as gray chips plus "и ещё N".
 */
export function ConnectedCard({
  chips,
  chipsMono = false,
  className,
  description,
  descriptionMono = false,
  media,
  meta,
  moreCount,
  title,
  titleMono = false,
}: {
  chips: string[];
  /** Repository names are set in mono. */
  chipsMono?: boolean;
  className?: string;
  description: ReactNode;
  descriptionMono?: boolean;
  /** Avatar before the title. */
  media?: ReactNode;
  /** Count before the status ("14 коллекций"). */
  meta?: ReactNode;
  /** Shown as "и ещё N" after the chips. */
  moreCount?: number;
  title: ReactNode;
  titleMono?: boolean;
}) {
  return (
    <section
      className={cn(
        "bg-background shadow-card flex flex-col rounded-md px-4.5 py-1.5",
        className
      )}
    >
      <div className="flex items-center gap-3 py-3">
        {media}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            className={cn(
              "truncate text-base",
              titleMono ? "font-mono font-medium" : "font-semibold"
            )}
          >
            {title}
          </p>
          <p
            className={cn(
              "text-muted-foreground truncate",
              descriptionMono ? "font-mono text-xs" : "text-sm"
            )}
          >
            {description}
          </p>
        </div>
        {meta ? (
          <span className="text-muted-foreground shrink-0 text-sm">{meta}</span>
        ) : null}
        <ConnectedMark />
      </div>
      <ul className="flex flex-wrap items-center gap-1.5 pb-3.5">
        {chips.map((chip) => (
          <li key={chip}>
            <Badge
              className={cn(
                "text-foreground",
                chipsMono ? "font-mono text-xs" : null
              )}
            >
              {chip}
            </Badge>
          </li>
        ))}
        {moreCount ? (
          <li className="text-muted-foreground px-1.5 text-sm">
            и ещё {moreCount}
          </li>
        ) : null}
      </ul>
    </section>
  );
}
