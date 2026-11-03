import { Context, Effect, Layer, Stream } from "effect";

import { RecordingBackend } from "@/features/recording/backend";
import { SpeechBackend } from "@/features/speech/backend";

import { CALL_SCRIPT, type FeedStep } from "./feed-script";
import { transcriptFeedEvents } from "./transcript-feed";
import type { CallFeedEvent } from "./types";

/*
 * Backend contract of the call window: what the recorder and the agent push
 * during a call, and the one-off operations around it. `layerMock` plays
 * the scripted Телемедиа call (`./feed-script.ts`) with timers.
 *
 * `layerTauri` takes the transcript from the recognizer (the recording
 * running now, read first, then its events) and whether recognition works
 * from the recording status; topics, questions and context stay on the
 * script, without its transcript, until the agent comes (task 6).
 */

/**
 * One step of the feed: its events and the position of the script to
 * resume after it (none for the recognizer's events).
 */
export interface FeedUpdate {
  events: readonly CallFeedEvent[];
  next?: number;
}

/** Stages of the summary: transcript, summary, open questions, brief. */
export const SUMMARY_STAGES = 4;
const SUMMARY_STAGE_MS = 1500;

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

const TRANSCRIPT_EVENTS: ReadonlySet<CallFeedEvent["type"]> = new Set([
  "transcript",
  "transcript-pending",
  "transcript-remove",
  "transcript-lag",
]);

/** The script's agent: everything but the transcript, which is real. */
const AGENT_SCRIPT: readonly FeedStep[] = CALL_SCRIPT.map((step) => ({
  ...step,
  events: step.events.filter((event) => !TRANSCRIPT_EVENTS.has(event.type)),
}));

const collectSummary = Stream.range(2, SUMMARY_STAGES).pipe(
  Stream.mapEffect((stage) => Effect.as(Effect.sleep(SUMMARY_STAGE_MS), stage))
);

export class CallBackend extends Context.Service<
  CallBackend,
  {
    /** The live call from position `from`, one element per step. */
    readonly feed: (from: number) => Stream.Stream<FeedUpdate>;
    /**
     * "Собираю итоги": every finished stage after the transcript, which is
     * ready right away; the last one is `SUMMARY_STAGES`.
     */
    readonly collectSummary: Stream.Stream<number>;
    /** Restarts the agent session after it stopped answering. */
    readonly retryAgent: Effect.Effect<void>;
    /** Reconnects an integration that lost its access (GitHub). */
    readonly reconnectSource: Effect.Effect<void>;
    /** Opens the privacy settings and waits for the permission. */
    readonly requestSystemAudio: Effect.Effect<void>;
    /** Waits until the lagging transcript catches up. */
    readonly waitForTranscript: Effect.Effect<void>;
  }
>()("grill/features/call/CallBackend") {
  static readonly layerMock = Layer.succeed(CallBackend, {
    collectSummary,
    feed: (from: number) => playScript(CALL_SCRIPT, from),
    reconnectSource: Effect.sleep(SOURCE_RECONNECT_MS),
    requestSystemAudio: Effect.sleep(SYSTEM_AUDIO_GRANT_MS),
    retryAgent: Effect.sleep(AGENT_RETRY_MS),
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
      // its last phrases coming until the next starts.
      const transcript = recorder.watchStatus.pipe(
        Stream.map((status) => status.id),
        Stream.filter((id): id is string => id !== null),
        Stream.changes,
        Stream.switchMap((recordingId) =>
          speech.transcriptFeed(recordingId).pipe(
            Stream.map(
              (event): FeedUpdate => ({
                events: transcriptFeedEvents(recordingId, event),
              })
            )
          )
        )
      );

      const live = Stream.merge(transcription, transcript).pipe(
        // A failed read or listen leaves the feed to the script.
        Stream.catch(() => Stream.empty)
      );

      return CallBackend.of({
        collectSummary,
        feed: (from: number) =>
          Stream.merge(playScript(AGENT_SCRIPT, from), live),
        reconnectSource: Effect.sleep(SOURCE_RECONNECT_MS),
        requestSystemAudio: Effect.sleep(SYSTEM_AUDIO_GRANT_MS),
        retryAgent: Effect.sleep(AGENT_RETRY_MS),
        // The lag notice goes away with the recognizer's "caught up".
        waitForTranscript: Effect.never,
      });
    })
  );
}
