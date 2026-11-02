import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  type AgentEvent,
  type BriefProgress,
  CallWidgetBackend,
  FIRST_QUESTION_MS,
  NEXT_QUESTION_MS,
  THINKING_MS,
} from "@/features/call-widget/backend";
import type { Participant } from "@/features/call-widget/mock";

const OLGA: Participant = {
  genitive: "Ольги",
  id: "olga",
  initials: "ОК",
  name: "Ольга",
};

describe("CallWidgetBackend.layerMock", () => {
  it.effect("reports the brief right away, then after every step", () =>
    Effect.gen(function* () {
      const backend = yield* CallWidgetBackend;
      const seen: BriefProgress[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(backend.buildBrief([OLGA]), (progress) =>
          Effect.sync(() => seen.push(progress))
        )
      );
      yield* Effect.yieldNow;
      assert.strictEqual(seen.length, 1);
      assert.deepStrictEqual(
        seen[0]?.steps.map((step) => step.status),
        ["active", "pending", "pending", "pending"]
      );
      assert.strictEqual(seen[0]?.steps[1]?.label, "Профили Ольги");

      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(seen.length, 5);
      const last = seen.at(-1);
      assert.isTrue(last?.done);
      assert.strictEqual(last?.progress, 100);
    }).pipe(Effect.provide(CallWidgetBackend.layerMock))
  );

  it.effect("thinks before each question, then asks every 20 seconds", () =>
    Effect.gen(function* () {
      const backend = yield* CallWidgetBackend;
      const seen: AgentEvent["type"][] = [];
      yield* Effect.forkChild(
        Stream.runForEach(backend.agentFeed, (event) =>
          Effect.sync(() => seen.push(event.type))
        )
      );
      yield* TestClock.adjust(FIRST_QUESTION_MS - THINKING_MS);
      assert.deepStrictEqual(seen, ["thinking"]);
      yield* TestClock.adjust(THINKING_MS);
      assert.deepStrictEqual(seen, ["thinking", "question"]);
      yield* TestClock.adjust(NEXT_QUESTION_MS);
      assert.deepStrictEqual(seen, [
        "thinking",
        "question",
        "thinking",
        "question",
      ]);
    }).pipe(Effect.provide(CallWidgetBackend.layerMock))
  );
});
