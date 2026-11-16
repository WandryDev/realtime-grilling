"use client";

import { useCallback } from "react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { ClaudeIcon } from "@/components/ui/brand-icons";
import { Button } from "@/components/ui/button";
import { linkButtonProps } from "@/lib/link-button";
import { cn } from "@/lib/utils";
import { useCallActions } from "../call-actions";
import { FlagIcon, SpeakerOffIcon } from "../icons";
import type {
  AgentBannerAction,
  AgentBannerData,
  FinalCheckData,
} from "../types";

const BANNER_ICONS = {
  claude: ClaudeIcon,
  "speaker-off": SpeakerOffIcon,
} as const;

/*
 * Agent or audio failure, above the questions: soft red strip, the culprit's
 * logo on a white tile, what still works, the action and when the app will
 * retry by itself.
 */
export function AgentBanner({
  banner,
  className,
}: {
  banner: AgentBannerData;
  className?: string;
}) {
  const Icon = BANNER_ICONS[banner.icon];

  return (
    <div
      className={cn(
        "bg-contradiction-soft flex items-start gap-3.5 rounded-md px-[18px] py-4",
        className
      )}
      role="alert"
    >
      <span
        aria-hidden="true"
        className="bg-background text-contradiction flex size-7 shrink-0 items-center justify-center rounded-xs"
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-base">
        <p className="text-contradiction font-semibold">{banner.title}</p>
        <p>{banner.description}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pt-2.5">
          <div className="flex items-center gap-1">
            {banner.actions.map((action) => (
              <BannerButton action={action} key={action.id ?? action.label} />
            ))}
          </div>
          {banner.hint ? (
            <p className="text-muted-foreground flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
              {banner.hint.text}
              {banner.hint.time ? (
                <span className="font-mono text-xs tabular-nums">
                  {banner.hint.time}
                </span>
              ) : null}
            </p>
          ) : null}
          {banner.footnote ? (
            <p className="text-muted-foreground w-full text-sm">
              {banner.footnote}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BannerButton({ action }: { action: AgentBannerAction }) {
  const { onBannerAction } = useCallActions();
  const onClick = useCallback(() => {
    if (action.id) {
      onBannerAction?.(action.id);
    }
  }, [action.id, onBannerAction]);

  return (
    <Button
      className={cn(
        "text-foreground h-[30px]",
        action.variant === "secondary"
          ? "bg-background hover:bg-background/70 px-3.5"
          : "hover:bg-background/50 px-2.5"
      )}
      onClick={action.href ? undefined : onClick}
      variant={action.variant}
      {...linkButtonProps(action.href)}
    >
      {action.label}
    </Button>
  );
}

/** "Похоже, разговор идёт к концу" on top of the final check. */
export function FinalCheckBanner({
  banner,
  className,
}: {
  banner: FinalCheckData["banner"];
  className?: string;
}) {
  const { onLeaveFinalCheck } = useCallActions();

  return (
    <Alert
      className={cn("*:[svg]:text-foreground items-start px-[18px]", className)}
    >
      <FlagIcon className="mx-0.5 mt-0.5" />
      <AlertTitle className="font-semibold">{banner.title}</AlertTitle>
      <AlertDescription className="text-base">
        {banner.description}
      </AlertDescription>
      <AlertAction>
        <Button onClick={onLeaveFinalCheck} size="sm" variant="secondary">
          {banner.action}
        </Button>
      </AlertAction>
    </Alert>
  );
}
