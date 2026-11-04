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
  actOnQuestion,
  type CallAgentUpdate,
  collectSummary,
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
import {
  FEED_LENGTH,
  feedCheckpoint,
  RECONNECTED_GITHUB,
} from "../feed-script";
import {
  backendCall,
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
 * topics, questions and context; clicks change the questions locally;
 * "Завершить" stops the recording, collects the summary and opens it.
 *
 * In Tauri the transcript is the recognizer's and the questions the
 * backend's: the call state of the session's recording and the agent's
 * status come from `subscribeToCallAgent`, the quick actions and
 * «Повторить» go to the backend, which answers with a new state. Only
 * "Вернуться к темам" stays on the screen.
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
 * The window as it opens. In Tauri the transcript is the recognizer's and
 * the questions the backend's, so the starting call has none of the demo's.
 */
function initialState(demo: CallDemoState | undefined): LiveCallState {
  if (demo) {
    return createLiveCall(CALL_SCREENS[demo]);
  }
  return questionsFromBackend ? backendCall() : startingCall();
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

/** Id of the question pinned in the topic, if any. */
function pinnedIn(state: LiveCallState, topicId: string) {
  const { current } = state.data.questions;
  return current?.id === topicId ? current.pinned?.id : undefined;
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

  const { callId, recordingId, startedAt } = session;
  const finishing = Boolean(state.data.finishing);
  const fromBackend = state.backend !== null;

  // The latest state for the handlers that read it (the pinned question).
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);
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

  // The backend's questions of the session's recording
  useEffect(() => {
    if (!(fromBackend && recordingId)) {
      return;
    }
    return subscribeToCallAgent(recordingId, agentHandler(dispatch, startedAt));
  }, [fromBackend, recordingId, startedAt]);

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

  // Zero on the mic countdown ends the call; zero on the agent's retries
  const micExpired = state.micLeft === 0;
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

  const onCancelFinish = useCallback(() => {
    resumeRecordedCall();
    dispatch({ type: "finish-cancel" });
  }, []);

  const onCloseWindow = useCallback(() => {
    router.push(routes.callSummary(callId));
  }, [callId, router]);

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
      onLeaveFinalCheck: () => dispatch({ type: "leave-final-check" }),
      onMicContinue: () => dispatch({ type: "mic-continue" }),
      onQuestionAction,
      onReconnect,
      onRestore,
      onReturnToFinalCheck: () => dispatch({ type: "return-final-check" }),
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
