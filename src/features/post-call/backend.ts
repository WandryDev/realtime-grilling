import { Context, Effect, Layer, Stream } from "effect";

import type { SummaryProgress, TaskSyncService } from "@/data/calls";
import { type RefineProgress, SpeechBackend } from "@/features/speech/backend";

import { PROCESSING_STEPS } from "./mock";

/*
 * Backend contract of what the local agent does after a call: building the
 * summary and sending a task card to ClickUp or GitHub. `layerMock` fakes
 * both with timers.
 *
 * `layerTauri` runs the first step, "Расшифровка", on the second pass of
 * the call's recording (speech-recognition design.md, decision 18); the
 * other steps and the task cards stay mocked until the agent (task 10).
 */

const TICKS_PER_STEP = 3;
const TICK_MS = 200;
const PERCENT = 100;
const SEND_MS = 1400;
const FIRST_CLICKUP_TASK = 612;
const FIRST_GITHUB_ISSUE = 48;

/** The step the second pass drives. */
const TRANSCRIPT_STEP = 0;
/**
 * How long the step waits for news of the second pass before it goes on
 * without it (no model, another recording first, a long file decoding).
 */
export const REFINE_SILENCE_MS = 60_000;

/** The mocked steps from `fromStep`, a few ticks each. */
function summarySteps(fromStep: number): Stream.Stream<SummaryProgress> {
  const total = PROCESSING_STEPS.length * TICKS_PER_STEP;
  return Stream.range(fromStep * TICKS_PER_STEP + 1, total - 1).pipe(
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
  );
}

type Refined = NonNullable<SummaryProgress["transcript"]> | "done";

/**
 * The second pass of `recordingId`: its progress, then how it ended. A
 * pass that is already over (its refined segments are stored) is done at
 * once; one without news for `REFINE_SILENCE_MS` goes on in the background.
 */
function refineOf(
  speech: SpeechBackend["Service"],
  recordingId: string
): Stream.Stream<RefineProgress | Refined> {
  const already = speech.transcript(recordingId).pipe(
    Effect.map((segments) =>
      segments.some((segment) => segment.pass === "refined")
    ),
    Effect.catch(() => Effect.succeed(false))
  );
  const events = Stream.merge(
    speech.refine(recordingId),
    Stream.fromEffect(already).pipe(
      Stream.filter(Boolean),
      Stream.map((): RefineProgress => ({ progress: 100, state: "done" }))
    )
  ).pipe(
    Stream.takeUntil((event) => event.state !== "refining"),
    Stream.map((event): RefineProgress | Refined => {
      if (event.state === "refining") {
        return event;
      }
      return event.state === "done" ? "done" : "failed";
    }),
    Stream.catch(() => Stream.succeed<Refined>("later"))
  );
  return events.pipe(
    Stream.timeoutOrElse({
      duration: REFINE_SILENCE_MS,
      orElse: () => Stream.succeed<Refined>("later"),
    })
  );
}

/** "Расшифровка" on the second pass, then the mocked steps. */
function summaryAfterRefine(
  speech: SpeechBackend["Service"],
  recordingId: string
): Stream.Stream<SummaryProgress> {
  return Stream.suspend(() => {
    let transcript: SummaryProgress["transcript"];
    const refine = refineOf(speech, recordingId).pipe(
      Stream.filter((event): event is RefineProgress => {
        if (typeof event === "string") {
          transcript = event === "done" ? undefined : event;
          return false;
        }
        return true;
      }),
      Stream.map(
        (event): SummaryProgress => ({
          progress: event.progress,
          step: TRANSCRIPT_STEP,
        })
      )
    );
    const rest = Stream.suspend(() =>
      summarySteps(TRANSCRIPT_STEP + 1).pipe(
        Stream.map((progress) =>
          transcript ? { ...progress, transcript } : progress
        )
      )
    );
    return Stream.concat(refine, rest);
  });
}

export class PostCallBackend extends Context.Service<
  PostCallBackend,
  {
    /**
     * Builds the summary of a finished call. Emits the progress of each
     * processing step and completes when the summary is ready. With the
     * call's `recordingId` the transcript step follows its second pass.
     */
    readonly buildSummary: (
      callId: string,
      recordingId?: string
    ) => Stream.Stream<SummaryProgress>;
    /** Creates a ClickUp task or a GitHub issue; its reference. */
    readonly sendTaskCard: (
      callId: string,
      cardId: string,
      service: TaskSyncService
    ) => Effect.Effect<string>;
  }
>()("grill/features/post-call/PostCallBackend") {
  static readonly layerMock = Layer.sync(PostCallBackend, () =>
    PostCallBackend.of({
      buildSummary: (_callId: string, _recordingId?: string) => summarySteps(0),
      sendTaskCard: mockTaskCards(),
    })
  );

  static readonly layerTauri = Layer.effect(
    PostCallBackend,
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      return PostCallBackend.of({
        buildSummary: (_callId: string, recordingId?: string) =>
          recordingId === undefined
            ? summarySteps(0)
            : summaryAfterRefine(speech, recordingId),
        sendTaskCard: mockTaskCards(),
      });
    })
  );
}

/** Task cards "sent" after a moment, numbered on from the last one. */
function mockTaskCards() {
  let nextClickUpTask = FIRST_CLICKUP_TASK;
  let nextGitHubIssue = FIRST_GITHUB_ISSUE;
  return Effect.fn("PostCallBackend.sendTaskCard")(function* (
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
  });
}
