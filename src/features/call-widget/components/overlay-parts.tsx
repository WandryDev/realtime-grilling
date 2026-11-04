"use client";

import { type ComponentProps, type ReactNode, useCallback } from "react";

import { Button } from "@/components/ui/button";
import { Counter } from "@/components/ui/counter";
import {
  Question,
  QuestionAction,
  QuestionActions,
  QuestionContent,
  QuestionDescription,
  QuestionStatus,
  QuestionTitle,
  QuestionTopic,
} from "@/components/ui/question";
import {
  RecordingIndicator,
  type RecordingLevel,
} from "@/components/ui/recording-indicator";
import { RowStatus } from "@/components/ui/row-status";
import { cn } from "@/lib/utils";
import { CollapseIcon, ExpandIcon, EyeOffIcon } from "../icons";
import type { OverlayQuestionItem } from "../mock";
import { ActionButton } from "./action-button";

/*
 * Draggable 40px header of the compact overlay: recording time and the
 * project, then "open the call window" and "collapse to the pill".
 */
export function OverlayHeader({
  callHref,
  className,
  level,
  onCollapse,
  project,
  time,
  warning,
  ...props
}: ComponentProps<"div"> & {
  /** Where the arrows lead: the call window. */
  callHref?: string;
  /** Live levels next to the recording dot. */
  level?: RecordingLevel | null;
  onCollapse?: () => void;
  project: string;
  time: string;
  /** A channel that doesn't capture, on the recording indicator. */
  warning?: string | null;
}) {
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center justify-between gap-2 pr-1 pl-4",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-2">
        <RecordingIndicator
          level={level}
          time={time}
          variant="inline"
          warning={warning}
        />
        <span className="truncate text-sm font-semibold">{project}</span>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <ActionButton
          aria-label="Открыть окно звонка"
          href={callHref}
          size="icon-sm"
          variant="ghost"
        >
          <ExpandIcon />
        </ActionButton>
        <Button
          aria-label="Свернуть в пилюлю"
          onClick={onCollapse}
          size="icon-sm"
          variant="ghost"
        >
          <CollapseIcon />
        </Button>
      </div>
    </div>
  );
}

/**
 * The overlay's title block: the current topic (with "прошлые" on the
 * right) or, in the final check, a flag, the title and a muted line.
 */
export function OverlayHeading({
  action,
  className,
  description,
  icon,
  title,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  action?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  title: ReactNode;
}) {
  return (
    <div
      className={cn("flex flex-col gap-1 px-4 pt-1.5 pb-2", className)}
      {...props}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <h1 className="text-xl font-semibold tracking-tight text-balance">
            {title}
          </h1>
        </div>
        {action}
      </div>
      {description ? (
        <p className="text-muted-foreground text-sm">{description}</p>
      ) : null}
    </div>
  );
}

/** "прошлые 2": open questions left in earlier topics. */
export function PastTopicsButton({
  className,
  count,
  href,
}: {
  className?: string;
  count: number;
  /** They are listed in the call window. */
  href?: string;
}) {
  return (
    <ActionButton
      className={cn("text-muted-foreground px-2.5 font-normal", className)}
      href={href}
      size="sm"
      variant="secondary"
    >
      прошлые
      <Counter>{count}</Counter>
    </ActionButton>
  );
}

const HIDE_LABEL = "Скрыть вопрос";

/**
 * "Скрыть вопрос", revealed on hover or keyboard focus of its question:
 * the agent won't suggest it again, the call window lists it as hidden.
 */
function HideAction({ onHide }: { onHide: () => void }) {
  return (
    <QuestionActions className="items-center">
      <QuestionAction
        aria-label={HIDE_LABEL}
        className="text-muted-foreground hover:text-foreground"
        onClick={onHide}
        size="icon-sm"
        title={HIDE_LABEL}
      >
        <EyeOffIcon />
      </QuestionAction>
    </QuestionActions>
  );
}

/*
 * The newest question on a soft orange card, a step smaller than in the call
 * window: 16px padding, 20px title. `label` is "Новый, только что" or, in
 * the final check, the question's topic. With `onHide` it offers
 * "Скрыть вопрос".
 */
export function OverlayMainQuestion({
  className,
  label,
  onHide,
  title,
}: {
  className?: string;
  label: ReactNode;
  onHide?: () => void;
  title: ReactNode;
}) {
  return (
    <Question className={cn("rounded-md p-4", className)} variant="main">
      <QuestionContent className="gap-1.5">
        <QuestionStatus className="gap-1.5 [&>span]:size-1.5">
          {label}
        </QuestionStatus>
        <QuestionTitle className="text-xl font-semibold tracking-tight">
          {title}
        </QuestionTitle>
      </QuestionContent>
      {onHide ? <HideAction onHide={onHide} /> : null}
    </Question>
  );
}

/** Where the main question would be: the agent is still listening. */
export function OverlayListening({ className }: { className?: string }) {
  return (
    <p className={cn("text-muted-foreground px-4 py-3 text-base", className)}>
      Слушаю. Вопросы появятся, когда станет понятна тема.
    </p>
  );
}

/**
 * A compact question row: topic (final check), title, mark or reason.
 * With `onHide` it offers "Скрыть вопрос".
 */
export function OverlayQuestion({
  className,
  onHide,
  question,
}: {
  className?: string;
  onHide?: (id: string) => void;
  question: OverlayQuestionItem;
}) {
  const hide = useCallback(() => onHide?.(question.id), [onHide, question.id]);
  return (
    <Question className={cn("px-4", className)} variant="compact">
      <QuestionContent>
        {question.topic ? (
          <QuestionTopic className="font-normal">
            {question.topic}
          </QuestionTopic>
        ) : null}
        <QuestionTitle>{question.title}</QuestionTitle>
        {question.mark === "contradiction" ? (
          <RowStatus dot tone="contradiction">
            противоречие
          </RowStatus>
        ) : null}
        {question.description ? (
          <QuestionDescription>{question.description}</QuestionDescription>
        ) : null}
      </QuestionContent>
      {onHide ? <HideAction onHide={hide} /> : null}
    </Question>
  );
}

/*
 * 36px footer under a hairline: the agent's status or a hint on the left,
 * "не видно в демонстрации" on the right (the overlay is excluded from
 * screen sharing).
 */
export function OverlayFooter({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "border-border flex h-9 shrink-0 items-center justify-between gap-3 border-t px-4",
        className
      )}
      {...props}
    >
      {children}
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-sm">
        <EyeOffIcon className="size-3.5" />
        не видно в демонстрации
      </span>
    </div>
  );
}
