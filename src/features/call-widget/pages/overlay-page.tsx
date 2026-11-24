"use client";

import { toast } from "@grill/ui/toast";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CallState } from "@/bindings";
import { allowOverLimit } from "@/data/agent-limit";
import {
  type CallSession,
  CURRENT_CALL_ID,
  finishCall,
  keepCall,
  useCallSession,
} from "@/data/call-session";
import { NO_PROJECT_CALL } from "@/data/calls";
import { useProject } from "@/data/projects";
import { autoEndSeconds, useSettings } from "@/data/settings";
import { inTauri } from "@/effect/runtime";
import {
  type AgentQuestions,
  type AgentStatusView,
  grillLimitTitle,
  toAgentQuestions,
  toAgentStatusView,
} from "@/features/call/agent-state";
import {
  actOnQuestion,
  questionsFromBackend,
  subscribeToCallAgent,
} from "@/features/call/api";
import type { OpenQuestionData } from "@/features/call/types";
import {
  type MicActivity,
  releaseMicDemo,
  subscribeToMicActivity,
  useRecordingSignal,
} from "@/features/recording/api";
import { useOpenRoute } from "@/features/shell/api";
import { resetLine } from "@/lib/agent-limit";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import { subscribeToAgent } from "../api";
import type { AgentEvent } from "../backend";
import { DesktopStage } from "../components/desktop-stage";
import {
  CALL_PROJECT,
  MEETING_APP,
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
 * card under the pill for 8 seconds. When the meeting app lets the
 * microphone go, the offer to end the call replaces the overlay, names the
 * app and the time it left, and counts down to the auto end from Settings.
 * "Продолжить" hides it until the microphone is freed again; the app
 * taking it back hides it too. In the browser the overlay watches the
 * mock's microphone ("Выйти из встречи" in the stand-in Zoom frees it) and
 * counts down itself.
 *
 * In Tauri the overlay is its own window, the only one hidden from screen
 * sharing. It shows the backend's call (its project, or «Звонок без
 * проекта») and starts over with each new call. The countdown is the
 * backend's (`session.autoEnd`), which ends the call when it runs out.
 * "Завершить" asks the backend, which hides the overlay and opens the
 * summary in the main window; the call window opens there too.
 * Its questions are the backend's, the same as in the call window: the
 * current topic's main question and two more, or the agent's final check;
 * "Скрыть вопрос" hides one in every window. In the browser they come from
 * the demo feed and hiding is local.
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
  /** null: none left, the agent listens. */
  main: string | null;
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
  const previous =
    feed.main === null ? [] : [{ id: feed.main, title: feed.main }];
  return {
    main: question,
    openQuestions: feed.openQuestions + 1,
    rows: [...previous, ...feed.rows].slice(0, MAX_ROWS),
  };
}

/** The demo's "Скрыть вопрос": the next row takes the main one's place. */
function hideFromFeed(feed: Feed, id: string): Feed {
  const openQuestions = Math.max(0, feed.openQuestions - 1);
  if (id === feed.main) {
    const [next, ...rows] = feed.rows;
    return { main: next?.title ?? null, openQuestions, rows };
  }
  return {
    ...feed,
    openQuestions,
    rows: feed.rows.filter((row) => row.id !== id),
  };
}

/* The backend's questions */

function overlayRow(question: OpenQuestionData): OverlayQuestionItem {
  return {
    description: question.description,
    id: question.id,
    ...(question.tag === "contradiction" ? { mark: "contradiction" } : {}),
    title: question.title,
    ...(question.topic ? { topic: question.topic } : {}),
  };
}

interface OverlayQuestions {
  /** Under the final check: its questions that didn't fit. */
  finalCheckMore?: number;
  main: { id: string; label: string; title: string } | null;
  openQuestions: number;
  pastTopics: number;
  rows: OverlayQuestionItem[];
  /** The current topic; the main question's topic in the final check. */
  topic: string;
}

const NO_TOPIC_YET = "Тема ещё не ясна";

/**
 * The call window's topics in the overlay: the pinned or main question on
 * top, two more under it, or the first questions of the final check.
 */
function overlayQuestions(view: AgentQuestions | null): OverlayQuestions {
  const pastTopics = view?.pastOpen ?? 0;
  const finalCheck = view?.finalCheck;
  if (finalCheck) {
    const { main } = finalCheck;
    return {
      finalCheckMore: Math.max(0, finalCheck.questions.length - MAX_ROWS),
      main: {
        id: main.id ?? main.title,
        label: main.status,
        title: main.title,
      },
      openQuestions: finalCheck.questions.length + 1,
      pastTopics,
      rows: finalCheck.questions.slice(0, MAX_ROWS).map(overlayRow),
      topic: main.status,
    };
  }
  const current = view?.current;
  if (!current) {
    return {
      main: null,
      openQuestions: 0,
      pastTopics,
      rows: [],
      topic: NO_TOPIC_YET,
    };
  }
  const { main, pinned } = current;
  const queue = current.questions.map(overlayRow);
  let lead: OverlayQuestions["main"] = null;
  if (pinned) {
    lead = { id: pinned.id, label: pinned.label, title: pinned.title };
    if (main) {
      queue.unshift({
        description: main.description,
        id: main.id ?? main.title,
        title: main.title,
      });
    }
  } else if (main) {
    lead = { id: main.id ?? main.title, label: main.status, title: main.title };
  }
  return {
    main: lead,
    openQuestions: current.questions.length + (main ? 1 : 0) + (pinned ? 1 : 0),
    pastTopics,
    rows: queue.slice(0, MAX_ROWS),
    topic: current.title,
  };
}

/** The newest `shownAt` of the list: when its latest question came. */
function newestShownAt(state: CallState): number | null {
  let newest: number | null = null;
  for (const question of state.questions) {
    if (
      question.shownAt !== null &&
      (newest === null || question.shownAt > newest)
    ) {
      newest = question.shownAt;
    }
  }
  return newest;
}

function shownAtOf(state: CallState, id: string): number | null {
  return (
    state.questions.find((question) => question.id === id)?.shownAt ?? null
  );
}

/**
 * The backend's questions of the recording and the agent's state, read
 * again on every change (Tauri). Nothing without a recording.
 */
function useAgentQuestions(recordingId: string | undefined, enabled: boolean) {
  const [view, setView] = useState<AgentQuestions | null>(null);
  const [state, setState] = useState<CallState | null>(null);
  const [status, setStatus] = useState<AgentStatusView | null>(null);
  useEffect(() => {
    if (!(enabled && recordingId)) {
      return;
    }
    return subscribeToCallAgent(recordingId, (update) => {
      const now = Date.now();
      if (update.type === "status") {
        setStatus(toAgentStatusView(update.status, now));
        return;
      }
      if (update.agent) {
        setStatus(toAgentStatusView(update.agent, now));
      }
      setView(toAgentQuestions(update.state, { now }));
      setState(update.state);
    });
  }, [enabled, recordingId]);
  return { state, status, view };
}

function overLimitFailed() {
  toast.add({
    description: "Попробуйте ещё раз через несколько секунд",
    title: "Не получилось продолжить сверх лимита",
    type: "error",
  });
}

function hideFailed(description: string | null) {
  if (description !== null) {
    toast.add({ description, title: "Не получилось скрыть", type: "error" });
  }
}

/** The meeting app let the microphone go. */
interface Release {
  /** null when unknown. */
  app: string | null;
  /** Seconds since the epoch; null: the demo's, from the first tick. */
  at: number | null;
}

/**
 * The auto end after a release: seconds left (null: never) and the percent
 * of the countdown passed.
 */
function countdown(
  release: Release | null,
  autoEnd: string,
  now: number | null,
  session: CallSession
): { elapsed: number; remaining: number | null } {
  const shared = session.autoEnd;
  // «Никогда»: the backend offers to end the call without a countdown.
  if (inTauri && shared?.endsAt === null) {
    return { elapsed: 0, remaining: null };
  }
  if (inTauri && shared && shared.endsAt !== null) {
    const total = (shared.endsAt - shared.releasedAt) / 1000;
    // Whole seconds, like the clock the overlay ticks with.
    const remaining =
      now === null
        ? total
        : Math.max(0, Math.floor(shared.endsAt / 1000) - now);
    return {
      elapsed: total > 0 ? ((total - remaining) / total) * 100 : 100,
      remaining,
    };
  }
  const total = autoEndSeconds(autoEnd);
  const at = release?.at ?? null;
  const passed = at !== null && now !== null ? Math.max(0, now - at) : 0;
  if (total === null) {
    return { elapsed: 0, remaining: null };
  }
  return { elapsed: (passed / total) * 100, remaining: total - passed };
}

/** The backend's countdown (Tauri): the release it started from. */
function releaseOf(autoEnd: CallSession["autoEnd"]): Release | null {
  return autoEnd
    ? { app: autoEnd.app, at: Math.floor(autoEnd.releasedAt / 1000) }
    : null;
}

/**
 * The meeting app and the microphone. In Tauri the backend counts down
 * (`session.autoEnd`, the same in every window) and "Продолжить" stops it
 * there. In the browser a release while the call runs offers to end it,
 * the app taking the microphone back withdraws the offer. Returns the
 * release on screen and "Продолжить", which hides it.
 */
function useMicRelease(
  demo: boolean,
  session: CallSession,
  now: number | null
): [Release | null, () => void] {
  const [release, setRelease] = useState<Release | null>(
    demo ? { app: MEETING_APP, at: null } : null
  );
  const fromBackend = inTauri && !demo;

  // ?demo=mic-released: the microphone went free just now.
  useEffect(() => {
    if (release !== null && release.at === null && now !== null) {
      setRelease({ ...release, at: now });
    }
  }, [now, release]);

  const running = inTauri
    ? session.status === "live"
    : session.status !== "finishing";
  const runningRef = useRef(running);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    if (fromBackend) {
      return;
    }
    return subscribeToMicActivity((activity: MicActivity) => {
      if (activity.busy) {
        setRelease(null);
        return;
      }
      if (runningRef.current) {
        setRelease({
          app: activity.app,
          at: Math.floor(activity.since / 1000),
        });
      }
    });
  }, [fromBackend]);

  const hide = useCallback(() => {
    if (fromBackend) {
      keepCall();
      return;
    }
    setRelease(null);
  }, [fromBackend]);
  return [fromBackend ? releaseOf(session.autoEnd) : release, hide];
}

/** What the overlay draws of the questions and the agent. */
type QuestionProps = Pick<
  ComponentProps<typeof CompactOverlay>,
  | "agentLabel"
  | "agentState"
  | "agentTone"
  | "finalCheckMore"
  | "limitNotice"
  | "mainLabel"
  | "mainQuestion"
  | "mainQuestionId"
  | "onHide"
  | "openQuestions"
  | "pastTopics"
  | "questions"
  | "topic"
>;

/**
 * The overlay's questions: in Tauri the backend's (a new one on top shows
 * its card while collapsed; the first read only fills the list), in the
 * browser the demo agent's feed. The demo final check is a fixed list.
 */
function useOverlayQuestions(
  demo: DemoState | undefined,
  recordingId: string | undefined,
  announce: (question: string) => void
): { finalCheck: boolean; questions: QuestionProps } {
  const fromBackend = questionsFromBackend && demo === undefined;
  const demoFinalCheck = demo === "final-check";
  const agent = useAgentQuestions(recordingId, fromBackend);
  const backend = useMemo(
    () => (fromBackend ? overlayQuestions(agent.view) : null),
    [agent.view, fromBackend]
  );
  const [feed, setFeed] = useState<Feed>(INITIAL_FEED);
  const [thinking, setThinking] = useState(false);

  useEffect(() => {
    if (demoFinalCheck || fromBackend) {
      return;
    }
    return subscribeToAgent((event: AgentEvent) => {
      if (event.type === "thinking") {
        setThinking(true);
        return;
      }
      setThinking(false);
      setFeed((current) => pushQuestion(current, event.question));
      announce(event.question);
    });
  }, [announce, demoFinalCheck, fromBackend]);

  // A new question on top shows its card; the first read only fills the
  // list, and a question moving up (the main one hidden) is not new.
  const lead = backend?.main ?? null;
  // The newest `shownAt` of the reads before; none before the first.
  const seen = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!fromBackend || agent.state === null) {
      return;
    }
    const before = seen.current;
    seen.current = Math.max(
      before ?? Number.NEGATIVE_INFINITY,
      newestShownAt(agent.state) ?? Number.NEGATIVE_INFINITY
    );
    if (before === undefined || !lead) {
      return;
    }
    // Shown after every question seen so far: newer than the previous
    // lead too. A queued question moving up is older than that.
    const shownAt = shownAtOf(agent.state, lead.id);
    if (shownAt !== null && shownAt > before) {
      announce(lead.title);
    }
  }, [agent.state, announce, fromBackend, lead]);

  const hide = useCallback(
    (id: string) => {
      if (fromBackend) {
        actOnQuestion(id, "hide").then(hideFailed, hideFailed);
        return;
      }
      setFeed((current) => hideFromFeed(current, id));
    },
    [fromBackend]
  );

  if (backend) {
    const stopped = agent.status?.banner ? agent.status.agent : null;
    const limit = agent.status?.grillLimit;
    return {
      finalCheck: backend.finalCheckMore !== undefined,
      questions: {
        agentLabel: stopped?.label,
        agentState: agent.status?.thinking ? "thinking" : "listening",
        agentTone: stopped?.tone,
        finalCheckMore: backend.finalCheckMore,
        limitNotice:
          limit && recordingId
            ? {
                hint: resetLine(limit.resetsAt),
                onContinue: () => {
                  allowOverLimit(recordingId).catch(overLimitFailed);
                },
                title: grillLimitTitle(limit),
              }
            : undefined,
        mainLabel: backend.main?.label,
        mainQuestion: backend.main?.title ?? null,
        mainQuestionId: backend.main?.id,
        onHide: hide,
        openQuestions: backend.openQuestions,
        pastTopics: backend.pastTopics,
        questions: backend.rows,
        topic: backend.topic,
      },
    };
  }
  if (demoFinalCheck) {
    return { finalCheck: true, questions: { mainQuestion: undefined } };
  }
  return {
    finalCheck: false,
    questions: {
      agentState: thinking ? "thinking" : "listening",
      mainQuestion: feed.main,
      mainQuestionId: feed.main ?? undefined,
      onHide: hide,
      openQuestions: feed.openQuestions,
      questions: feed.rows,
    },
  };
}

function OverlayFlow({ demo }: { demo: DemoState | undefined }) {
  const openRoute = useOpenRoute();
  const session = useCallSession();
  const project = useProject(session.projectId);
  const { autoEnd, hideOnShare } = useSettings();
  const now = useNowSeconds();
  const [view, setView] = useState<View>(
    demo === "collapsed" ? "collapsed" : "expanded"
  );
  const [incoming, setIncoming] = useState<string | null>(
    demo === "collapsed" ? OVERLAY_MAIN_QUESTION : null
  );
  const { finalCheck, questions } = useOverlayQuestions(
    demo,
    session.recordingId,
    setIncoming
  );
  const [release, keepRecording] = useMicRelease(
    demo === "mic-released",
    session,
    now
  );
  const micReleased = release !== null;
  const signal = useRecordingSignal();

  const time = useCallTime(finalCheck ? OVERLAY.timeFinalCheck : OVERLAY.time);
  // The browser shows the demo call until one starts; Tauri never does.
  let projectName = inTauri ? NO_PROJECT_CALL : CALL_PROJECT;
  if (session.status !== "idle") {
    projectName = project?.name ?? NO_PROJECT_CALL;
  }

  // The new-question card hides itself after 8 seconds.
  useEffect(() => {
    if (incoming === null) {
      return;
    }
    const timer = setTimeout(() => setIncoming(null), NEW_QUESTION_MS);
    return () => clearTimeout(timer);
  }, [incoming]);

  // The overlay's own countdown (the browser, a demo) ends once: it keeps
  // ticking until the page is gone. In Tauri the backend's finish changes
  // nothing the second time, so «Завершить» works again after «Отменить
  // завершение» or a failed finish; the backend hides the overlay and opens
  // the summary in the main window.
  const ownCountdown = !inTauri || demo !== undefined;
  const ended = useRef<boolean>(false);
  const { callId } = session;
  const end = useCallback(() => {
    if (ownCountdown && ended.current) {
      return;
    }
    ended.current = true;
    finishCall();
    // The browser's overlay without a call is the demo's: its summary.
    if (!inTauri) {
      openRoute(routes.callSummary(callId ?? CURRENT_CALL_ID));
    }
  }, [callId, openRoute, ownCountdown]);

  const { elapsed, remaining } = countdown(release, autoEnd, now, session);

  // The countdown ran out: the call ends by itself (in Tauri the backend
  // ends it, also with every window hidden).
  useEffect(() => {
    if (ownCountdown && micReleased && remaining !== null && remaining <= 0) {
      end();
    }
  }, [end, micReleased, ownCountdown, remaining]);

  const collapse = useCallback(() => {
    setIncoming(null);
    setView("collapsed");
  }, []);
  const expand = useCallback(() => {
    setIncoming(null);
    setView("expanded");
  }, []);
  const dismissIncoming = useCallback(() => setIncoming(null), []);

  if (release !== null) {
    return (
      <DesktopStage meetingEnded micInUse={false}>
        <MicReleasedWidget
          app={release.app}
          countdown={remaining === null ? null : formatCountdown(remaining)}
          elapsed={elapsed}
          onContinue={keepRecording}
          onEnd={end}
          onMinimize={keepRecording}
          project={projectName}
          releasedAt={
            release.at === null
              ? MIC_RELEASED.releasedAt
              : formatClockTime(release.at)
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
    <DesktopStage onLeaveMeeting={releaseMicDemo}>
      <CompactOverlay
        {...questions}
        callHref={routes.call()}
        hiddenFromShare={hideOnShare}
        newQuestion={incoming}
        onCollapse={collapse}
        onDismissNewQuestion={dismissIncoming}
        onExpand={expand}
        onOpenNewQuestion={expand}
        project={projectName}
        recording={signal}
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
