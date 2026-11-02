"use client";

import { type ReactNode, useCallback } from "react";

import { AppWindowPanel } from "@/components/ui/app-window";
import { AgentStatus } from "@/components/ui/recording-indicator";
import { TopicAnchor } from "@/components/ui/topic-anchor";
import { cn } from "@/lib/utils";

import type { AgentStatusData, TopicAnchorData } from "../types";

/*
 * The white panel in the middle of the call window. It scrolls on its own;
 * the topic anchors stay pinned to its top edge.
 */
export function QuestionsPanel({
  children,
  className,
  nav,
}: {
  children: ReactNode;
  className?: string;
  nav: ReactNode;
}) {
  return (
    <AppWindowPanel
      className={cn("gap-2 overflow-y-auto px-8 pb-9", className)}
    >
      <h2 className="sr-only">Вопросы</h2>
      {nav}
      {children}
    </AppWindowPanel>
  );
}

/** Id of the section an anchor scrolls to. */
export function topicSectionId(prefix: string, topicId: string) {
  return `${prefix}-topic-${topicId}`;
}

/**
 * Sticky row of topic anchors with the agent status on the right. With
 * `sectionIdPrefix` an anchor scrolls the panel to its topic.
 */
export function QuestionsNav({
  agent,
  anchors,
  className,
  sectionIdPrefix,
}: {
  agent: AgentStatusData;
  anchors: TopicAnchorData[];
  className?: string;
  sectionIdPrefix?: string;
}) {
  return (
    <div
      className={cn(
        "border-border bg-background sticky top-0 z-10 flex items-center justify-between gap-4 border-b pt-4 pb-3.5",
        className
      )}
    >
      <nav
        aria-label="Темы звонка"
        className="flex min-w-0 items-center gap-1.5"
      >
        {anchors.map((anchor) => (
          <AnchorButton
            anchor={anchor}
            key={anchor.id}
            sectionIdPrefix={sectionIdPrefix}
          />
        ))}
      </nav>
      <AgentStatus state={agent.state} tone={agent.tone}>
        {agent.label}
      </AgentStatus>
    </div>
  );
}

function AnchorButton({
  anchor,
  sectionIdPrefix,
}: {
  anchor: TopicAnchorData;
  sectionIdPrefix?: string;
}) {
  const scrollToTopic = useCallback(() => {
    if (!sectionIdPrefix) {
      return;
    }
    // useId ids carry colons, so the selector needs escaping
    const id = CSS.escape(topicSectionId(sectionIdPrefix, anchor.id));
    document
      .querySelector(`#${id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [anchor.id, sectionIdPrefix]);

  return (
    <TopicAnchor
      active={anchor.active}
      count={anchor.count}
      countTone={anchor.countTone}
      onClick={scrollToTopic}
    >
      {anchor.label}
    </TopicAnchor>
  );
}

/*
 * A topic block: its header and the questions under it.
 * - `current`: the topic under discussion, header with more air.
 * - `divided`: earlier topics and "Без темы", a hairline on top.
 * - `plain`: the final check list.
 */
export function TopicSection({
  children,
  className,
  id,
  meta,
  title,
  variant = "current",
}: {
  children: ReactNode;
  className?: string;
  /** Target of the topic anchor. */
  id?: string;
  meta: ReactNode;
  title: ReactNode;
  variant?: "current" | "divided" | "plain";
}) {
  return (
    <section
      className={cn(
        "flex scroll-mt-16 flex-col",
        variant === "divided" ? "border-border gap-1 border-t" : "gap-2",
        className
      )}
      id={id}
    >
      <TopicHeader
        className={variant === "current" ? "pt-7 pb-3" : undefined}
        meta={meta}
        title={title}
      />
      {children}
    </section>
  );
}

/** 28px topic name and a muted note on the right, on one baseline. */
export function TopicHeader({
  className,
  meta,
  title,
}: {
  className?: string;
  meta: ReactNode;
  title: ReactNode;
}) {
  return (
    <header
      className={cn(
        "flex items-baseline justify-between gap-4 px-1 pt-5 pb-2",
        className
      )}
    >
      <h3 className="text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h3>
      <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
        {meta}
      </p>
    </header>
  );
}
