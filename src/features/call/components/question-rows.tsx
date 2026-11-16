"use client";

import { type KeyboardEvent, useCallback } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Question,
  QuestionAction,
  QuestionAside,
  QuestionContent,
  QuestionDescription,
  QuestionStatus,
  QuestionTitle,
  QuestionTopic,
} from "@/components/ui/question";
import { SourceBadge } from "@/components/ui/source-badge";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import { PinIcon } from "../icons";
import type {
  MainQuestionData,
  OpenQuestionData,
  PinnedQuestionData,
  QuestionQuickAction,
  QuestionTag,
} from "../types";
import { QuestionQuickActions } from "./question-quick-actions";

/** Type tag on the right of a question row. */
export function QuestionTagBadge({
  className,
  tag,
}: {
  className?: string;
  tag: QuestionTag;
}) {
  switch (tag) {
    case "contradiction":
      return (
        <Badge className={className} variant="contradiction">
          противоречие
        </Badge>
      );
    case "assumption":
      return (
        <Badge className={className} variant="assumption">
          допущение
        </Badge>
      );
    case "empty":
      return (
        <Badge className={className} variant="empty">
          пусто
        </Badge>
      );
    case "code":
      return <SourceBadge className={className} source="code" />;
    default:
      return (
        <Badge className={className} variant="neutral">
          ClickUp
        </Badge>
      );
  }
}

/**
 * The row a context card points at («к вопросу …»): found by its question
 * id, ringed in accent while highlighted.
 */
function questionTarget(id: string | undefined, highlighted: boolean) {
  return {
    "data-highlighted": highlighted ? "" : undefined,
    "data-question-id": id,
  };
}

const HIGHLIGHT = "ring-2 ring-accent ring-inset";

/** Single-key shortcuts of the quick actions, while the row has focus. */
const SHORTCUTS: Record<string, QuestionQuickAction> = {
  h: "hide",
  p: "pin",
};

/*
 * An open question as a row: 20px (`default`) in the current topic and the
 * final check, 16px (`compact`) in earlier topics. Default rows reveal the
 * quick actions on hover in place of the tag; with `topicId` and a handler
 * from the call window they act on the question (P pins, H hides).
 */
export function OpenQuestion({
  className,
  frozen = false,
  highlighted = false,
  hovered = false,
  leaving = false,
  onExited,
  pinnable = true,
  question,
  topicId,
  variant = "default",
}: {
  className?: string;
  /** The agent stopped: the title grays out and the actions go away. */
  frozen?: boolean;
  /** A context card pointed at it. */
  highlighted?: boolean;
  /** Pin the hover state for the static screen. */
  hovered?: boolean;
  /** Gone from the list: plays the exit, then `onExited` with its id. */
  leaving?: boolean;
  onExited?: (questionId: string) => void;
  /** Offer "Закрепить"; the final check list doesn't. */
  pinnable?: boolean;
  question: OpenQuestionData;
  /** Topic the row belongs to, passed to the quick action handler. */
  topicId?: string;
  variant?: "default" | "compact";
}) {
  const withActions = variant === "default" && !frozen;
  const { onQuestionAction } = useCallActions();
  const canAct = withActions && topicId !== undefined && onQuestionAction;

  const exited = useCallback(
    () => onExited?.(question.id),
    [onExited, question.id]
  );

  const act = useCallback(
    (action: QuestionQuickAction) => {
      if (topicId !== undefined) {
        onQuestionAction?.(topicId, question.id, action);
      }
    },
    [onQuestionAction, question.id, topicId]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const action = SHORTCUTS[event.key.toLowerCase()];
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (!action || modified || (action === "pin" && !pinnable)) {
        return;
      }
      event.preventDefault();
      act(action);
    },
    [act, pinnable]
  );

  return (
    <Question
      className={cn(
        question.topic && "py-4",
        highlighted && HIGHLIGHT,
        className
      )}
      data-preview={hovered ? "hover" : undefined}
      {...questionTarget(question.id, highlighted)}
      leaving={leaving}
      onExited={exited}
      onKeyDown={canAct ? onKeyDown : undefined}
      variant={variant}
    >
      <QuestionContent>
        {question.topic ? (
          <QuestionTopic className="font-normal">
            {question.topic}
          </QuestionTopic>
        ) : null}
        <QuestionTitle className={cn(frozen && "text-muted-foreground")}>
          {question.title}
        </QuestionTitle>
        <QuestionDescription>{question.description}</QuestionDescription>
      </QuestionContent>
      {question.tag ? (
        <QuestionAside
          className={cn(
            withActions &&
              "group-focus-within/question:hidden group-hover/question:hidden"
          )}
        >
          <QuestionTagBadge tag={question.tag} />
        </QuestionAside>
      ) : null}
      {withActions ? (
        <QuestionQuickActions
          onAction={canAct ? act : undefined}
          pinnable={pinnable}
          preview={hovered}
        />
      ) : null}
    </Question>
  );
}

/** The one main question: soft orange card, 28px title. */
export function MainQuestion({
  className,
  frozen = false,
  highlighted = false,
  question,
}: {
  className?: string;
  frozen?: boolean;
  /** A context card pointed at it. */
  highlighted?: boolean;
  question: MainQuestionData;
}) {
  return (
    <Question
      className={cn(highlighted && HIGHLIGHT, className)}
      variant="main"
      {...questionTarget(question.id, highlighted)}
    >
      <QuestionContent>
        <QuestionStatus>{question.status}</QuestionStatus>
        <QuestionTitle className={cn(frozen && "text-muted-foreground")}>
          {question.title}
        </QuestionTitle>
        <QuestionDescription>{question.description}</QuestionDescription>
      </QuestionContent>
    </Question>
  );
}

/** Pinned by you: gray plate above the main question, "Открепить". */
export function PinnedQuestion({
  className,
  highlighted = false,
  question,
  topicId,
}: {
  className?: string;
  /** A context card pointed at it. */
  highlighted?: boolean;
  question: PinnedQuestionData;
  topicId?: string;
}) {
  const { onUnpin } = useCallActions();
  const unpin = useCallback(() => {
    if (topicId !== undefined) {
      onUnpin?.(topicId);
    }
  }, [onUnpin, topicId]);

  return (
    <Question
      className={cn("bg-surface py-4", highlighted && HIGHLIGHT, className)}
      {...questionTarget(question.id, highlighted)}
    >
      <QuestionContent>
        <QuestionTopic className="gap-1.5 pb-1 font-normal">
          <PinIcon className="size-[13px] shrink-0" strokeWidth={1.6} />
          {question.label}
        </QuestionTopic>
        <QuestionTitle>{question.title}</QuestionTitle>
        <QuestionDescription>{question.description}</QuestionDescription>
      </QuestionContent>
      <QuestionAside>
        <QuestionAction onClick={unpin}>Открепить</QuestionAction>
      </QuestionAside>
    </Question>
  );
}
