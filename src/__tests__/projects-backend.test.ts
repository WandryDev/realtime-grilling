import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  BRIEF_BUILD_STAGES,
  ProjectsBackend,
} from "@/features/projects/backend";

describe("ProjectsBackend.layerMock", () => {
  it.effect("emits every brief build stage in order", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.buildBrief("telemedia"))
      );
      yield* TestClock.adjust("5 seconds");
      const stages = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        Array.from(stages),
        Array.from({ length: BRIEF_BUILD_STAGES }, (_, index) => index + 1)
      );
    }).pipe(Effect.provide(ProjectsBackend.layerMock))
  );

  it.effect("exports markdown into the Grill folder", () =>
    Effect.gen(function* () {
      const backend = yield* ProjectsBackend;
      const fiber = yield* Effect.forkChild(
        backend.exportMarkdown("brief", "Телемедиа")
      );
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(fiber), "Документы / Grill");
    }).pipe(Effect.provide(ProjectsBackend.layerMock))
  );
});
