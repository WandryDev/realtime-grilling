"use client";

import { type ReactNode, useCallback } from "react";

import { Badge } from "@/components/ui/badge";
import {
  ClaudeIcon,
  ClickUpIcon,
  GitHubIcon,
  OutlineIcon,
} from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import {
  ContextCard,
  ContextCardBody,
  ContextCardCode,
  ContextCardHeader,
  ContextCardHeading,
  ContextCardMeta,
  ContextCardQuestionLink,
  ContextCardQuote,
  ContextCardQuoteMeta,
  ContextCardSearching,
  ContextCardSource,
  ContextCardTime,
  ContextCardTitle,
  ContextColumnDescription,
  ContextColumnHeader,
  type ContextSource,
  contextCardSourceVariants,
} from "@/components/ui/context-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import { CheckIcon } from "../icons";
import type { ContextItem } from "../types";

/** Right column, 320 wide on the window gray: "Контекст" and the cards. */
export function ContextColumn({
  children,
  className,
  description,
}: {
  children: ReactNode;
  className?: string;
  description: ReactNode;
}) {
  return (
    <section
      aria-label="Контекст"
      className={cn(
        "flex w-80 shrink-0 flex-col gap-2.5 overflow-y-auto px-2 py-3",
        className
      )}
    >
      <ContextColumnHeader>
        <h2 className="font-semibold">Контекст</h2>
        <ContextColumnDescription>{description}</ContextColumnDescription>
      </ContextColumnHeader>
      {children}
    </section>
  );
}

export function ContextItemView({ item }: { item: ContextItem }) {
  switch (item.kind) {
    case "searching":
      return <ContextCardSearching>{item.text}</ContextCardSearching>;
    case "unavailable":
      return <UnavailableSourceCard item={item} />;
    case "brief":
      return <BriefLoadingCard meta={item.meta} title={item.title} />;
    case "sources":
      return <SourceStatusList className="pt-1.5" sources={item.items} />;
    default:
      return <FindingCard finding={item} />;
  }
}

/** What the agent found: GitHub code, a ClickUp task, an Outline doc. */
export function FindingCard({
  className,
  finding,
}: {
  className?: string;
  finding: Extract<ContextItem, { kind: "finding" }>;
}) {
  return (
    <ContextCard className={className}>
      <ContextCardHeader>
        <ContextCardSource source={finding.source} />
        <ContextCardHeading>
          <ContextCardTitle>{finding.title}</ContextCardTitle>
          <ContextCardMeta mono={finding.metaMono}>
            {finding.meta}
          </ContextCardMeta>
        </ContextCardHeading>
        {finding.time ? (
          <ContextCardTime>{finding.time}</ContextCardTime>
        ) : null}
        {finding.status ? (
          <Badge className="h-[22px] px-2" variant="waiting">
            {finding.status}
          </Badge>
        ) : null}
      </ContextCardHeader>
      {finding.body ? (
        <ContextCardBody className={cn(finding.bodyStrong && "font-medium")}>
          {finding.body}
        </ContextCardBody>
      ) : null}
      {finding.code ? <ContextCardCode>{finding.code}</ContextCardCode> : null}
      {finding.quote ? (
        <ContextCardQuote>
          {finding.quoteMeta ? (
            <ContextCardQuoteMeta>{finding.quoteMeta}</ContextCardQuoteMeta>
          ) : null}
          {finding.quote}
        </ContextCardQuote>
      ) : null}
      {finding.questionLink ? (
        <ContextCardQuestionLink>
          {finding.questionLink}
        </ContextCardQuestionLink>
      ) : null}
    </ContextCard>
  );
}

/**
 * The integration stopped answering: only its card changes, the rest of
 * the call goes on. Faded logo, red "нет доступа", a reconnect button.
 */
export function UnavailableSourceCard({
  className,
  item,
}: {
  className?: string;
  item: Extract<ContextItem, { kind: "unavailable" }>;
}) {
  const { onReconnect } = useCallActions();
  const reconnect = useCallback(
    () => onReconnect?.(item.id),
    [item.id, onReconnect]
  );

  return (
    <ContextCard className={className}>
      <ContextCardHeader>
        <ContextCardSource className="opacity-50" source={item.source} />
        <ContextCardHeading>
          <ContextCardTitle>{item.title}</ContextCardTitle>
          <ContextCardMeta mono>{item.meta}</ContextCardMeta>
        </ContextCardHeading>
        <Badge className="h-[22px] px-2" variant="contradiction">
          {item.status}
        </Badge>
      </ContextCardHeader>
      <ContextCardBody>{item.body}</ContextCardBody>
      <div className="flex flex-col gap-2">
        <Button
          className="w-full"
          loading={item.pending}
          onClick={reconnect}
          variant="secondary"
        >
          {item.action}
        </Button>
        <p className="text-muted-foreground text-sm">{item.note}</p>
      </div>
    </ContextCard>
  );
}

/** The project brief while it is being refreshed: skeleton lines. */
export function BriefLoadingCard({
  className,
  meta,
  title,
}: {
  className?: string;
  meta: string;
  title: string;
}) {
  return (
    <ContextCard
      aria-busy="true"
      className={cn("shadow-card gap-3.5", className)}
    >
      <ContextCardHeader>
        <span aria-hidden="true" className={contextCardSourceVariants()}>
          <ClaudeIcon />
        </span>
        <ContextCardHeading>
          <ContextCardTitle>{title}</ContextCardTitle>
          <ContextCardMeta>{meta}</ContextCardMeta>
        </ContextCardHeading>
        <Spinner className="text-foreground [&_[data-slot=spinner-track]]:stroke-border" />
      </ContextCardHeader>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-full" tone="surface" />
        <Skeleton className="h-2.5 w-[86%]" tone="surface" />
        <Skeleton className="h-2.5 w-[64%]" tone="surface" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-2.5 w-[92%]" tone="surface" />
        <Skeleton className="h-2.5 w-[48%]" tone="surface" />
      </div>
    </ContextCard>
  );
}

const SOURCE_ICONS: Record<ContextSource, typeof GitHubIcon> = {
  clickup: ClickUpIcon,
  github: GitHubIcon,
  outline: OutlineIcon,
};

/** Sources the brief is read from, with what each is doing right now. */
export function SourceStatusList({
  className,
  sources,
}: {
  className?: string;
  sources: Extract<ContextItem, { kind: "sources" }>["items"];
}) {
  return (
    <ul
      aria-label="Источники брифа"
      className={cn("flex flex-col gap-0.5", className)}
    >
      {sources.map((source) => {
        const Icon = SOURCE_ICONS[source.source];
        return (
          <li className="flex items-center gap-2.5 p-2" key={source.id}>
            <span
              aria-hidden="true"
              className="bg-background flex size-7 shrink-0 items-center justify-center rounded-xs"
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-sm">{source.name}</span>
            <span
              className={cn(
                "flex shrink-0 items-center gap-1.5 text-sm",
                source.done ? "text-confirmed" : "text-muted-foreground"
              )}
            >
              {source.done ? (
                <CheckIcon className="size-3" strokeWidth={1.8} />
              ) : null}
              {source.status}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
