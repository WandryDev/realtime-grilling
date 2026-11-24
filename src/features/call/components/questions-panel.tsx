"use client";

import { AppWindowPanel } from "@grill/ui/app-window";
import { AgentStatus } from "@grill/ui/recording-indicator";
import { TopicAnchor } from "@grill/ui/topic-anchor";
import { type MouseEvent, type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";

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

/**
 * Scrolls the questions list to a question (its row carries
 * `data-question-id`); nothing when it isn't on the screen.
 */
export function scrollToQuestion(questionId: string) {
  const id = CSS.escape(questionId);
  const row = document.querySelector(`[data-question-id="${id}"]`);
  row?.scrollIntoView?.({ behavior: "smooth", block: "center" });
}

/** Id of the section an anchor scrolls to. */
export function topicSectionId(prefix: string, topicId: string) {
  return `${prefix}-topic-${topicId}`;
}

/**
 * Sticky row of topic anchors with the agent status on the right. With
 * `sectionIdPrefix` an anchor scrolls the panel to its topic. After
 * "Вернуться к темам" the last anchor brings the final check back
 * (`finalCheckCount`). `usage` is the share of the Claude limit, muted
 * before the status.
 */
export function QuestionsNav({
  agent,
  anchors,
  className,
  finalCheckCount,
  hideStatus = false,
  sectionIdPrefix,
  usage,
}: {
  agent: AgentStatusData;
  anchors: TopicAnchorData[];
  className?: string;
  finalCheckCount?: number;
  /** The panel says it listens itself (the empty state): no status here. */
  hideStatus?: boolean;
  sectionIdPrefix?: string;
  usage?: string;
}) {
  const { onReturnToFinalCheck } = useCallActions();

  return (
    <div
      className={cn(
        "border-border bg-background sticky top-0 z-10 flex items-start justify-between gap-2 border-b pt-4 pb-3.5",
        className
      )}
      data-slot="questions-nav"
    >
      {/*
       * Anchors that don't fit move to a second row, never under the status.
       * Many rows in a narrow window scroll inside, so the sticky bar never
       * covers the questions.
       */}
      <nav
        aria-label="Темы звонка"
        className="flex max-h-[30svh] min-w-0 flex-wrap items-center gap-1.5 overflow-y-auto"
      >
        {anchors.map((anchor) => (
          <AnchorButton
            anchor={anchor}
            key={anchor.id}
            sectionIdPrefix={sectionIdPrefix}
          />
        ))}
        {finalCheckCount === undefined ? null : (
          <TopicAnchor
            count={finalCheckCount}
            countTone="neutral"
            onClick={onReturnToFinalCheck}
          >
            К финальной проверке
          </TopicAnchor>
        )}
      </nav>
      {/* On the first row of anchors when they wrap */}
      <div className="flex h-8 shrink-0 items-center gap-3">
        {usage ? (
          <span
            className="text-muted-foreground text-sm whitespace-nowrap tabular-nums"
            title="Сколько использовано из лимита подписки Claude"
          >
            {usage}
          </span>
        ) : null}
        {hideStatus ? null : (
          <AgentStatus state={agent.state} tone={agent.tone}>
            {agent.label}
          </AgentStatus>
        )}
      </div>
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
  const scrollToTopic = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      if (!sectionIdPrefix) {
        return;
      }
      // useId ids carry colons, so the selector needs escaping
      const id = CSS.escape(topicSectionId(sectionIdPrefix, anchor.id));
      const section = document.querySelector<HTMLElement>(`#${id}`);
      if (!section) {
        return;
      }
      // The sticky bar grows as its anchors wrap: the topic's title lands
      // under it, never behind it (`scroll-mt-16` is the one-row height).
      const bar = event.currentTarget.closest("[data-slot=questions-nav]");
      if (bar) {
        section.style.scrollMarginTop = `${bar.getBoundingClientRect().height}px`;
      }
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [anchor.id, sectionIdPrefix]
  );

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
 * - `earlier`: earlier topics and "Без темы", set apart by 32px on top.
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
  variant?: "current" | "earlier" | "plain";
}) {
  return (
    <section
      className={cn(
        "flex scroll-mt-16 flex-col",
        variant === "earlier" ? "gap-1 pt-8" : "gap-2",
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

/**
 * 28px topic name and a muted note on the right, on one baseline; the note
 * goes under the name when both don't fit.
 */
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
        "flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 pt-5 pb-2",
        className
      )}
    >
      <h3 className="min-w-0 text-2xl font-semibold tracking-tight text-balance">
        {title}
      </h3>
      <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
        {meta}
      </p>
    </header>
  );
}
