"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { toast } from "@/components/ui/toast";
import {
  finishCall,
  resumeCall,
  startCall,
  useCallSession,
} from "@/data/call-session";
import { useProject } from "@/data/projects";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

import {
  collectSummary,
  reconnectSource,
  requestSystemAudio,
  retryAgent,
  subscribeToCallFeed,
  waitForTranscript,
} from "../api";
import {
  FEED_LENGTH,
  feedCheckpoint,
  RECONNECTED_GITHUB,
} from "../feed-script";
import {
  createLiveCall,
  type LiveCallState,
  liveCallReducer,
  startingCall,
  toScreenData,
} from "../live-call";
import { CALL_SCREENS } from "../mock";
import { CallScreen } from "../screens/call-screen";
import type {
  CallScreenActions,
  CallScreenState,
  QuestionQuickAction,
} from "../types";

/*
 * /call: the live call window. The scripted feed from ../api streams the
 * transcript, topics, questions and context; clicks change the questions
 * locally; "Завершить" collects the summary and opens it.
 *
 * Opened directly without a call in progress, it starts the demo call of
 * Телемедиа.
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

function initialState(demo: CallDemoState | undefined): LiveCallState {
  return demo ? createLiveCall(CALL_SCREENS[demo]) : startingCall();
}

export function CallPage() {
  const demo = useDemoState(CALL_DEMO_STATES);
  // A forced state starts the window over
  return <LiveCallWindow demo={demo} key={demo ?? "live"} />;
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
  const project = useProject(session.projectId ?? DEMO_PROJECT_ID);
  const [state, dispatch] = useReducer(liveCallReducer, demo, initialState);
  const track = usePendingOperations();

  const { callId } = session;
  const finishing = Boolean(state.data.finishing);
  const projectName = project?.name ?? state.data.call.project;

  // Opened without a call in progress: start the demo call
  const sessionChecked = useRef<boolean>(false);
  useEffect(() => {
    if (sessionChecked.current) {
      return;
    }
    sessionChecked.current = true;
    if (session.status !== "live") {
      startCall({ participants: [], projectId: DEMO_PROJECT_ID });
    }
  }, [session.status]);

  // The clock: call time and countdowns
  useEffect(() => {
    if (finishing) {
      return;
    }
    const timer = setInterval(() => dispatch({ type: "tick" }), 1000);
    return () => clearInterval(timer);
  }, [finishing]);

  // The agent and the recorder; pauses while finishing, resumes on cancel
  const feedPosition = useRef(feedStart(demo));
  useEffect(() => {
    if (finishing || feedPosition.current >= FEED_LENGTH) {
      return;
    }
    return subscribeToCallFeed((event) => dispatch({ event, type: "feed" }), {
      from: feedPosition.current,
      onStep: (next) => {
        feedPosition.current = next;
      },
    });
  }, [finishing]);

  // "Собираю итоги": steps, then the summary of the call
  useEffect(() => {
    if (!finishing) {
      return;
    }
    return collectSummary(
      (stage) => dispatch({ stage, type: "finish-stage" }),
      () => router.push(routes.callSummary(callId))
    );
  }, [callId, finishing, router]);

  // A lagging transcript catches up by itself
  const lagging = Boolean(state.data.transcript.notice);
  useEffect(() => {
    if (!lagging) {
      return;
    }
    return waitForTranscript(() => dispatch({ type: "transcript-caught-up" }));
  }, [lagging]);

  const end = useCallback(() => {
    finishCall();
    dispatch({ project: projectName, type: "finish-start" });
  }, [projectName]);

  const retry = useCallback(() => {
    dispatch({ type: "agent-retrying" });
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
  }, [track]);

  // Zero on the mic countdown ends the call; zero on the agent's retries
  const micExpired = state.micLeft === 0;
  useEffect(() => {
    if (micExpired) {
      end();
    }
  }, [end, micExpired]);

  const autoRetry = state.agentRetryIn === 0;
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

  const onCancelFinish = useCallback(() => {
    resumeCall();
    dispatch({ type: "finish-cancel" });
  }, []);

  const onCloseWindow = useCallback(() => {
    router.push(routes.callSummary(callId));
  }, [callId, router]);

  const onQuestionAction = useCallback(
    (topicId: string, questionId: string, action: QuestionQuickAction) =>
      dispatch({ action, questionId, topicId, type: "question" }),
    []
  );

  const onRestore = useCallback(
    (topicId: string, entryId: string) =>
      dispatch({ entryId, topicId, type: "restore" }),
    []
  );

  const onUnpin = useCallback(
    (topicId: string) => dispatch({ topicId, type: "unpin" }),
    []
  );

  const actions = useMemo<CallScreenActions>(
    () => ({
      onBannerAction,
      onCancelFinish,
      onCloseWindow,
      onEnd: end,
      onLeaveFinalCheck: () => dispatch({ type: "leave-final-check" }),
      onMicContinue: () => dispatch({ type: "mic-continue" }),
      onQuestionAction,
      onReconnect,
      onRestore,
      onToggleTranscript: () => dispatch({ type: "toggle-transcript" }),
      onUnpin,
    }),
    [
      end,
      onBannerAction,
      onCancelFinish,
      onCloseWindow,
      onQuestionAction,
      onReconnect,
      onRestore,
      onUnpin,
    ]
  );

  const data = useMemo(() => {
    const screen = toScreenData(state);
    return {
      ...screen,
      call: {
        ...screen.call,
        participants:
          session.participants.length > 0
            ? session.participants.join(", ")
            : screen.call.participants,
        project: projectName,
      },
    };
  }, [projectName, session.participants, state]);

  return <CallScreen actions={actions} className="h-svh" data={data} />;
}
