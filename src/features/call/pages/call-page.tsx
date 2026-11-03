"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";

import { toast } from "@/components/ui/toast";
import { startCall, useCallSession } from "@/data/call-session";
import { useProject } from "@/data/projects";
import { autoEndSeconds, useSettings } from "@/data/settings";
import { inTauri } from "@/effect/runtime";
import {
  adoptRunningRecording,
  finishRecordedCall,
  releaseMicDemo,
  resumeRecordedCall,
  subscribeToMicActivity,
  useRecordingSignal,
} from "@/features/recording/api";
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
  type LiveCallAction,
  type LiveCallState,
  liveCallReducer,
  startingCall,
  toScreenData,
} from "../live-call";
import { CALL_SCREENS } from "../mock";
import { CallScreen } from "../screens/call-screen";
import type {
  CallFeedEvent,
  CallScreenActions,
  CallScreenState,
  QuestionQuickAction,
} from "../types";

/*
 * /call: the live call window. The feed from ../api streams the transcript,
 * topics, questions and context (in Tauri the transcript is the
 * recognizer's, the rest scripted); clicks change the questions
 * locally; "Завершить" stops the recording, collects the summary and
 * opens it.
 *
 * "Микрофон освободился" comes from the microphone watch while the call is
 * live: the app's name and the time it let go, the countdown from the
 * "Завершать звонок сам" setting. "Продолжить" (or the app taking the
 * microphone back) hides it until the next release. In the browser the
 * script's last step frees the mock meeting app's microphone.
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

/**
 * The window as it opens. In Tauri the transcript is the recognizer's, so
 * the starting call has none of the demo's phrases.
 */
function initialState(demo: CallDemoState | undefined): LiveCallState {
  if (demo) {
    return createLiveCall(CALL_SCREENS[demo]);
  }
  const starting = startingCall();
  if (!inTauri) {
    return starting;
  }
  return {
    ...starting,
    data: {
      ...starting.data,
      transcript: { ...starting.data.transcript, items: [] },
    },
  };
}

export function CallPage() {
  const demo = useDemoState(CALL_DEMO_STATES);
  // A forced state starts the window over
  return <LiveCallWindow demo={demo} key={demo ?? "live"} />;
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
  const project = useProject(session.projectId ?? DEMO_PROJECT_ID);
  const [state, dispatch] = useReducer(liveCallReducer, demo, initialState);
  const track = usePendingOperations();
  const { autoEnd } = useSettings();
  const signal = useRecordingSignal();

  const { callId } = session;
  const finishing = Boolean(state.data.finishing);
  const projectName = project?.name ?? state.data.call.project;

  // Opened without a call in progress: start the demo call. Either way the
  // recording running now is the call's, also one this window never heard
  // of (it opened before the widget's session reached it, or reloaded).
  const sessionChecked = useRef<boolean>(false);
  useEffect(() => {
    if (sessionChecked.current) {
      return;
    }
    sessionChecked.current = true;
    if (session.status !== "live") {
      startCall({ participants: [], projectId: DEMO_PROJECT_ID });
    }
    adoptRunningRecording();
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

  // The meeting app and the microphone: a release while the call is live
  // offers to end it, the app taking the microphone back hides the offer.
  const live = session.status === "live";
  const watch = useRef({ live, timeout: autoEndSeconds(autoEnd) });
  useEffect(() => {
    watch.current = { live, timeout: autoEndSeconds(autoEnd) };
  }, [autoEnd, live]);
  useEffect(
    () =>
      subscribeToMicActivity((activity) => {
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
      }),
    []
  );

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
    finishRecordedCall();
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
    resumeRecordedCall();
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
        level: signal.level,
        participants:
          session.participants.length > 0
            ? session.participants.join(", ")
            : screen.call.participants,
        project: projectName,
        warning: signal.warning,
      },
    };
  }, [projectName, session.participants, signal, state]);

  return <CallScreen actions={actions} className="h-svh" data={data} />;
}
