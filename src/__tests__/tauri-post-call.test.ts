import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, vi } from "vitest";

import type { TranscriptSegment } from "@/bindings";
import type { SummaryProgress } from "@/data/calls";

/*
 * «Сборка итогов» in Tauri, over the fake IPC (./helpers/fake-tauri.ts):
 * the «Расшифровка» step follows the second pass of the call's recording
 * (speech-recognition design.md, decision 18); `done` completes it, a
 * failure keeps the live transcript, and no news lets the summary go on.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));

const { PostCallBackend, REFINE_SILENCE_MS } = await import(
  "@/features/post-call/backend"
);
const { SpeechBackend } = await import("@/features/speech/backend");
const { processingSteps } = await import("@/features/post-call/api");

const RECORDING = "019a0000-0000-7000-8000-0000000000aa";
const CALL = "019a0000-0000-7000-8000-0000000000cc";
const STEP_MS = 500;
const STEPS = 40;

const PostCallTauri = PostCallBackend.layerTauri.pipe(
  Layer.provide(SpeechBackend.layerTauri)
);

const settle = Effect.promise(
  () => new Promise((resolve) => setTimeout(resolve, 0))
);

function refine(progress: number, state: "refining" | "done" | "failed") {
  return Effect.andThen(
    Effect.sync(() =>
      fake.emit("transcript-refine", {
        progress,
        recordingId: RECORDING,
        state,
      })
    ),
    settle
  );
}

/** Builds the summary of the call into `seen`, in the background. */
function build(seen: SummaryProgress[], { listens = true } = {}) {
  return Effect.gen(function* () {
    const backend = yield* PostCallBackend;
    const fiber = yield* Effect.forkChild(
      Stream.runForEach(backend.buildSummary(CALL, RECORDING), (progress) =>
        Effect.sync(() => seen.push(progress))
      )
    );
    // Rust's events reach it once it listens.
    while (
      listens &&
      (fake.handlers.get("transcript-refine")?.size ?? 0) === 0
    ) {
      yield* settle;
    }
    return fiber;
  });
}

/**
 * Lets the mocked steps after the transcript run to the end: the test
 * clock moves on while the IPC answers come in between.
 */
function finish(fiber: Fiber.Fiber<void, unknown>) {
  return Effect.gen(function* () {
    for (let step = 0; step < STEPS; step += 1) {
      yield* settle;
      yield* TestClock.adjust(STEP_MS);
    }
    yield* Fiber.join(fiber);
  });
}

function refinedSegment(): TranscriptSegment {
  return {
    callId: null,
    channel: "others",
    createdAt: 1,
    endMs: 2000,
    id: "segment-1",
    pass: "refined",
    recordingId: RECORDING,
    startMs: 0,
    text: "Добрый день",
    updatedAt: 1,
  };
}

beforeEach(() => {
  fake.answers.clear();
  fake.answers.set("transcript_for_recording", () => []);
});

describe("«Расшифровка» after the call in Tauri", () => {
  it.effect("moves with the second pass; done completes it", () =>
    Effect.gen(function* () {
      const seen: SummaryProgress[] = [];
      const fiber = yield* build(seen);

      yield* refine(0, "refining");
      yield* refine(40, "refining");
      yield* refine(85, "refining");
      assert.deepStrictEqual(seen, [
        { progress: 0, step: 0 },
        { progress: 40, step: 0 },
        { progress: 85, step: 0 },
      ]);
      assert.strictEqual(processingSteps(0, 40)[0]?.progress, 40);

      yield* refine(100, "done");
      yield* finish(fiber);

      const after = seen.slice(3);
      assert.isAbove(after.length, 0);
      assert.isTrue(after.every((progress) => progress.step >= 1));
      assert.isTrue(
        after.every((progress) => progress.transcript === undefined)
      );
      const [transcript] = processingSteps(1, 0);
      assert.strictEqual(transcript?.status, "done");
      assert.strictEqual(transcript?.title, "Расшифровка готова");
    }).pipe(Effect.provide(PostCallTauri))
  );

  it.effect("keeps the live transcript when the second pass fails", () =>
    Effect.gen(function* () {
      const seen: SummaryProgress[] = [];
      const fiber = yield* build(seen);

      yield* refine(30, "refining");
      yield* refine(30, "failed");
      yield* finish(fiber);

      const after = seen.filter((progress) => progress.step >= 1);
      assert.isTrue(
        after.every((progress) => progress.transcript === "failed")
      );
      const [transcript] = processingSteps(1, 0, "failed");
      assert.strictEqual(transcript?.status, "done");
      assert.strictEqual(
        transcript?.description,
        "Уточнить не получилось, итоги по живой расшифровке"
      );
    }).pipe(Effect.provide(PostCallTauri))
  );

  it.effect("is done at once when the refined transcript is stored", () =>
    Effect.gen(function* () {
      fake.answers.set("transcript_for_recording", () => [refinedSegment()]);
      const seen: SummaryProgress[] = [];
      const fiber = yield* build(seen, { listens: false });

      yield* finish(fiber);
      assert.isTrue(seen.every((progress) => progress.step >= 1));
      assert.isTrue(
        seen.every((progress) => progress.transcript === undefined)
      );
    }).pipe(Effect.provide(PostCallTauri))
  );

  it.effect("goes on without news of the second pass", () =>
    Effect.gen(function* () {
      const seen: SummaryProgress[] = [];
      const fiber = yield* build(seen);

      yield* TestClock.adjust(REFINE_SILENCE_MS);
      yield* finish(fiber);
      assert.isAbove(seen.length, 0);
      assert.isTrue(seen.every((progress) => progress.transcript === "later"));
    }).pipe(Effect.provide(PostCallTauri))
  );
});
