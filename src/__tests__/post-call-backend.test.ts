import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { PostCallBackend } from "@/features/post-call/backend";

describe("PostCallBackend.layerMock", () => {
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
