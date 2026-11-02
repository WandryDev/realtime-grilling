"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useCallSession } from "@/data/call-session";
import { useProject } from "@/data/projects";
import { useSettings } from "@/data/settings";
import { useOpenRoute } from "@/features/shell/api";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { endCall, subscribeToAgent } from "../api";
import type { AgentEvent } from "../backend";
import { DesktopStage } from "../components/desktop-stage";
import {
  CALL_PROJECT,
  MIC_RELEASED,
  OVERLAY,
  OVERLAY_MAIN_QUESTION,
  OVERLAY_QUESTIONS,
  type OverlayQuestionItem,
} from "../mock";
import { CompactOverlay } from "../screens/compact-overlay";
import { MicReleasedWidget } from "../screens/mic-released-widget";
import {
  formatClockTime,
  formatCountdown,
  useCallTime,
  useNowSeconds,
} from "../use-call-clock";

/*
 * /overlay: the compact overlay over the meeting app during a call. New
 * questions arrive from the agent's feed; collapsed, a new one shows as a
 * card under the pill for 8 seconds. "Выйти из встречи" in the stand-in
 * Zoom frees the microphone: the offer to end the call replaces the overlay
 * and counts down to the auto end from Settings.
 *
 * In Tauri the overlay is its own window, the only one hidden from screen
 * sharing. It shows the call the start widget started (the session is
 * shared between windows) and starts over with each new call. The call
 * window and the summary open in the main window, and the overlay hides.
 */

type View = "expanded" | "collapsed";

/** States the navigator can open directly; the rest come by clicking. */
const DEMO_STATES = ["final-check", "collapsed", "mic-released"] as const;
type DemoState = (typeof DEMO_STATES)[number];

/** How long the new-question card stays under the pill. */
const NEW_QUESTION_MS = 8000;

/** Rows under the main question; the call window has the rest. */
const MAX_ROWS = 2;

interface Feed {
  main: string;
  openQuestions: number;
  rows: OverlayQuestionItem[];
}

const INITIAL_FEED: Feed = {
  main: OVERLAY_MAIN_QUESTION,
  openQuestions: OVERLAY.openQuestions,
  rows: OVERLAY_QUESTIONS,
};

/** The newest question goes on top, the previous one becomes a row. */
function pushQuestion(feed: Feed, question: string): Feed {
  return {
    main: question,
    openQuestions: feed.openQuestions + 1,
    rows: [{ id: feed.main, title: feed.main }, ...feed.rows].slice(
      0,
      MAX_ROWS
    ),
  };
}

/** Minutes before the call ends by itself, null for "Никогда". */
function autoEndSeconds(setting: string) {
  const minutes = Number(setting);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}

function OverlayFlow({ demo }: { demo: DemoState | undefined }) {
  const openRoute = useOpenRoute();
  const session = useCallSession();
  const project = useProject(session.projectId);
  const { autoEnd } = useSettings();
  const now = useNowSeconds();
  const finalCheck = demo === "final-check";

  const [view, setView] = useState<View>(
    demo === "collapsed" ? "collapsed" : "expanded"
  );
  const [feed, setFeed] = useState<Feed>(INITIAL_FEED);
  const [thinking, setThinking] = useState(false);
  const [incoming, setIncoming] = useState<string | null>(
    demo === "collapsed" ? OVERLAY_MAIN_QUESTION : null
  );
  const [micReleased, setMicReleased] = useState(demo === "mic-released");
  const [releasedAt, setReleasedAt] = useState<number | null>(null);

  const time = useCallTime(finalCheck ? OVERLAY.timeFinalCheck : OVERLAY.time);
  let projectName = CALL_PROJECT;
  if (session.status !== "idle") {
    projectName = project?.name ?? "Без проекта";
  }

  // The agent's feed. The final check is a fixed list, no new questions.
  useEffect(() => {
    if (finalCheck) {
      return;
    }
    return subscribeToAgent((event: AgentEvent) => {
      if (event.type === "thinking") {
        setThinking(true);
        return;
      }
      setThinking(false);
      setFeed((current) => pushQuestion(current, event.question));
      setIncoming(event.question);
    });
  }, [finalCheck]);

  // The new-question card hides itself after 8 seconds.
  useEffect(() => {
    if (incoming === null) {
      return;
    }
    const timer = setTimeout(() => setIncoming(null), NEW_QUESTION_MS);
    return () => clearTimeout(timer);
  }, [incoming]);

  // ?demo=mic-released: the microphone went free just now.
  useEffect(() => {
    if (micReleased && releasedAt === null && now !== null) {
      setReleasedAt(now);
    }
  }, [micReleased, now, releasedAt]);

  // Ends once: the auto end keeps ticking until the page is gone
  const ended = useRef<boolean>(false);
  const end = useCallback(() => {
    if (ended.current) {
      return;
    }
    ended.current = true;
    endCall();
    openRoute(routes.callSummary(session.callId));
  }, [openRoute, session.callId]);

  const total = autoEndSeconds(autoEnd);
  const passed = releasedAt !== null && now !== null ? now - releasedAt : 0;
  const remaining = total === null ? null : total - passed;

  // The countdown ran out: the call ends by itself.
  useEffect(() => {
    if (micReleased && remaining !== null && remaining <= 0) {
      end();
    }
  }, [end, micReleased, remaining]);

  const collapse = useCallback(() => {
    setIncoming(null);
    setView("collapsed");
  }, []);
  const expand = useCallback(() => {
    setIncoming(null);
    setView("expanded");
  }, []);
  const dismissIncoming = useCallback(() => setIncoming(null), []);
  const leaveMeeting = useCallback(() => {
    setReleasedAt(Math.floor(Date.now() / 1000));
    setMicReleased(true);
  }, []);
  const keepRecording = useCallback(() => {
    setMicReleased(false);
    setReleasedAt(null);
  }, []);

  if (micReleased) {
    return (
      <DesktopStage meetingEnded micInUse={false}>
        <MicReleasedWidget
          countdown={remaining === null ? null : formatCountdown(remaining)}
          elapsed={total === null ? 0 : (passed / total) * 100}
          onContinue={keepRecording}
          onEnd={end}
          onMinimize={keepRecording}
          project={projectName}
          releasedAt={
            releasedAt === null
              ? MIC_RELEASED.releasedAt
              : formatClockTime(releasedAt)
          }
          time={time}
        />
      </DesktopStage>
    );
  }

  let state: "default" | "final-check" | "collapsed" = "default";
  if (view === "collapsed") {
    state = "collapsed";
  } else if (finalCheck) {
    state = "final-check";
  }

  return (
    <DesktopStage onLeaveMeeting={leaveMeeting}>
      <CompactOverlay
        agentState={thinking ? "thinking" : "listening"}
        callHref={routes.call()}
        mainQuestion={finalCheck ? undefined : feed.main}
        newQuestion={incoming}
        onCollapse={collapse}
        onDismissNewQuestion={dismissIncoming}
        onExpand={expand}
        onOpenNewQuestion={expand}
        openQuestions={feed.openQuestions}
        project={projectName}
        questions={finalCheck ? undefined : feed.rows}
        state={state}
        time={time}
      />
    </DesktopStage>
  );
}

export function OverlayPage() {
  const demo = useDemoState(DEMO_STATES);
  const { startedAt } = useCallSession();
  // A new ?demo= or a new call restarts the overlay: in Tauri the window
  // stays loaded from one call to the next.
  return <OverlayFlow demo={demo} key={`${demo}:${startedAt ?? ""}`} />;
}
