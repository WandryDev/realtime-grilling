import { Context, Effect, Layer, Stream } from "effect";

import { CALL_SCRIPT } from "./feed-script";
import type { CallFeedEvent } from "./types";

/*
 * Backend contract of the call window: what the recorder and the agent push
 * during a call, and the one-off operations around it. `layerMock` plays
 * the scripted Телемедиа call (`./feed-script.ts`) with timers; the Tauri
 * layer will read the same feed from Rust events and commands.
 */

/** One step of the feed: its events and the position to resume after it. */
export interface FeedUpdate {
  events: readonly CallFeedEvent[];
  next: number;
}

/** Stages of the summary: transcript, summary, open questions, brief. */
export const SUMMARY_STAGES = 4;
const SUMMARY_STAGE_MS = 1500;

export const AGENT_RETRY_MS = 1500;
export const SOURCE_RECONNECT_MS = 1500;
export const SYSTEM_AUDIO_GRANT_MS = 2500;
export const TRANSCRIPT_CATCH_UP_MS = 4000;

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
    collectSummary: Stream.range(2, SUMMARY_STAGES).pipe(
      Stream.mapEffect((stage) =>
        Effect.as(Effect.sleep(SUMMARY_STAGE_MS), stage)
      )
    ),
    feed: (from: number) =>
      Stream.fromIterable(CALL_SCRIPT.slice(from)).pipe(
        Stream.zipWithIndex,
        Stream.mapEffect(([step, index]) =>
          Effect.as(Effect.sleep(step.delay), {
            events: step.events,
            next: from + index + 1,
          })
        )
      ),
    reconnectSource: Effect.sleep(SOURCE_RECONNECT_MS),
    requestSystemAudio: Effect.sleep(SYSTEM_AUDIO_GRANT_MS),
    retryAgent: Effect.sleep(AGENT_RETRY_MS),
    waitForTranscript: Effect.sleep(TRANSCRIPT_CATCH_UP_MS),
  });
}
