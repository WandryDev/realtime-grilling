"use client";

import type { ReactNode } from "react";

import { AppWindow, AppWindowBody } from "@/components/ui/app-window";
import { Button } from "@/components/ui/button";
import { RecordingIndicator } from "@/components/ui/recording-indicator";
import {
  WindowSubtitle,
  WindowTitle,
  WindowTitlebar,
  WindowTitlebarEnd,
  WindowTitlebarStart,
} from "@/components/ui/window-titlebar";
import {
  WindowChromeEnd,
  WindowChromeStart,
} from "@/features/shell/window-chrome";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import type { CallInfo } from "../types";

/*
 * The call window, 1440 wide: title bar with the project and the recording,
 * then three columns on the window gray: transcript, the white questions
 * panel, context. Columns scroll on their own; the window size comes from
 * the call site (`size-full` in /dev/screens, auto height for the reference).
 *
 *   <CallWindow
 *     titlebar={<CallTitlebar call={call} />}
 *     transcript={<TranscriptColumn>…</TranscriptColumn>}
 *     questions={<QuestionsPanel nav={…}>…</QuestionsPanel>}
 *     context={<ContextColumn description="найдено по ходу">…</ContextColumn>}
 *   />
 */
export function CallWindow({
  className,
  context,
  dimmed = false,
  overlay,
  questions,
  titlebar,
  transcript,
}: {
  className?: string;
  context: ReactNode;
  /** The call is over: columns fade to 30% and stop taking input. */
  dimmed?: boolean;
  /** Panels drawn over the window, positioned by the caller. */
  overlay?: ReactNode;
  questions: ReactNode;
  titlebar: ReactNode;
  transcript: ReactNode;
}) {
  return (
    <AppWindow className={cn("relative", className)}>
      {titlebar}
      <AppWindowBody className={cn(dimmed && "opacity-30")} inert={dimmed}>
        {transcript}
        {questions}
        {context}
      </AppWindowBody>
      {overlay}
    </AppWindow>
  );
}

/** Project and participants on the left, recording and "Завершить". */
export function CallTitlebar({
  call,
  className,
}: {
  call: CallInfo;
  className?: string;
}) {
  const stopped = call.recording === "stopped";
  const { onEnd } = useCallActions();

  return (
    <WindowTitlebar className={className}>
      <WindowTitlebarStart>
        <WindowChromeStart />
        <WindowTitle>
          {call.project}
          <WindowSubtitle>{call.participants}</WindowSubtitle>
        </WindowTitle>
      </WindowTitlebarStart>
      <WindowTitlebarEnd>
        <RecordingIndicator
          aria-label={
            stopped
              ? `Запись остановлена, ${call.time}`
              : `Идёт запись, ${call.time}`
          }
          className={cn(
            stopped && "[&_[data-slot=recording-indicator-dot]]:bg-subtle"
          )}
          level={stopped ? null : call.level}
          time={call.time}
          warning={stopped ? null : call.warning}
        />
        {call.endAction === "hidden" ? null : (
          <Button
            className={cn(
              call.endAction === "secondary" && "bg-background hover:bg-border"
            )}
            onClick={onEnd}
            variant={call.endAction === "primary" ? "default" : "secondary"}
          >
            Завершить
          </Button>
        )}
        <WindowChromeEnd />
      </WindowTitlebarEnd>
    </WindowTitlebar>
  );
}
