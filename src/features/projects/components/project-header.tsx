import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { MoreIcon, PencilIcon } from "../icons";
import type { SourceStatusItem } from "../mock";
import { SourceMark } from "./source-mark";

/*
 * Head of the project page: the name and description with "Изменить" and
 * the "⋯" menu, then one line with the state of every source.
 */
export function ProjectHeader({
  actions,
  className,
  description,
  name,
}: {
  /** "Изменить" and "⋯"; static buttons when not set (the preview). */
  actions?: ReactNode;
  className?: string;
  description: string;
  name: string;
}) {
  return (
    <header className={cn("flex items-start justify-between gap-6", className)}>
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">
          {name}
        </h1>
        <p className="text-muted-foreground max-w-[760px] text-base">
          {description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions ?? (
          <>
            <Button className="h-9" variant="secondary">
              <PencilIcon className="size-3.5" />
              Изменить
            </Button>
            <Button
              aria-label="Ещё"
              className="size-9"
              size="icon"
              variant="secondary"
            >
              <MoreIcon />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

/**
 * "Outline Телемедиа, 48 документов ●" for every source, then the sync
 * time. On a narrow panel the sources wrap, each kept on one line.
 */
export function SourcesStatus({
  className,
  sources,
  synced,
}: {
  className?: string;
  sources: SourceStatusItem[];
  synced: string;
}) {
  if (sources.length === 0) {
    return (
      <p className={cn("text-muted-foreground text-sm", className)}>
        Источники не подключены, агент работает по описанию и заметкам
      </p>
    );
  }
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-2 text-sm",
        className
      )}
    >
      <ul
        aria-label="Источники"
        className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2"
      >
        {sources.map((source) => {
          const isError = source.health === "error";
          return (
            <li
              className="flex max-w-full min-w-0 items-center gap-2"
              key={source.kind}
            >
              <SourceMark className="shrink-0" kind={source.kind} />
              <span className="text-foreground shrink-0">{source.name}</span>
              <span
                className={cn(
                  "min-w-0 truncate",
                  isError ? "text-contradiction" : "text-muted-foreground"
                )}
                title={source.detail}
              >
                {source.detail}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  isError ? "bg-contradiction" : "bg-confirmed"
                )}
              />
              {isError ? null : <span className="sr-only">, подключено</span>}
            </li>
          );
        })}
      </ul>
      <p className="text-muted-foreground">{synced}</p>
    </div>
  );
}

/**
 * Orange strip: suggestions after a call wait for review. Shown only while
 * there are unreviewed ones.
 */
export function ProposalsBanner({
  action,
  className,
  detail,
  title,
}: {
  action: ReactNode;
  className?: string;
  detail: string;
  title: string;
}) {
  return (
    <Alert
      className={cn("gap-x-3.5 py-3 pr-3 pl-5", className)}
      variant="warning"
    >
      <svg aria-hidden="true" className="size-2" viewBox="0 0 8 8">
        <circle className="fill-accent" cx="4" cy="4" r="4" />
      </svg>
      <AlertTitle className="text-base font-medium">{title}</AlertTitle>
      <AlertDescription className="text-sm">{detail}</AlertDescription>
      <div
        className="col-start-3 row-span-2 row-start-1 flex"
        data-slot="alert-action"
      >
        {action}
      </div>
    </Alert>
  );
}
