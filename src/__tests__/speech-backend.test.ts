import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach } from "vitest";

import {
  mockMicActivity,
  RecordingBackend,
} from "@/features/recording/backend";
import {
  MOCK_BENCHMARK,
  MOCK_MIC_TEXT,
  MOCK_SPEECH_DELAY_MS,
  mockSpeechModels,
  SpeechBackend,
  type SpeechModel,
} from "@/features/speech/backend";

/*
 * SpeechBackend.layerMock: the two models on fake timers, as the browser
 * and the screen tests see them. The Tauri layer is tested over the fake
 * IPC in `tauri-speech.test.ts`.
 */

const TICKS_TO_FULL = 40;
const MockLayer = Layer.merge(
  SpeechBackend.layerMock,
  RecordingBackend.layerMock
);

beforeEach(() => {
  mockSpeechModels.reset();
  mockMicActivity.reset();
});

function statuses(models: readonly SpeechModel[]) {
  return models.map((model) => `${model.id}:${model.state.status}`);
}

describe("SpeechBackend.layerMock", () => {
  it.effect("lists both models, not downloaded, turbo selected", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const models = yield* speech.models;
      assert.deepStrictEqual(statuses(models), [
        "turbo:notDownloaded",
        "small:notDownloaded",
      ]);
      assert.deepStrictEqual(
        models.map((model) => model.selected),
        [true, false]
      );
      assert.isTrue(models.every((model) => model.sizeBytes > 0));
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("downloads, checks the sum and becomes ready", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const seen: string[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(speech.modelChanges, (model) =>
          Effect.sync(() => seen.push(model.state.status))
        )
      );
      yield* Effect.yieldNow;

      const started = yield* speech.download("turbo");
      assert.strictEqual(started.state.status, "downloading");
      yield* TestClock.adjust(
        MOCK_SPEECH_DELAY_MS.downloadTick * TICKS_TO_FULL
      );
      assert.strictEqual(seen.at(-1), "checking");
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.checksum);

      const [turbo] = yield* speech.models;
      assert.strictEqual(turbo?.state.status, "ready");
      assert.deepStrictEqual(seen.slice(-2), ["checking", "ready"]);
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("pauses where it is and resumes from there", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      yield* speech.download("small");
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.downloadTick * 4);
      const paused = yield* speech.pause("small");
      assert.deepStrictEqual(paused.state, { percent: 10, status: "paused" });

      // Nothing moves while paused.
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.downloadTick * 10);
      const [, still] = yield* speech.models;
      assert.deepStrictEqual(still?.state, { percent: 10, status: "paused" });

      const resumed = yield* speech.download("small");
      assert.strictEqual(resumed.state.status, "downloading");
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.downloadTick);
      const [, next] = yield* speech.models;
      assert.deepStrictEqual(next?.state, {
        bytesPerSec: 12_400_000,
        percent: 12.5,
        status: "downloading",
      });

      const cancelled = yield* speech.cancel("small");
      assert.strictEqual(cancelled.state.status, "notDownloaded");
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("watches both models: the list now, then after each change", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const lists = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(speech.watchModels, 2))
      );
      yield* Effect.yieldNow;
      yield* speech.download("turbo");
      const [now, changed] = Array.from(yield* Fiber.join(lists));
      assert.deepStrictEqual(statuses(now ?? []), [
        "turbo:notDownloaded",
        "small:notDownloaded",
      ]);
      assert.deepStrictEqual(statuses(changed ?? []), [
        "turbo:downloading",
        "small:notDownloaded",
      ]);
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("selects only a ready model", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const refused = yield* Effect.flip(speech.select("small"));
      assert.strictEqual(refused.kind, "Invalid");

      mockSpeechModels.force("small", { status: "ready" });
      const small = yield* speech.select("small");
      assert.isTrue(small.selected);
      const [turbo] = yield* speech.models;
      assert.isFalse(turbo?.selected);
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("keeps the selected model while recording", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const recorder = yield* RecordingBackend;
      mockSpeechModels.force("turbo", { status: "ready" });
      mockSpeechModels.force("small", { status: "ready" });
      const id = yield* recorder.start();

      const removing = yield* Effect.flip(speech.remove("turbo"));
      assert.strictEqual(removing.kind, "Invalid");
      const switching = yield* Effect.flip(speech.select("small"));
      assert.strictEqual(switching.kind, "Invalid");
      const checking = yield* Effect.flip(speech.benchmark("turbo"));
      assert.strictEqual(checking.kind, "Invalid");
      // The other one can go.
      const small = yield* speech.remove("small");
      assert.strictEqual(small.state.status, "notDownloaded");

      yield* recorder.stop(id);
      const turbo = yield* speech.remove("turbo");
      assert.strictEqual(turbo.state.status, "notDownloaded");
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("checks the hardware of a ready model", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const missing = yield* speech.benchmark("turbo");
      assert.strictEqual(missing.reason, "noModel");

      mockSpeechModels.force("turbo", { status: "ready" });
      const fiber = yield* Effect.forkChild(speech.benchmark("turbo"));
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.benchmark);
      assert.deepStrictEqual(yield* Fiber.join(fiber), MOCK_BENCHMARK);
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("hears the mic check with the selected model, at once", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const refused = yield* Effect.flip(speech.micCheck);
      assert.strictEqual(refused.kind, "Invalid");

      mockSpeechModels.force("turbo", { status: "ready" });
      const fiber = yield* Effect.forkChild(speech.micCheck);
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.micCheck);
      assert.strictEqual(yield* Fiber.join(fiber), MOCK_MIC_TEXT);
    }).pipe(Effect.provide(MockLayer))
  );

  it.effect("refines a recording to done", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(speech.refine("recording-1"))
      );
      yield* TestClock.adjust(MOCK_SPEECH_DELAY_MS.refineStep * 5);
      const steps = Array.from(yield* Fiber.join(fiber));
      assert.deepStrictEqual(steps.at(-1), { progress: 100, state: "done" });
      assert.isTrue(
        steps.slice(0, -1).every((step) => step.state === "refining")
      );
    }).pipe(Effect.provide(MockLayer))
  );
});
