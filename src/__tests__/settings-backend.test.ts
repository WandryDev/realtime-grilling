import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { checkAgent, isAbortError } from "@/features/settings/api";
import { mockMicrophones, SettingsBackend } from "@/features/settings/backend";
import { DISCONNECTED_MICROPHONE } from "@/features/settings/mock";

describe("SettingsBackend.layerMock", () => {
  it.effect("finds the agent CLI only at a claude path", () =>
    Effect.gen(function* () {
      const backend = yield* SettingsBackend;
      const fiber = yield* Effect.forkChild(
        Effect.all(
          [
            backend.checkAgent("/usr/local/bin/claude"),
            backend.checkAgent("/usr/local/bin/node"),
            backend.checkAgent(),
          ],
          { concurrency: "unbounded" }
        )
      );
      yield* TestClock.adjust("1 second");
      const [found, missing, saved] = yield* Fiber.join(fiber);
      assert.strictEqual(found.status, "ready");
      assert.strictEqual(missing.status, "notInstalled");
      assert.strictEqual(saved.status, "ready");
    }).pipe(Effect.provide(SettingsBackend.layerMock))
  );

  it.effect("records a sound check", () =>
    Effect.gen(function* () {
      const backend = yield* SettingsBackend;
      const fiber = yield* Effect.forkChild(backend.soundCheck);
      yield* TestClock.adjust("2500 millis");
      assert.include(yield* Fiber.join(fiber), "Меня хорошо слышно");
    }).pipe(Effect.provide(SettingsBackend.layerMock))
  );

  it.effect("reports the microphones and an unplugged one", () =>
    Effect.gen(function* () {
      mockMicrophones.reset();
      const backend = yield* SettingsBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(backend.audioInputs, 2))
      );
      yield* Effect.yieldNow;
      mockMicrophones.disconnect(DISCONNECTED_MICROPHONE, 1000);
      const [before, after] = Array.from(yield* Fiber.join(fiber));
      assert.strictEqual(before?.devices.length, 2);
      assert.deepStrictEqual(
        after?.devices.map((device) => device.name),
        ["Микрофон MacBook Pro"]
      );
      assert.strictEqual(after?.missingSince, 1000);
      mockMicrophones.reset();
    }).pipe(Effect.provide(SettingsBackend.layerMock))
  );

  it.effect("says what to delete and where the recordings are", () =>
    Effect.gen(function* () {
      const backend = yield* SettingsBackend;
      const summary = yield* backend.dataSummary;
      const recordings = yield* backend.recordingsInfo;
      assert.strictEqual(summary.projects, 4);
      assert.strictEqual(recordings.calls, 38);
      assert.strictEqual(
        yield* backend.agentUsage.pipe(
          Effect.map((usage) => usage?.utilization)
        ),
        0.38
      );
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

  it("resolves to what the CLI at the path is", async () => {
    await expect(checkAgent("/usr/bin/node")).resolves.toEqual({
      status: "notInstalled",
    });
  });
});
