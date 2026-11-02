import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import type { SummaryProgress } from "@/data/calls";
import { PostCallBackend } from "@/features/post-call/backend";
import { PROCESSING_STEPS } from "@/features/post-call/mock";

const TICK_MS = 200;
const TICKS_PER_STEP = 3;

describe("PostCallBackend.layerMock", () => {
  it.effect("walks every processing step, then completes", () =>
    Effect.gen(function* () {
      const backend = yield* PostCallBackend;
      const seen: SummaryProgress[] = [];
      let ready = false;
      yield* Effect.forkChild(
        Stream.runForEach(backend.buildSummary("call-1"), (progress) =>
          Effect.sync(() => seen.push(progress))
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              ready = true;
            })
          )
        )
      );
      const ticks = PROCESSING_STEPS.length * TICKS_PER_STEP;

      yield* TestClock.adjust(TICK_MS);
      assert.deepStrictEqual(seen, [{ progress: 33, step: 0 }]);

      yield* TestClock.adjust(TICK_MS * (ticks - 2));
      assert.strictEqual(seen.length, ticks - 1);
      assert.deepStrictEqual(seen.at(-1), {
        progress: 67,
        step: PROCESSING_STEPS.length - 1,
      });
      assert.isFalse(ready);

      yield* TestClock.adjust(TICK_MS);
      assert.isTrue(ready);
    }).pipe(Effect.provide(PostCallBackend.layerMock))
  );

  it.effect("numbers the ClickUp tasks and GitHub issues it creates", () =>
    Effect.gen(function* () {
      const backend = yield* PostCallBackend;
      const fiber = yield* Effect.forkChild(
        Effect.all([
          backend.sendTaskCard("call-1", "card-1", "clickup"),
          backend.sendTaskCard("call-1", "card-2", "clickup"),
          backend.sendTaskCard("call-1", "card-1", "github"),
        ])
      );
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(yield* Fiber.join(fiber), [
        "CU-612",
        "CU-613",
        "#48",
      ]);
    }).pipe(Effect.provide(PostCallBackend.layerMock))
  );
});
