import { Context, Effect, Layer, Stream } from "effect";

import type { SummaryProgress, TaskSyncService } from "@/data/calls";

import { PROCESSING_STEPS } from "./mock";

/*
 * Backend contract of what the local agent does after a call: building the
 * summary and sending a task card to ClickUp or GitHub. `layerMock` fakes
 * both with timers; the Tauri layer will run them in Rust.
 */

const TICKS_PER_STEP = 3;
const TICK_MS = 200;
const PERCENT = 100;
const SEND_MS = 1400;
const FIRST_CLICKUP_TASK = 612;
const FIRST_GITHUB_ISSUE = 48;

export class PostCallBackend extends Context.Service<
  PostCallBackend,
  {
    /**
     * Builds the summary of a finished call. Emits the progress of each
     * processing step and completes when the summary is ready.
     */
    readonly buildSummary: (callId: string) => Stream.Stream<SummaryProgress>;
    /** Creates a ClickUp task or a GitHub issue; its reference. */
    readonly sendTaskCard: (
      callId: string,
      cardId: string,
      service: TaskSyncService
    ) => Effect.Effect<string>;
  }
>()("grill/features/post-call/PostCallBackend") {
  static readonly layerMock = Layer.sync(PostCallBackend, () => {
    let nextClickUpTask = FIRST_CLICKUP_TASK;
    let nextGitHubIssue = FIRST_GITHUB_ISSUE;
    const total = PROCESSING_STEPS.length * TICKS_PER_STEP;

    return {
      buildSummary: (_callId: string) =>
        Stream.range(1, total - 1).pipe(
          Stream.mapEffect((tick) =>
            Effect.as(Effect.sleep(TICK_MS), {
              progress: Math.round(
                ((tick % TICKS_PER_STEP) / TICKS_PER_STEP) * PERCENT
              ),
              step: Math.floor(tick / TICKS_PER_STEP),
            })
          ),
          // The last tick finishes the summary, it has no progress of its own.
          Stream.concat(Stream.drain(Stream.fromEffect(Effect.sleep(TICK_MS))))
        ),
      sendTaskCard: Effect.fn("PostCallBackend.sendTaskCard")(function* (
        _callId: string,
        _cardId: string,
        service: TaskSyncService
      ) {
        yield* Effect.sleep(SEND_MS);
        if (service === "clickup") {
          const ref = `CU-${nextClickUpTask}`;
          nextClickUpTask += 1;
          return ref;
        }
        const ref = `#${nextGitHubIssue}`;
        nextGitHubIssue += 1;
        return ref;
      }),
    };
  });
}
