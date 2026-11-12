"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { toast } from "@/components/ui/toast";
import {
  type CallSession,
  finishCall,
  keepCall,
  resumeCall,
  startCall,
  useCallSession,
  useCallSessionLoaded,
} from "@/data/call-session";
import { NO_PROJECT_CALL } from "@/data/calls";
import { getProjects, useProject } from "@/data/projects";
import { autoEndSeconds, useSettings } from "@/data/settings";
import { buildFinishingSummary, useCallSummary } from "@/data/summaries";
import { inTauri } from "@/effect/runtime";
import {
  releaseMicDemo,
  subscribeToMicActivity,
  useRecordingSignal,
} from "@/features/recording/api";
import { showFloatingWindow } from "@/features/shell/api";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import {
  actOnQuestion,
  type CallAgentUpdate,
  hideFinding,
  questionsFromBackend,
  reconnectSource,
  requestSystemAudio,
  retryAgent,
  retryAgentNow,
  subscribeToCallAgent,
  subscribeToCallFeed,
  waitForTranscript,
} from "../api";
import { FINAL_CHECK_TOPIC_ID } from "../components/call-questions";
import { scrollToQuestion } from "../components/questions-panel";
import {
  FEED_LENGTH,
  feedCheckpoint,
  RECONNECTED_GITHUB,
} from "../feed-script";
import {
  backendCall,
  createLiveCall,
  finishedStages,
  type LiveCallAction,
  type LiveCallState,
  liveCallReducer,
  startingCall,
  toScreenData,
} from "../live-call";
import { CALL_SCREENS } from "../mock";
import { CallScreen } from "../screens/call-screen";
import { NoCallScreen } from "../screens/no-call-screen";
import type {
  CallFeedEvent,
  CallScreenActions,
  CallScreenState,
  QuestionQuickAction,
} from "../types";

/*
 * /call: the live call window. The feed from ../api streams the transcript,
 * topics, questions and context; clicks change the questions locally;
 * "Завершить" stops the recording; the window shows the summary build's
 * stages and opens the summary once the build closed the call.
 *
 * In Tauri the transcript is the recognizer's and the questions the
 * backend's: the call state of the session's recording and the agent's
 * status come from `subscribeToCallAgent`, the quick actions and
 * «Повторить» go to the backend, which answers with a new state. Only
 * "Вернуться к темам" stays on the screen.
 *
 * In Tauri the call is the backend's (`useCallSession`): its project (or
 * «Звонок без проекта»), people and start time. "Завершить" from any
 * window, the tray or the countdown makes it `finishing`, Rust builds the
 * summary and the window follows it; "Отменить завершение" asks the backend to record
 * on. Without a call the window says so and offers to start one; it never
 * starts the demo.
 *
 * "Микрофон освободился": the app's name and the time it let go, the
 * countdown from the "Завершать звонок сам" setting. In Tauri it is the
 * backend's countdown (`session.autoEnd`), shared by every window, and
 * "Продолжить" stops it there. In the browser the window watches the
 * mock's microphone while the call is live and counts down itself;
 * "Продолжить" (or the app taking the microphone back) hides it until the
 * next release, and the script's last step frees the microphone.
 *
 * In the browser, opened without a call in progress, it starts the demo
 * call of Телемедиа.
 */

/** States the dev navigator can force with `?demo=`. */
export const CALL_DEMO_STATES = [
  "starting",
  "reference",
  "question-pinned",
  "transcript-collapsed",
  "final-check",
  "mic-released",
  "agent-timeout",
  "limit-reached",
  "transcript-lag",
  "no-system-audio",
  "github-unavailable",
] as const satisfies readonly CallScreenState[];

type CallDemoState = (typeof CALL_DEMO_STATES)[number];

/** Project the demo call records. */
const DEMO_PROJECT_ID = "telemedia";

/** Where the feed picks up for a forced state; FEED_LENGTH = no feed. */
function feedStart(demo: CallDemoState | undefined) {
  switch (demo) {
    case undefined:
    case "starting":
      return 0;
    case "reference":
    case "question-pinned":
    case "transcript-collapsed":
    case "github-unavailable":
    case "transcript-lag":
      return feedCheckpoint("reference");
    case "final-check":
      return feedCheckpoint("final-check");
    default:
      // The mic panel is the end of the script; agent and audio failures
      // freeze the questions, so nothing new arrives
      return FEED_LENGTH;
  }
}

/**
 * The window as it opens. In Tauri the transcript is the recognizer's and
 * the questions the backend's, so the starting call has none of the demo's.
 */
function initialState({
  demo,
  startedAt,
}: {
  demo: CallDemoState | undefined;
  startedAt: number | undefined;
}): LiveCallState {
  if (demo) {
    return createLiveCall(CALL_SCREENS[demo]);
  }
  if (!questionsFromBackend) {
    return startingCall();
  }
  const call = backendCall();
  const elapsed = callSeconds(startedAt);
  return elapsed === undefined ? call : { ...call, elapsed };
}

/** Tauri: seconds since the backend's call started; the demo counts its own. */
function callSeconds(startedAt: number | undefined) {
  if (!inTauri || startedAt === undefined) {
    return;
  }
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
}

/** A backend update into the window. */
function agentHandler(
  dispatch: (action: LiveCallAction) => void,
  startedAt: number | undefined
) {
  return (update: CallAgentUpdate) => {
    const now = Date.now();
    if (update.type === "status") {
      dispatch({ now, status: update.status, type: "agent-status" });
      return;
    }
    dispatch({
      agent: update.agent,
      now,
      startedAt,
      state: update.state,
      type: "call-state",
    });
  };
}

function actionFailed(description: string | null) {
  if (description !== null) {
    toast.add({ description, title: "Не получилось", type: "error" });
  }
}

/**
 * The title bar's project: in Tauri the call's, or «Звонок без проекта»;
 * the browser falls back to the demo's.
 */
function projectTitle(
  session: CallSession,
  name: string | undefined,
  demo: string
) {
  if (!inTauri) {
    return name ?? demo;
  }
  return session.projectId === null
    ? NO_PROJECT_CALL
    : (name ?? NO_PROJECT_CALL);
}

/** Id of the question pinned in the topic, if any. */
function pinnedIn(state: LiveCallState, topicId: string) {
  const { current } = state.data.questions;
  return current?.id === topicId ? current.pinned?.id : undefined;
}

/** How long a question stays ringed after «к вопросу …». */
const QUESTION_HIGHLIGHT_MS = 2500;

/** «Начать звонок» without a call: the start widget, over the windows. */
function openStartWidget() {
  showFloatingWindow(routes.startWidget());
}

export function CallPage() {
  const router = useRouter();
  const demo = useDemoState(CALL_DEMO_STATES);
  const session = useCallSession();
  const loaded = useCallSessionLoaded();

  // The summary build closes the finishing call (Rust; the browser's mock
  // build): the window opens its summary.
  const finishingCall = useRef<string | null>(null);
  const { callId, status } = session;
  useEffect(() => {
    if (status === "finishing" && callId) {
      finishingCall.current = callId;
    } else if (status === "idle" && finishingCall.current) {
      const closed = finishingCall.current;
      finishingCall.current = null;
      router.push(routes.callSummary(closed));
    } else {
      finishingCall.current = null;
    }
  }, [callId, router, status]);

  if (inTauri && demo === undefined) {
    if (!loaded) {
      return <div aria-busy="true" className="bg-surface h-svh" />;
    }
    if (session.status === "idle") {
      return <NoCallScreen className="h-svh" onStartCall={openStartWidget} />;
    }
  }
  // A forced state starts the window over, and so does a new call (the
  // main window stays loaded from one call to the next).
  const key = inTauri ? `${demo ?? "live"}:${session.callId}` : demo;
  return <LiveCallWindow demo={demo} key={key ?? "live"} />;
}

/**
 * A feed event into the window. The script's "mic-released" is the browser
 * demo's meeting app leaving: it frees the mock's microphone, the watch
 * does the rest. In Tauri the real microphone says when, so it's dropped.
 */
function feedHandler(dispatch: (action: LiveCallAction) => void) {
  return (event: CallFeedEvent) => {
    if (event.type !== "mic-released") {
      dispatch({ event, type: "feed" });
    } else if (!inTauri) {
      releaseMicDemo();
    }
  };
}

/** Cancels pending fake async operations when the window goes away. */
function usePendingOperations() {
  const pending = useRef(new Set<() => void>());

  useEffect(() => {
    const operations = pending.current;
    return () => {
      for (const cancel of operations) {
        cancel();
      }
      operations.clear();
    };
  }, []);

  return useCallback((cancel: () => void) => {
    pending.current.add(cancel);
  }, []);
}

function LiveCallWindow({ demo }: { demo: CallDemoState | undefined }) {
  const router = useRouter();
  const session = useCallSession();
  const project = useProject(
    inTauri ? session.projectId : (session.projectId ?? DEMO_PROJECT_ID)
  );
  const { callId, recordingId, startedAt } = session;
  const [state, dispatch] = useReducer(
    liveCallReducer,
    { demo, startedAt },
    initialState
  );
  const track = usePendingOperations();
  const { autoEnd } = useSettings();
  const signal = useRecordingSignal();

  const finishing = Boolean(state.data.finishing);
  const fromBackend = state.backend !== null;

  // The latest state for the handlers that read it (the pinned question).
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
  const projectName = projectTitle(
    session,
    project?.name,
    state.data.call.project
  );
  // A call without a project has no proposals stage; the session keeps
  // its project until the build closes the call.
  const withProposalsRef = useRef(session.projectId !== null);
  if (session.callId !== null) {
    withProposalsRef.current = session.projectId !== null;
  }
  const withProposals = withProposalsRef.current;

  // The browser, opened without a call in progress: start the demo call.
  const sessionChecked = useRef<boolean>(false);
  useEffect(() => {
    if (inTauri || sessionChecked.current) {
      return;
    }
    sessionChecked.current = true;
    if (session.status !== "live") {
      const known = getProjects().some((item) => item.id === DEMO_PROJECT_ID);
      startCall({
        participantIds: [],
        projectId: known ? DEMO_PROJECT_ID : null,
      });
    }
  }, [session.status]);

  // "Завершить" from another window, the tray or the countdown, and
  // "Отменить завершение": the window follows the session.
  const sessionStatus = session.status;
  useEffect(() => {
    if (sessionStatus === "finishing" && !latest.current.data.finishing) {
      dispatch({ project: projectName, type: "finish-start", withProposals });
    } else if (sessionStatus === "live" && latest.current.data.finishing) {
      dispatch({ type: "finish-cancel" });
    }
  }, [projectName, sessionStatus, withProposals]);

  // The clock: call time (in Tauri from the call's start) and countdowns
  useEffect(() => {
    if (finishing) {
      return;
    }
    const timer = setInterval(
      () => dispatch({ elapsed: callSeconds(startedAt), type: "tick" }),
      1000
    );
    return () => clearInterval(timer);
  }, [finishing, startedAt]);

  // The agent and the recorder; pauses while finishing, resumes on cancel
  const feedPosition = useRef(feedStart(demo));
  const playFeedEvent = useMemo(() => feedHandler(dispatch), []);
  useEffect(() => {
    // In Tauri the feed carries the live transcript after the script ends.
    const scriptOver = feedPosition.current >= FEED_LENGTH;
    if (finishing || (scriptOver && !inTauri)) {
      return;
    }
    return subscribeToCallFeed(playFeedEvent, {
      from: feedPosition.current,
      onStep: (next) => {
        feedPosition.current = next;
      },
    });
  }, [finishing, playFeedEvent]);

  // The backend's questions of the session's recording
  useEffect(() => {
    if (!(fromBackend && recordingId)) {
      return;
    }
    return subscribeToCallAgent(recordingId, agentHandler(dispatch, startedAt));
  }, [fromBackend, recordingId, startedAt]);

  // Tauri: the backend's countdown after the meeting app let go; none
  // means "Продолжить" or the app taking the microphone back. The browser
  // and the demos count down, finish and resume on the page itself.
  const shared = session.autoEnd;
  const ownCountdown = !inTauri || demo !== undefined;
  useEffect(() => {
    if (ownCountdown) {
      return;
    }
    if (shared === null) {
      dispatch({ type: "mic-continue" });
      return;
    }
    // «Никогда»: the offer without a countdown.
    dispatch({
      app: shared.app,
      now: Date.now(),
      releasedAt: shared.releasedAt,
      timeout:
        shared.endsAt === null
          ? null
          : Math.round((shared.endsAt - shared.releasedAt) / 1000),
      type: "mic-released",
    });
  }, [ownCountdown, shared]);

  // The browser: a release while the call is live offers to end it, the
  // app taking the microphone back hides the offer.
  const live = session.status === "live";
  const watch = useRef({ live, timeout: autoEndSeconds(autoEnd) });
  useEffect(() => {
    watch.current = { live, timeout: autoEndSeconds(autoEnd) };
  }, [autoEnd, live]);
  useEffect(() => {
    if (inTauri) {
      return;
    }
    return subscribeToMicActivity((activity) => {
      if (activity.busy) {
        dispatch({ type: "mic-continue" });
        return;
      }
      if (watch.current.live) {
        dispatch({
          app: activity.app,
          now: Date.now(),
          releasedAt: activity.since,
          timeout: watch.current.timeout,
          type: "mic-released",
        });
      }
    });
  }, []);

  // "Собираю итоги": the stages of the summary build (`SummaryProgress`;
  // Rust builds it, the browser's mock is started here). The build closes
  // the call, and `CallPage` opens its summary.
  // The build that ended shows its last stage until the call closes.
  const { building, ended } = useCallSummary(finishing ? callId : null);
  useEffect(() => {
    if (finishing && callId) {
      buildFinishingSummary(callId);
    }
  }, [callId, finishing]);
  const shown = building ?? ended;
  useEffect(() => {
    if (finishing && shown) {
      dispatch({
        stage: finishedStages(shown, withProposals),
        type: "finish-stage",
        withProposals,
      });
    }
  }, [finishing, shown, withProposals]);

  // A lagging transcript catches up by itself
  const lagging = Boolean(state.data.transcript.notice);
  useEffect(() => {
    if (!lagging) {
      return;
    }
    return waitForTranscript(() => dispatch({ type: "transcript-caught-up" }));
  }, [lagging]);

  // In Tauri the session drives «Собираю итоги» (the effect above): a
  // finish the backend refused leaves the call live on the page too.
  const end = useCallback(() => {
    finishCall();
    if (ownCountdown) {
      dispatch({ project: projectName, type: "finish-start", withProposals });
    }
  }, [ownCountdown, projectName, withProposals]);

  const retry = useCallback(() => {
    dispatch({ type: "agent-retrying" });
    if (fromBackend) {
      // The agent's next status says how it went; a refused retry gets
      // none, so the indicator goes back to the last one.
      if (recordingId) {
        const failed = (description: string | null) => {
          if (description !== null) {
            dispatch({ now: Date.now(), type: "agent-retry-failed" });
          }
          actionFailed(description);
        };
        retryAgentNow(recordingId).then(failed, failed);
      }
      return;
    }
    track(
      retryAgent(() => {
        dispatch({ type: "agent-recovered" });
        toast.add({
          description: "Догоняю пропущенное, вопросы снова обновляются",
          title: "Claude Code снова отвечает",
          type: "success",
        });
      })
    );
  }, [fromBackend, recordingId, track]);

  // Zero on the mic countdown ends the call (in Tauri the backend ends it,
  // also with every window hidden); zero on the agent's retries
  const micExpired = state.micLeft === 0 && ownCountdown;
  useEffect(() => {
    if (micExpired) {
      end();
    }
  }, [end, micExpired]);

  // The backend retries by itself; the demo agent needs the nudge.
  const autoRetry = state.agentRetryIn === 0 && !fromBackend;
  useEffect(() => {
    if (autoRetry) {
      retry();
    }
  }, [autoRetry, retry]);

  const onBannerAction = useCallback(
    (actionId: string) => {
      switch (actionId) {
        case "retry":
          retry();
          break;
        case "remind":
          toast.add({
            description: "Когда лимит обновится, вопросы пойдут снова",
            title: "Напомню в 15:00",
            type: "info",
          });
          break;
        case "subscription":
          toast.add({
            title: "Открыл страницу подписки в браузере",
            type: "info",
          });
          break;
        case "open-settings":
          toast.add({
            description: "Включите Grill в «Запись экрана и системного звука»",
            title: "Открыл системные настройки",
            type: "info",
          });
          track(
            requestSystemAudio(() => {
              dispatch({ type: "audio-restored" });
              toast.add({
                description: "Ответы клиента снова учитываются в вопросах",
                title: "Слышу собеседников",
                type: "success",
              });
            })
          );
          break;
        default:
          break;
      }
    },
    [retry, track]
  );

  const onReconnect = useCallback(
    (itemId: string) => {
      dispatch({ itemId, type: "reconnect-start" });
      track(
        reconnectSource(() => {
          dispatch({
            item: { ...RECONNECTED_GITHUB, id: itemId },
            type: "reconnect-done",
          });
          toast.add({ title: "GitHub снова подключён", type: "success" });
        })
      );
    },
    [track]
  );

  // «Убрать» on a finding: the backend hides it, and its event takes it
  // out of every window.
  const onHideFinding = useCallback(
    (findingId: string) => {
      if (fromBackend && recordingId) {
        hideFinding(recordingId, findingId).then(actionFailed, actionFailed);
      }
    },
    [fromBackend, recordingId]
  );

  // «к вопросу …»: the list scrolls to the question and rings it a moment.
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        clearTimeout(highlightTimer.current);
      }
    },
    []
  );
  const onShowQuestion = useCallback((questionId: string) => {
    dispatch({ questionId, type: "highlight-question" });
    scrollToQuestion(questionId);
    if (highlightTimer.current !== null) {
      clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = setTimeout(() => {
      highlightTimer.current = null;
      dispatch({ questionId: null, type: "highlight-question" });
    }, QUESTION_HIGHLIGHT_MS);
  }, []);

  const onCancelFinish = useCallback(() => {
    resumeCall();
    if (ownCountdown) {
      dispatch({ type: "finish-cancel" });
    }
  }, [ownCountdown]);

  const onCloseWindow = useCallback(() => {
    if (callId) {
      router.push(routes.callSummary(callId));
    }
  }, [callId, router]);

  const onMicContinue = useCallback(() => {
    if (inTauri) {
      keepCall();
    }
    dispatch({ type: "mic-continue" });
  }, []);

  const onQuestionAction = useCallback(
    (topicId: string, questionId: string, action: QuestionQuickAction) => {
      if (!fromBackend) {
        dispatch({ action, questionId, topicId, type: "question" });
        return;
      }
      // One pinned question a topic, as on the screen: the old one goes
      // back to the list first.
      const pinned =
        action === "pin" && topicId !== FINAL_CHECK_TOPIC_ID
          ? pinnedIn(latest.current, topicId)
          : undefined;
      const unpinFirst = pinned
        ? actOnQuestion(pinned, "unpin")
        : Promise.resolve(null);
      unpinFirst
        .then((failed) => failed ?? actOnQuestion(questionId, action))
        .then(actionFailed, actionFailed);
    },
    [fromBackend]
  );

  const onRestore = useCallback(
    (topicId: string, entryId: string) => {
      if (fromBackend) {
        actOnQuestion(entryId, "restore").then(actionFailed, actionFailed);
        return;
      }
      dispatch({ entryId, topicId, type: "restore" });
    },
    [fromBackend]
  );

  const onUnpin = useCallback(
    (topicId: string) => {
      if (!fromBackend) {
        dispatch({ topicId, type: "unpin" });
        return;
      }
      const pinned = pinnedIn(latest.current, topicId);
      if (pinned) {
        actOnQuestion(pinned, "unpin").then(actionFailed, actionFailed);
      }
    },
    [fromBackend]
  );

  const actions = useMemo<CallScreenActions>(
    () => ({
      onBannerAction,
      onCancelFinish,
      onCloseWindow,
      onEnd: end,
      onHideFinding,
      onLeaveFinalCheck: () => dispatch({ type: "leave-final-check" }),
      onMicContinue,
      onQuestionAction,
      onReconnect,
      onRestore,
      onReturnToFinalCheck: () => dispatch({ type: "return-final-check" }),
      onShowQuestion,
      onToggleTranscript: () => dispatch({ type: "toggle-transcript" }),
      onUnpin,
    }),
    [
      end,
      onBannerAction,
      onCancelFinish,
      onCloseWindow,
      onHideFinding,
      onMicContinue,
      onQuestionAction,
      onReconnect,
      onRestore,
      onShowQuestion,
      onUnpin,
    ]
  );

  const data = useMemo(() => {
    const screen = toScreenData(state);
    return {
      ...screen,
      call: {
        ...screen.call,
        level: signal.level,
        participants:
          inTauri || session.participants.length > 0
            ? session.participants.join(", ")
            : screen.call.participants,
        project: projectName,
        warning: signal.warning,
      },
    };
  }, [projectName, session.participants, signal, state]);

  return <CallScreen actions={actions} className="h-svh" data={data} />;
}
