import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  CallBackend,
  type FeedUpdate,
  SUMMARY_STAGES,
  TRANSCRIPT_CATCH_UP_MS,
} from "@/features/call/backend";
import {
  CALL_SCRIPT,
  FEED_LENGTH,
  feedCheckpoint,
} from "@/features/call/feed-script";

describe("CallBackend.layerMock", () => {
  it.effect("plays each step of the feed after its delay", () =>
    Effect.gen(function* () {
      const backend = yield* CallBackend;
      const seen: FeedUpdate[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(backend.feed(0), (update) =>
          Effect.sync(() => seen.push(update))
        )
      );
      const [first, second] = CALL_SCRIPT;
      yield* TestClock.adjust((first?.delay ?? 0) - 1);
      assert.strictEqual(seen.length, 0);
      yield* TestClock.adjust(1);
      assert.deepStrictEqual(seen, [{ events: first?.events ?? [], next: 1 }]);
      yield* TestClock.adjust(second?.delay ?? 0);
      assert.deepStrictEqual(
        seen.map((update) => update.next),
        [1, 2]
      );
    }).pipe(Effect.provide(CallBackend.layerMock))
  );

  it.effect("resumes from a checkpoint and ends with the microphone", () =>
    Effect.gen(function* () {
      const backend = yield* CallBackend;
      const from = feedCheckpoint("final-check");
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.feed(from))
      );
      yield* TestClock.adjust("1 minute");
      const updates = Array.from(yield* Fiber.join(fiber));
      assert.deepStrictEqual(
        updates.map((update) => update.next),
        Array.from(
          { length: FEED_LENGTH - from },
          (_, index) => from + index + 1
        )
      );
      assert.deepStrictEqual(updates.at(-1)?.events, [
        { type: "mic-released" },
      ]);
    }).pipe(Effect.provide(CallBackend.layerMock))
  );

  it.effect("finishes the summary stages after the transcript", () =>
    Effect.gen(function* () {
      const backend = yield* CallBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.collectSummary)
      );
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(Array.from(yield* Fiber.join(fiber)), [
        2,
        3,
        SUMMARY_STAGES,
      ]);
    }).pipe(Effect.provide(CallBackend.layerMock))
  );

  it.effect("lets the lagging transcript catch up after a while", () =>
    Effect.gen(function* () {
      const backend = yield* CallBackend;
      let caughtUp = false;
      yield* Effect.forkChild(
        backend.waitForTranscript.pipe(
          Effect.andThen(
            Effect.sync(() => {
              caughtUp = true;
            })
          )
        )
      );
      yield* TestClock.adjust(TRANSCRIPT_CATCH_UP_MS - 1);
      assert.isFalse(caughtUp);
      yield* TestClock.adjust(1);
      assert.isTrue(caughtUp);
    }).pipe(Effect.provide(CallBackend.layerMock))
  );
});
