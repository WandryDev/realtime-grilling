"use client";

import { Kbd } from "@grill/ui/kbd";
import { QuestionAction, QuestionActions } from "@grill/ui/question";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  tooltipSurfaceClassName,
} from "@grill/ui/tooltip";
import { type ReactElement, useCallback } from "react";
import { cn } from "@/lib/utils";

import { CheckIcon, EyeOffIcon, PinIcon } from "../icons";
import type { QuestionQuickAction } from "../types";

const ICON_ACTION_CLASS =
  "shadow-touch hover:bg-background hover:ring-1 hover:ring-foreground/10";

/** Paper: the hint shows up half a second after the pointer stops. */
const TOOLTIP_DELAY = 500;

const PIN_LABEL = "Закрепить наверху темы";
const HIDE_LABEL = "Скрыть вопрос";

/*
 * Quick actions of an open question, revealed on hover or keyboard focus in
 * place of its tag: "Уже спросил", pin (P) and hide (H).
 *
 * `preview` pins the hover look for the static screen: the pin button in its
 * hover state with the tooltip drawn above it. Otherwise the icon buttons get
 * real tooltips. `pinnable={false}` drops the pin (the final check list).
 */
export function QuestionQuickActions({
  className,
  onAction,
  pinnable = true,
  preview = false,
}: {
  className?: string;
  onAction?: (action: QuestionQuickAction) => void;
  pinnable?: boolean;
  preview?: boolean;
}) {
  const asked = useCallback(() => onAction?.("asked"), [onAction]);
  const pin = useCallback(() => onAction?.("pin"), [onAction]);
  const hide = useCallback(() => onAction?.("hide"), [onAction]);

  return (
    <QuestionActions className={cn("items-center", className)}>
      <QuestionAction
        className="shadow-touch px-3"
        onClick={asked}
        size="default"
      >
        <CheckIcon className="size-3.5" />
        Уже спросил
      </QuestionAction>
      {pinnable ? (
        <span className="relative flex">
          <WithTooltip label={PIN_LABEL} preview={preview} shortcut="P">
            <QuestionAction
              aria-keyshortcuts="P"
              aria-label={PIN_LABEL}
              className={ICON_ACTION_CLASS}
              data-preview={preview ? "hover" : undefined}
              onClick={pin}
              size="icon"
            >
              <PinIcon />
            </QuestionAction>
          </WithTooltip>
          {preview ? <StaticTooltip label={PIN_LABEL} shortcut="P" /> : null}
        </span>
      ) : null}
      <WithTooltip label={HIDE_LABEL} preview={preview} shortcut="H">
        <QuestionAction
          aria-keyshortcuts="H"
          aria-label={HIDE_LABEL}
          className={cn(
            ICON_ACTION_CLASS,
            "text-muted-foreground hover:text-foreground"
          )}
          onClick={hide}
          size="icon"
        >
          <EyeOffIcon />
        </QuestionAction>
      </WithTooltip>
    </QuestionActions>
  );
}

/** A real tooltip with the shortcut; the static preview draws its own. */
function WithTooltip({
  children,
  label,
  preview,
  shortcut,
}: {
  children: ReactElement;
  label: string;
  preview: boolean;
  shortcut: string;
}) {
  if (preview) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger delay={TOOLTIP_DELAY} render={children} />
      <TooltipContent>
        {label}
        <Kbd>{shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** The tooltip drawn in place above its button, with the arrow from Paper. */
function StaticTooltip({
  label,
  shortcut,
}: {
  label: string;
  shortcut: string;
}) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 flex -translate-x-1/2 flex-col items-center"
    >
      <span
        className={cn(
          tooltipSurfaceClassName,
          "px-3 py-[7px] whitespace-nowrap"
        )}
        data-slot="tooltip-content"
      >
        {label}
        <Kbd>{shortcut}</Kbd>
      </span>
      <svg
        aria-hidden="true"
        className="fill-foreground"
        height="6"
        viewBox="0 0 12 6"
        width="12"
      >
        <path d="M0 0L6 6L12 0Z" />
      </svg>
    </span>
  );
}
