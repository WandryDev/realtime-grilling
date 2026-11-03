import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach } from "vitest";

import {
  LEVELS_INTERVAL_MS,
  type MicActivity,
  MOCK_MEETING_APP,
  mockMicActivity,
  RecordingBackend,
  type RecordingLevels,
  type RecordingStatus,
} from "@/features/recording/backend";

beforeEach(() => {
  mockMicActivity.reset();
});

describe("RecordingBackend.layerMock", () => {
  it.effect("starts once: a second start returns the running recording", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const changes: RecordingStatus[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(recorder.changes, (change) =>
          Effect.sync(() => changes.push(change))
        )
      );
      yield* Effect.yieldNow;

      const id = yield* recorder.start("call-1");
      assert.strictEqual(yield* recorder.start(null), id);
      const status = yield* recorder.status;
      assert.strictEqual(status.id, id);
      assert.isNotNull(status.startedAt);
      assert.deepStrictEqual(status.channels, { me: "ok", others: "ok" });

      yield* recorder.stop(id);
      assert.isNull((yield* recorder.status).id);
      // Stopping it again is fine; the second start sent nothing.
      yield* recorder.stop(id);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(
        changes.map((change) => change.id),
        [id, null]
      );
    }).pipe(Effect.provide(RecordingBackend.layerMock))
  );

  it.effect("fails to stop a recording it never started with NotFound", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const error = yield* Effect.flip(recorder.stop("no-such-recording"));
      assert.strictEqual(error.kind, "NotFound");
    }).pipe(Effect.provide(RecordingBackend.layerMock))
  );

  it.effect("plays both levels on a timer, within 0–1", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const seen: RecordingLevels[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(recorder.levels, (level) =>
          Effect.sync(() => seen.push(level))
        )
      );
      yield* TestClock.adjust(LEVELS_INTERVAL_MS * 10);
      assert.strictEqual(seen.length, 10);
      for (const { me, others } of seen) {
        assert.isTrue(me >= 0 && me <= 1);
        assert.isTrue(others >= 0 && others <= 1);
      }
      assert.notStrictEqual(seen[0]?.me, seen[1]?.me);
    }).pipe(Effect.provide(RecordingBackend.layerMock))
  );

  it.effect("frees the microphone when the demo meeting app leaves", () =>
    Effect.gen(function* () {
      const recorder = yield* RecordingBackend;
      const now = yield* recorder.micActivityNow;
      assert.isTrue(now.busy);
      assert.strictEqual(now.app, MOCK_MEETING_APP);

      const seen: MicActivity[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(recorder.micActivity, (activity) =>
          Effect.sync(() => seen.push(activity))
        )
      );
      yield* Effect.yieldNow;

      mockMicActivity.release(1000);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(seen, [
        { app: MOCK_MEETING_APP, busy: false, since: 1000 },
      ]);

      // Freed already: the next leave is a new busy → free.
      mockMicActivity.release(2000);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(
        seen.slice(1).map((activity) => activity.busy),
        [true, false]
      );
      assert.isFalse((yield* recorder.micActivityNow).busy);
    }).pipe(Effect.provide(RecordingBackend.layerMock))
  );
});
