import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { beforeEach, vi } from "vitest";

import type {
  SpeechModel,
  TranscriptPhrase,
  TranscriptSegment,
} from "@/bindings";

/*
 * SpeechBackend.layerTauri over the fake IPC (./helpers/fake-tauri.ts):
 * the commands it sends, and the Rust events it turns into its own: the
 * models' changes, the transcript of one recording (others' events are
 * not its), the second pass.
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

const { SpeechBackend } = await import("@/features/speech/backend");

const RECORDING = "019a0000-0000-7000-8000-00000000000a";
const OTHER = "019a0000-0000-7000-8000-00000000000b";

const TURBO: SpeechModel = {
  id: "turbo",
  name: "Whisper large-v3-turbo",
  selected: true,
  sizeBytes: 574_041_195,
  state: { status: "notDownloaded" },
};
const SMALL: SpeechModel = {
  id: "small",
  name: "Whisper small",
  selected: false,
  sizeBytes: 487_601_967,
  state: { status: "notDownloaded" },
};

function segment(
  channel: "me" | "others",
  startMs: number,
  text: string
): TranscriptSegment {
  return {
    callId: null,
    channel,
    createdAt: 1,
    endMs: startMs + 2000,
    id: `segment-${startMs}`,
    pass: "live",
    recordingId: RECORDING,
    startMs,
    text,
    updatedAt: 1,
  };
}

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function listeners(event: string) {
  return fake.handlers.get(event)?.size ?? 0;
}

const settle = Effect.promise(
  () => new Promise((resolve) => setTimeout(resolve, 0))
);

/** Waits until a stream listens to `event`. */
function untilListening(event: string) {
  return Effect.gen(function* () {
    while (listeners(event) === 0) {
      yield* settle;
    }
  });
}

/** Waits until `command` was sent `count` times. */
function untilInvoked(command: string, count = 1) {
  return Effect.gen(function* () {
    while (invokedWith(command).length < count) {
      yield* settle;
    }
  });
}

beforeEach(() => {
  fake.answers.clear();
  fake.failures.clear();
  fake.invoked.length = 0;
  fake.answers.set("speech_models_list", () => [TURBO, SMALL]);
});

describe("SpeechBackend.layerTauri", () => {
  it.effect("sends the model commands with the model id", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const downloading: SpeechModel = {
        ...TURBO,
        state: { bytesPerSec: 1, percent: 0, status: "downloading" },
      };
      for (const command of [
        "speech_model_download",
        "speech_model_pause",
        "speech_model_cancel",
        "speech_model_remove",
        "speech_model_select",
      ]) {
        fake.answers.set(command, () => downloading);
      }
      yield* speech.download("turbo");
      yield* speech.pause("turbo");
      yield* speech.cancel("small");
      yield* speech.remove("small");
      yield* speech.select("turbo");
      assert.deepStrictEqual(
        fake.invoked.map((call) => [call.command, call.args?.id]),
        [
          ["speech_model_download", "turbo"],
          ["speech_model_pause", "turbo"],
          ["speech_model_cancel", "small"],
          ["speech_model_remove", "small"],
          ["speech_model_select", "turbo"],
        ]
      );

      fake.failures.set("speech_model_remove", {
        kind: "Invalid",
        message: "Идёт запись",
      });
      const refused = yield* Effect.flip(speech.remove("turbo"));
      assert.strictEqual(refused.kind, "Invalid");
    }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );

  it.effect("watches the models: a change during the read is kept", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const ready = { ...SMALL, state: { status: "ready" as const } };
      fake.answers.set("speech_models_list", () => {
        // Rust reports small while the list is on its way back.
        fake.emit("speech-model-changed", ready);
        return [TURBO, SMALL];
      });
      const seen: (readonly SpeechModel[])[] = [];
      const lists = yield* Effect.forkChild(
        Stream.runForEach(Stream.take(speech.watchModels, 2), (list) =>
          Effect.sync(() => seen.push(list))
        )
      );
      while (seen.length === 0) {
        yield* settle;
      }
      const selected: SpeechModel = {
        ...SMALL,
        selected: true,
        state: { status: "ready" },
      };
      fake.emit("speech-model-changed", selected);

      yield* Fiber.join(lists);
      const [first, second] = seen;
      assert.deepStrictEqual(first, [TURBO, ready]);
      // Selecting small unselects turbo.
      assert.deepStrictEqual(second, [{ ...TURBO, selected: false }, selected]);
      assert.strictEqual(listeners("speech-model-changed"), 0);
    }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );

  it.effect("cancels the hardware check it stops waiting for", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      fake.answers.set("speech_benchmark", () => new Promise(() => undefined));
      fake.answers.set("speech_benchmark_cancel", () => null);
      const check = yield* Effect.forkChild(speech.benchmark("turbo"));
      yield* untilInvoked("speech_benchmark");
      yield* Fiber.interrupt(check);
      yield* untilInvoked("speech_benchmark_cancel");
      assert.deepStrictEqual(invokedWith("speech_benchmark"), [
        { model: "turbo" },
      ]);
      assert.strictEqual(invokedWith("speech_benchmark_cancel").length, 1);
    }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );

  it.effect("runs the mic check and returns what it heard", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      fake.answers.set("speech_mic_check", () => "Раз, два, проверка");
      assert.strictEqual(yield* speech.micCheck, "Раз, два, проверка");
    }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );

  it.effect(
    "turns the recognizer's events of one recording into its own, in order",
    () =>
      Effect.gen(function* () {
        const speech = yield* SpeechBackend;
        const events = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(speech.transcriptEvents(RECORDING), 6))
        );
        yield* untilListening("transcript-lag");
        const phrase: TranscriptPhrase = {
          channel: "others",
          endMs: 3400,
          id: "segment-1",
          pass: "live",
          recordingId: RECORDING,
          startMs: 1200,
          text: "Пятеро операторов",
        };
        fake.emit("transcript-pending", {
          channel: "others",
          recordingId: OTHER,
          startMs: 1,
        });
        fake.emit("transcript-pending", {
          channel: "others",
          recordingId: RECORDING,
          startMs: 1200,
        });
        fake.emit("transcript-phrase", phrase);
        fake.emit("transcript-dropped", {
          channel: "me",
          recordingId: RECORDING,
          startMs: 5000,
        });
        fake.emit("transcript-skipped", {
          channel: "others",
          endMs: 21_000,
          recordingId: RECORDING,
          startMs: 9000,
        });
        fake.emit("transcript-lag", { recordingId: OTHER, seconds: 12 });
        fake.emit("transcript-lag", { recordingId: RECORDING, seconds: 40 });
        fake.emit("transcript-lag", { recordingId: RECORDING, seconds: 0 });

        assert.deepStrictEqual(Array.from(yield* Fiber.join(events)), [
          { channel: "others", startMs: 1200, type: "pending" },
          {
            channel: "others",
            endMs: 3400,
            id: "segment-1",
            pass: "live",
            startMs: 1200,
            text: "Пятеро операторов",
            type: "phrase",
          },
          { channel: "me", startMs: 5000, type: "dropped" },
          { channel: "others", endMs: 21_000, startMs: 9000, type: "skipped" },
          { seconds: 40, type: "lag" },
          { seconds: 0, type: "lag" },
        ]);
        // The stream ended: its listeners are gone.
        assert.strictEqual(listeners("transcript-phrase"), 0);
      }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );

  it.effect(
    "reads the stored transcript first; what is said meanwhile comes after",
    () =>
      Effect.gen(function* () {
        const speech = yield* SpeechBackend;
        const stored = [segment("me", 0, "Добрый день")];
        fake.answers.set("transcript_for_recording", () => {
          fake.emit("transcript-pending", {
            channel: "others",
            recordingId: RECORDING,
            startMs: 2500,
          });
          return stored;
        });
        const events = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(speech.transcriptFeed(RECORDING), 2))
        );
        assert.deepStrictEqual(Array.from(yield* Fiber.join(events)), [
          { segments: stored, type: "stored" },
          { channel: "others", startMs: 2500, type: "pending" },
        ]);
        assert.deepStrictEqual(invokedWith("transcript_for_recording"), [
          { recordingId: RECORDING },
        ]);
      }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );

  it.effect("follows the second pass of a recording until it is done", () =>
    Effect.gen(function* () {
      const speech = yield* SpeechBackend;
      const steps = yield* Effect.forkChild(
        Stream.runCollect(speech.refine(RECORDING))
      );
      yield* untilListening("transcript-refine");
      fake.emit("transcript-refine", {
        progress: 30,
        recordingId: OTHER,
        state: "done",
      });
      fake.emit("transcript-refine", {
        progress: 0,
        recordingId: RECORDING,
        state: "refining",
      });
      fake.emit("transcript-refine", {
        progress: 55,
        recordingId: RECORDING,
        state: "refining",
      });
      fake.emit("transcript-refine", {
        progress: 100,
        recordingId: RECORDING,
        state: "done",
      });
      assert.deepStrictEqual(Array.from(yield* Fiber.join(steps)), [
        { progress: 0, state: "refining" },
        { progress: 55, state: "refining" },
        { progress: 100, state: "done" },
      ]);
    }).pipe(Effect.provide(SpeechBackend.layerTauri))
  );
});
