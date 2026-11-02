"use client";

import { type ChangeEvent, type ReactNode, useCallback } from "react";

import { Badge } from "@/components/ui/badge";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMeta,
  ItemTitle,
} from "@/components/ui/item";
import { NavMenu } from "@/components/ui/nav-item";
import { formatOpenQuestions } from "@/components/ui/row-status";
import { Tabs, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MainWindow } from "@/features/shell/main-window";
import { linkButtonProps } from "@/lib/link-button";
import { cn } from "@/lib/utils";

import { CrossIcon, SearchIcon } from "../icons";
import {
  HISTORY_PROJECTS,
  type HistoryCall,
  type SearchResult,
  TOTAL_CALLS,
} from "../mock";
import { usePostCallLinks } from "./links";
import {
  NavMeta,
  PanelBackLink,
  PanelNavItem,
  PanelSidebar,
} from "./panel-nav";
import { DoneCheck, OpenRing } from "./status-mark";

/*
 * "05 История звонков": the "Grill" window with the history sidebar (all
 * calls and the projects with their call counts) and "Начать звонок" in the
 * title bar.
 */

/** Red recording dot before "Начать звонок". */
function RecordingDot() {
  return (
    <span aria-hidden="true" className="bg-recording size-1.5 rounded-full" />
  );
}

export function StartCallButton({
  className,
  size = "default",
  variant = "default",
  ...props
}: Omit<ButtonProps, "children">) {
  const { Link, startCall } = usePostCallLinks();
  return (
    <Button
      className={cn(size === "lg" && "px-5", className)}
      {...linkButtonProps(startCall, Link)}
      size={size}
      variant={variant}
      {...props}
    >
      <RecordingDot />
      Начать звонок
    </Button>
  );
}

export interface HistoryProject {
  calls: number;
  id: string;
  name: string;
}

export function HistorySidebar({
  active,
  className,
  projects = HISTORY_PROJECTS,
  total = TOTAL_CALLS,
}: {
  /** A project id, or "all". */
  active: string;
  className?: string;
  projects?: HistoryProject[];
  total?: number;
}) {
  const links = usePostCallLinks();
  return (
    <PanelSidebar className={cn("gap-6", className)}>
      {links.back ? <PanelBackLink {...links.back} /> : null}
      <NavMenu aria-label="История">
        <PanelNavItem
          active={active === "all"}
          href={links.allCalls}
          label="Все звонки"
          trailing={<NavMeta>{total}</NavMeta>}
        />
      </NavMenu>
      <div className="flex flex-col gap-0.5">
        <p
          className="text-muted-foreground px-3 pb-1.5 text-sm"
          id="history-projects"
        >
          Проекты
        </p>
        <NavMenu aria-labelledby="history-projects">
          {projects.map((project) => (
            <PanelNavItem
              active={active === project.id}
              href={links.projectCalls(project.id)}
              key={project.id}
              label={project.name}
              trailing={<NavMeta>{project.calls}</NavMeta>}
            />
          ))}
        </NavMenu>
      </div>
    </PanelSidebar>
  );
}

export function HistoryWindow({
  active,
  children,
  className,
  projects,
  total,
}: {
  active: string;
  children: ReactNode;
  className?: string;
  projects?: HistoryProject[];
  total?: number;
}) {
  return (
    <MainWindow
      actions={<StartCallButton />}
      className={className}
      sidebar={
        <HistorySidebar active={active} projects={projects} total={total} />
      }
      title="Grill"
    >
      {children}
    </MainWindow>
  );
}

/** Eyebrow, 40px title and an optional control on the right. */
export function HistoryHeader({
  action,
  className,
  eyebrow,
  title,
}: {
  action?: ReactNode;
  className?: string;
  eyebrow: string;
  title: string;
}) {
  return (
    <header className={cn("flex items-end justify-between gap-6", className)}>
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          {title}
        </h1>
      </div>
      {action}
    </header>
  );
}

/**
 * Bordered search field with an icon. Empty, it shows a shortcut on the
 * right; with a query, a clear button. `data-preview` pins focus in /dev.
 */
export function SearchField({
  className,
  label,
  onQueryChange,
  placeholder,
  preview,
  query,
  shortcut,
}: {
  className?: string;
  label: string;
  /** Makes the field controlled: typing and the clear button report here. */
  onQueryChange?: (query: string) => void;
  placeholder: string;
  preview?: "focus";
  query?: string;
  shortcut?: string;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      onQueryChange?.(event.target.value),
    [onQueryChange]
  );
  const clear = useCallback(() => onQueryChange?.(""), [onQueryChange]);
  const controlled = onQueryChange !== undefined;

  return (
    <InputGroup
      className={cn("h-9 w-[280px] shrink-0", query && "pr-2", className)}
      data-preview={preview}
    >
      <InputGroupAddon>
        <SearchIcon
          className={cn(
            "size-3.5",
            query ? "text-foreground" : "text-muted-foreground"
          )}
        />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        defaultValue={controlled ? undefined : query}
        onChange={controlled ? change : undefined}
        placeholder={placeholder}
        type="search"
        value={controlled ? (query ?? "") : undefined}
      />
      {query ? (
        <InputGroupAddon align="inline-end">
          <button
            aria-label="Очистить поиск"
            className="focus-visible:focus-ring -m-1 flex size-7 items-center justify-center rounded-full"
            onClick={controlled ? clear : undefined}
            type="button"
          >
            <span className="bg-surface text-muted-foreground flex size-5 items-center justify-center rounded-full">
              <CrossIcon className="size-2.5" strokeWidth={1.8} />
            </span>
          </button>
        </InputGroupAddon>
      ) : null}
      {!query && shortcut ? (
        <InputGroupAddon align="inline-end">
          <kbd className="font-mono text-xs">{shortcut}</kbd>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
}

export interface FilterOption {
  accent?: boolean;
  /** Count or start time; a zero count disables the option. */
  count?: number | string;
  id: string;
  label: string;
}

/** Filter pills; options with a zero count are disabled. */
export function FilterTabs({
  className,
  label,
  onValueChange,
  options,
  value = options[0]?.id,
}: {
  className?: string;
  label: string;
  /** Makes the pills controlled. */
  onValueChange?: (value: string) => void;
  options: FilterOption[];
  /** Selected option, the first by default. */
  value?: string;
}) {
  const change = useCallback(
    (next: unknown) => {
      if (typeof next === "string") {
        onValueChange?.(next);
      }
    },
    [onValueChange]
  );
  const controlled = onValueChange !== undefined;

  return (
    <Tabs
      className={className}
      defaultValue={controlled ? undefined : value}
      onValueChange={controlled ? change : undefined}
      value={controlled ? value : undefined}
    >
      <TabsList aria-label={label} size="sm">
        {options.map((option) => (
          <TabsTrigger
            className="data-disabled:text-subtle data-disabled:cursor-default data-disabled:opacity-100"
            disabled={option.count === 0}
            key={option.id}
            value={option.id}
          >
            {option.label}
            {option.count === undefined ? null : (
              <TabsCount
                className="in-data-disabled:text-subtle"
                tone={option.accent ? "accent" : "default"}
              >
                {option.count}
              </TabsCount>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** "Октябрь": month over its calls; later months get a hairline on top. */
export function MonthHeading({
  children,
  className,
  divided = false,
}: {
  children: ReactNode;
  className?: string;
  divided?: boolean;
}) {
  return (
    <h2
      className={cn(
        "text-muted-foreground px-4 pb-2 text-sm font-medium",
        divided && "border-border border-t pt-7",
        className
      )}
    >
      {children}
    </h2>
  );
}

/** "4 открытых" with an orange ring, or "всё закрыто" with a check. */
export function OpenStatus({
  className,
  openCount,
}: {
  className?: string;
  openCount: number;
}) {
  if (openCount === 0) {
    return (
      <span
        className={cn(
          "text-muted-foreground flex items-center gap-1.5 text-sm",
          className
        )}
      >
        <DoneCheck className="size-3.5" />
        всё закрыто
      </span>
    );
  }
  return (
    <span className={cn("flex items-center gap-1.5 text-sm", className)}>
      <OpenRing className="mx-[3px] size-2" />
      {formatOpenQuestions(openCount)}
    </span>
  );
}

/* A history row: whole row is a link, gray on hover, hairline on top */
const HISTORY_ROW =
  "gap-5 rounded-none border-border border-t p-4 hover:rounded-md hover:border-transparent";

function CallDate({ date, time }: { date: string; time: string }) {
  return (
    <span className="flex w-[72px] shrink-0 flex-col">
      <span className="text-base font-medium">{date}</span>
      <span className="text-muted-foreground font-mono text-xs tabular-nums">
        {time}
      </span>
    </span>
  );
}

function CallDuration({
  className,
  duration,
}: {
  className?: string;
  duration: string;
}) {
  return (
    <span
      className={cn(
        "text-muted-foreground w-14 shrink-0 text-right font-mono text-xs tabular-nums",
        className
      )}
    >
      <span className="sr-only">Длительность </span>
      {duration}
    </span>
  );
}

export function HistoryCallRow({
  call,
  className,
  preview,
}: {
  call: HistoryCall;
  className?: string;
  /** Pins the hover state in /dev. */
  preview?: "hover";
}) {
  const { callSummary, Link } = usePostCallLinks();
  return (
    <Item
      className={cn(HISTORY_ROW, className)}
      data-preview={preview}
      render={<Link href={callSummary(call.id)} />}
    >
      <CallDate date={call.date} time={call.time} />
      <ItemContent className="gap-0.5">
        <ItemTitle className="text-lg">{call.title}</ItemTitle>
        <ItemDescription className="text-base">
          {call.participants}
        </ItemDescription>
      </ItemContent>
      <ItemMeta className="w-40 justify-end">
        {call.proposals ? (
          <Badge indicator={false} variant="waiting">
            {call.proposals} предложения
          </Badge>
        ) : null}
      </ItemMeta>
      <ItemActions className="w-[120px] justify-start">
        <OpenStatus openCount={call.openCount} />
      </ItemActions>
      <CallDuration duration={call.duration} />
    </Item>
  );
}

/** The found phrase with the query marked, and where it was said. */
export function MatchQuote({
  className,
  match,
  query,
}: {
  className?: string;
  match: SearchResult["match"];
  query: string;
}) {
  return (
    <span className={cn("flex gap-2.5", className)}>
      <span
        aria-hidden="true"
        className="bg-accent w-0.5 shrink-0 rounded-full"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-base">
          {match.before}
          <mark className="bg-accent-soft text-foreground rounded-[4px] px-0.5 font-semibold">
            {match.text ?? query}
          </mark>
          {match.after}
        </span>
        <span className="text-muted-foreground text-sm">{match.meta}</span>
      </span>
    </span>
  );
}

export function SearchResultRow({
  className,
  query,
  result,
}: {
  className?: string;
  query: string;
  result: SearchResult;
}) {
  const { callTranscript, Link } = usePostCallLinks();
  return (
    <Item
      className={cn(HISTORY_ROW, "items-start", className)}
      render={
        <Link
          href={callTranscript(result.callId ?? result.id, result.moment)}
        />
      }
    >
      <CallDate date={result.date} time={result.time} />
      <ItemContent className="gap-2">
        <span className="flex flex-col gap-0.5">
          <span className="text-muted-foreground text-sm">
            {result.project}
          </span>
          <ItemTitle className="text-lg">{result.title}</ItemTitle>
        </span>
        <MatchQuote match={result.match} query={query} />
      </ItemContent>
      <ItemActions className="h-5 w-[120px] justify-start">
        <OpenStatus openCount={result.openCount} />
      </ItemActions>
      <CallDuration className="leading-5" duration={result.duration} />
    </Item>
  );
}
