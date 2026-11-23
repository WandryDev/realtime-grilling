"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
} from "react";

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
import {
  useWindowColumn,
  WindowColumn,
  type WindowColumnState,
  WindowColumnToggle,
} from "@/features/shell/window-columns";
import { cn } from "@/lib/utils";

import { useCallActions } from "../call-actions";
import type { CallInfo } from "../types";

/*
 * The call window, 1440 wide: title bar with the project and the recording,
 * then three columns on the window gray: transcript, the white questions
 * panel, context. Columns scroll on their own; the window size comes from
 * the call site (`size-full` in /dev/screens, auto height for the reference).
 *
 * The questions stay in the row at any width; the side columns leave it
 * when the window gets narrow and open as drawers from the title bar:
 * context below a 1280 window, the transcript below 1024. The collapsed
 * transcript (the 52px rail) stays in the row, its button opens the drawer.
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
  transcriptCollapsed = false,
}: {
  className?: string;
  context: ReactNode;
  /** The call is over: columns fade to 30% (200ms) and stop taking input. */
  dimmed?: boolean;
  /** Panels drawn over the window, positioned by the caller. */
  overlay?: ReactNode;
  questions: ReactNode;
  titlebar: ReactNode;
  transcript: ReactNode;
  /** `transcript` is the rail: it stays in the row at any width. */
  transcriptCollapsed?: boolean;
}) {
  const transcriptColumn = useWindowColumn();
  const contextColumn = useWindowColumn();
  const { close: closeTranscript, id: transcriptId } = transcriptColumn;
  const transcriptOpen = transcriptColumn.open;

  // Collapsed, the transcript has no drawer to keep open. The rail opens it
  // when expanding; a wide window shows the column in the row instead.
  useEffect(() => {
    if (transcriptCollapsed) {
      closeTranscript();
      return;
    }
    // useId ids carry colons, so the selector needs escaping
    const column = document.querySelector(`#${CSS.escape(transcriptId)}`);
    if (
      transcriptOpen &&
      column &&
      getComputedStyle(column).position !== "absolute"
    ) {
      closeTranscript();
    }
  }, [closeTranscript, transcriptCollapsed, transcriptId, transcriptOpen]);

  const columns = useMemo(
    () => ({
      context: contextColumn,
      transcript: transcriptColumn,
      transcriptCollapsed,
    }),
    [contextColumn, transcriptColumn, transcriptCollapsed]
  );

  return (
    <CallColumnsContext.Provider value={columns}>
      <AppWindow className={cn("relative", className)}>
        {titlebar}
        {/* The columns fade back as the finishing card comes up */}
        <AppWindowBody
          className={cn(
            "ease-enter transition-opacity duration-200",
            dimmed && "opacity-30"
          )}
          inert={dimmed}
        >
          {transcriptCollapsed ? (
            transcript
          ) : (
            <WindowColumn
              breakpoint="lg"
              column={transcriptColumn}
              label={TRANSCRIPT_DRAWER}
              side="start"
            >
              {transcript}
            </WindowColumn>
          )}
          {questions}
          <WindowColumn
            breakpoint="xl"
            column={contextColumn}
            label={CONTEXT_DRAWER}
            side="end"
          >
            {context}
          </WindowColumn>
        </AppWindowBody>
        {overlay}
      </AppWindow>
    </CallColumnsContext.Provider>
  );
}

// The columns inside are the «Расшифровка» and «Контекст» regions
const TRANSCRIPT_DRAWER = "Колонка расшифровки";
const CONTEXT_DRAWER = "Колонка контекста";

interface CallColumns {
  context: WindowColumnState;
  transcript: WindowColumnState;
  transcriptCollapsed: boolean;
}

const CallColumnsContext = createContext<CallColumns | null>(null);

/**
 * Drawer state of the side columns, for the title bar buttons and for
 * what inside the columns opens or closes them; null outside CallWindow.
 */
export function useCallColumns() {
  return useContext(CallColumnsContext);
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
  const columns = useCallColumns();

  return (
    <WindowTitlebar className={className}>
      <WindowTitlebarStart>
        <WindowChromeStart />
        {columns && !columns.transcriptCollapsed ? (
          <WindowColumnToggle
            breakpoint="lg"
            className="-mx-2"
            column={columns.transcript}
            label="Расшифровка"
            side="start"
            title="Расшифровка"
          />
        ) : null}
        {/* A narrow window cuts the participants first, then the project */}
        <WindowTitle title={`${call.project} ${call.participants}`}>
          <span className="max-w-full shrink-0 truncate">{call.project}</span>
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
        {columns ? (
          <WindowColumnToggle
            breakpoint="xl"
            column={columns.context}
            label="Контекст"
            side="end"
            title="Контекст"
          />
        ) : null}
        <WindowChromeEnd />
      </WindowTitlebarEnd>
    </WindowTitlebar>
  );
}
