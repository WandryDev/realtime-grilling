import { Context, Effect, Layer, Queue, Stream } from "effect";

import {
  type AgentStatus,
  type CallState,
  commands,
  events,
  type QuestionAction,
} from "@/bindings";
import { createReadOrder } from "@/data/synced-store";
import { type BackendError, call, subscribe } from "@/effect/tauri";
import { RecordingBackend } from "@/features/recording/backend";
import { SpeechBackend } from "@/features/speech/backend";

import { CALL_SCRIPT, type FeedStep } from "./feed-script";
import {
  abandonedPhrases,
  type PendingPhrase,
  trackPending,
  transcriptFeedEvents,
} from "./transcript-feed";
import type { CallFeedEvent } from "./types";

/*
 * Backend contract of the call window: what the recorder and the agent push
 * during a call, and the one-off operations around it. `layerMock` plays
 * the scripted Телемедиа call (`./feed-script.ts`) with timers.
 *
 * `layerTauri` takes the transcript from the recognizer (the recording
 * running now, read first, then its events) and whether recognition works
 * from the recording status. Topics, questions, the final check and the
 * agent's state are the backend's (`agent`, agent-fast-loop design.md,
 * decision 11); the script only plays its context cards until the slow
 * loop comes.
 */

/**
 * One step of the feed: its events and the position of the script to
 * resume after it (none for the recognizer's events).
 */
export interface FeedUpdate {
  events: readonly CallFeedEvent[];
  next?: number;
}

/** Stages of the summary build (`SummaryStage`): transcript, summary, proposals, saving. */
export const SUMMARY_STAGES = 4;

export const AGENT_RETRY_MS = 1500;
export const SOURCE_RECONNECT_MS = 1500;
export const SYSTEM_AUDIO_GRANT_MS = 2500;
export const TRANSCRIPT_CATCH_UP_MS = 4000;

/** The script from step `from`, with the pauses between its steps. */
function playScript(
  script: readonly FeedStep[],
  from: number
): Stream.Stream<FeedUpdate> {
  return Stream.fromIterable(script.slice(from)).pipe(
    Stream.zipWithIndex,
    Stream.mapEffect(([step, index]) =>
      Effect.as(Effect.sleep(step.delay), {
        events: step.events,
        next: from + index + 1,
      })
    )
  );
}

/** The script's context cards: the transcript and the questions are real. */
const CONTEXT_SCRIPT: readonly FeedStep[] = CALL_SCRIPT.map((step) => ({
  ...step,
  events: step.events.filter((event) => event.type === "context"),
}));

/**
 * What the backend says about the questions of a recording: its whole
 * call state (with the agent's state, unless a newer status already came)
 * or a new status of the agent.
 */
export type CallAgentUpdate =
  | {
      readonly agent?: AgentStatus;
      readonly state: CallState;
      readonly type: "state";
    }
  | { readonly status: AgentStatus; readonly type: "status" };

type AgentTrigger =
  | { readonly read: number; readonly type: "read" }
  | {
      readonly read: number;
      readonly status: AgentStatus;
      readonly type: "status";
    };

/** Scopes of the read order: the call state and the agent's status. */
const STATE_SCOPE = "state";
const STATUS_SCOPE = "agent";

/**
 * The call state of `recordingId`: read once listening, then again on every
 * `CallStateChanged`, with the `AgentStatus` events in between. Reads may
 * finish out of order; an older one never replaces a newer state, and its
 * agent never replaces a newer status. A failed read keeps what is shown.
 */
function agentUpdates(
  recordingId: string
): Stream.Stream<CallAgentUpdate, BackendError> {
  return Stream.suspend(() => {
    const order = createReadOrder();
    const triggers = Stream.callback<AgentTrigger, BackendError>((queue) =>
      Effect.gen(function* () {
        yield* subscribe(events.callStateChanged, (change) => {
          if (change.recordingId === recordingId) {
            Queue.offerUnsafe(queue, { read: order.start(), type: "read" });
          }
        });
        yield* subscribe(events.agentStatus, (status) => {
          if (status.recordingId === recordingId) {
            Queue.offerUnsafe(queue, {
              read: order.start(),
              status,
              type: "status",
            });
          }
        });
        Queue.offerUnsafe(queue, { read: order.start(), type: "read" });
      })
    );

    const readState = (read: number) =>
      call(() => commands.callStateGet(recordingId)).pipe(
        Effect.map(({ agent, ...state }): CallAgentUpdate | null => {
          if (!order.accept(read, STATE_SCOPE)) {
            return null;
          }
          return order.accept(read, STATUS_SCOPE)
            ? { agent, state, type: "state" }
            : { state, type: "state" };
        }),
        Effect.catch(() => Effect.succeed(null))
      );

    return triggers.pipe(
      Stream.mapEffect(
        (trigger) => {
          if (trigger.type === "read") {
            return readState(trigger.read);
          }
          return Effect.sync((): CallAgentUpdate | null =>
            order.accept(trigger.read, STATUS_SCOPE)
              ? { status: trigger.status, type: "status" }
              : null
          );
        },
        { concurrency: "unbounded", unordered: true }
      ),
      Stream.filter((update): update is CallAgentUpdate => update !== null)
    );
  });
}

export class CallBackend extends Context.Service<
  CallBackend,
  {
    /** The live call from position `from`, one element per step. */
    readonly feed: (from: number) => Stream.Stream<FeedUpdate>;
    /**
     * The backend's questions of a recording (Tauri). The mock has none:
     * its questions come with the script's feed.
     */
    readonly agent: (
      recordingId: string
    ) => Stream.Stream<CallAgentUpdate, BackendError>;
    /**
     * «Закрепить» / «Открепить» / «Скрыть» / «Задал» / «Вернуть». The
     * mock does nothing: the window changes the scripted list itself.
     */
    readonly actOnQuestion: (
      id: string,
      action: QuestionAction
    ) => Effect.Effect<void, BackendError>;
    /**
     * «Повторить»: the agent of the recording calls again now. The mock
     * recovers after a moment.
     */
    readonly retryAgent: (
      recordingId: string | null
    ) => Effect.Effect<void, BackendError>;
    /** Reconnects an integration that lost its access (GitHub). */
    readonly reconnectSource: Effect.Effect<void>;
    /** Opens the privacy settings and waits for the permission. */
    readonly requestSystemAudio: Effect.Effect<void>;
    /** Waits until the lagging transcript catches up. */
    readonly waitForTranscript: Effect.Effect<void>;
  }
>()("grill/features/call/CallBackend") {
  static readonly layerMock = Layer.succeed(CallBackend, {
    actOnQuestion: () => Effect.void,
    agent: () => Stream.empty,
    feed: (from: number) => playScript(CALL_SCRIPT, from),
    reconnectSource: Effect.sleep(SOURCE_RECONNECT_MS),
    requestSystemAudio: Effect.sleep(SYSTEM_AUDIO_GRANT_MS),
    retryAgent: () => Effect.sleep(AGENT_RETRY_MS),
    waitForTranscript: Effect.sleep(TRANSCRIPT_CATCH_UP_MS),
  });

  static readonly layerTauri = Layer.effect(
    CallBackend,
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const speech = yield* SpeechBackend;

      // Whether the recording's phrases are recognized; nothing to say
      // while nothing is recorded.
      const transcription = recorder.watchStatus.pipe(
        Stream.filter((status) => status.id !== null),
        Stream.map((status) => status.transcription.state),
        Stream.changes,
        Stream.map(
          (state): FeedUpdate => ({
            events: [{ state, type: "transcription" }],
          })
        )
      );

      // The recording running now: what is stored, then its events. A new
      // recording ("Отменить завершение") takes over; a stopped one keeps
      // its last phrases coming until the next starts. Its phrases still
      // "расшифровываю" then become "пропущено": their text won't come here.
      const transcript = Stream.suspend(() => {
        let followed: {
          pending: Map<string, PendingPhrase>;
          recordingId: string;
        } | null = null;
        const follow = (recordingId: string) =>
          Stream.suspend(() => {
            const left = followed;
            const mine = {
              pending: new Map<string, PendingPhrase>(),
              recordingId,
            };
            followed = mine;
            const feed = speech.transcriptFeed(recordingId).pipe(
              Stream.map((event): FeedUpdate => {
                if (followed === mine) {
                  trackPending(mine.pending, recordingId, event);
                }
                return { events: transcriptFeedEvents(recordingId, event) };
              })
            );
            if (!left || left.pending.size === 0) {
              return feed;
            }
            const abandoned: FeedUpdate = {
              events: abandonedPhrases(left.recordingId, left.pending.values()),
            };
            return Stream.concat(Stream.succeed(abandoned), feed);
          });
        return recorder.watchStatus.pipe(
          Stream.map((status) => status.id),
          Stream.filter((id): id is string => id !== null),
          Stream.changes,
          Stream.switchMap(follow)
        );
      });

      const live = Stream.merge(transcription, transcript).pipe(
        // A failed read or listen leaves the feed to the script.
        Stream.catch(() => Stream.empty)
      );

      return CallBackend.of({
        actOnQuestion: (id: string, action: QuestionAction) =>
          call(() => commands.questionsAct(id, action)).pipe(Effect.asVoid),
        agent: agentUpdates,
        feed: (from: number) =>
          Stream.merge(playScript(CONTEXT_SCRIPT, from), live),
        reconnectSource: Effect.sleep(SOURCE_RECONNECT_MS),
        requestSystemAudio: Effect.sleep(SYSTEM_AUDIO_GRANT_MS),
        retryAgent: (recordingId: string | null) =>
          recordingId === null
            ? Effect.void
            : call(() => commands.agentRetry(recordingId)).pipe(Effect.asVoid),
        // The lag notice goes away with the recognizer's "caught up".
        waitForTranscript: Effect.never,
      });
    })
  );
}
