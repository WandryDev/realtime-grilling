import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { checkAgent, isAbortError } from "@/features/settings/api";
import { SettingsBackend } from "@/features/settings/backend";

describe("SettingsBackend.layerMock", () => {
  it.effect("reports progress up to 100 while moving the recordings", () =>
    Effect.gen(function* () {
      const backend = yield* SettingsBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.moveRecordings("~/Grill"))
      );
      yield* TestClock.adjust("2 seconds");
      const progress = Array.from(yield* Fiber.join(fiber));
      assert.strictEqual(progress.length, 20);
      assert.strictEqual(progress[0], 5);
      assert.strictEqual(progress.at(-1), 100);
    }).pipe(Effect.provide(SettingsBackend.layerMock))
  );

  it.effect("finds the agent CLI only at a claude path", () =>
    Effect.gen(function* () {
      const backend = yield* SettingsBackend;
      const fiber = yield* Effect.forkChild(
        Effect.all(
          [
            Effect.exit(backend.checkAgent("/usr/local/bin/claude")),
            Effect.flip(backend.checkAgent("/usr/local/bin/node")),
          ],
          { concurrency: "unbounded" }
        )
      );
      yield* TestClock.adjust("2 seconds");
      const [found, missing] = yield* Fiber.join(fiber);
      assert.strictEqual(found._tag, "Success");
      assert.strictEqual(missing._tag, "AgentCheckError");
      assert.strictEqual(
        missing.message,
        "По пути /usr/local/bin/node нет Claude Code"
      );
    }).pipe(Effect.provide(SettingsBackend.layerMock))
  );

  it.effect("records a sound check", () =>
    Effect.gen(function* () {
      const backend = yield* SettingsBackend;
      const fiber = yield* Effect.forkChild(backend.soundCheck);
      yield* TestClock.adjust("2500 millis");
      const result = yield* Fiber.join(fiber);
      assert.include(result.you, "Меня хорошо слышно");
    }).pipe(Effect.provide(SettingsBackend.layerMock))
  );
});

describe("settings api", () => {
  it("rejects with an AbortError when the signal aborts", async () => {
    const controller = new AbortController();
    const check = checkAgent("/usr/local/bin/claude", controller.signal);
    controller.abort();
    const error = await check.catch((reason: unknown) => reason);
    expect(isAbortError(error)).toBe(true);
  });

  it("rejects with the backend message when the check fails", async () => {
    await expect(checkAgent("/usr/bin/node")).rejects.toThrow(
      "По пути /usr/bin/node нет Claude Code"
    );
  });
});
