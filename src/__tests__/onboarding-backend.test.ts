import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

import {
  ClipboardError,
  LEVEL_INTERVAL_MS,
  OnboardingBackend,
  WORD_INTERVAL_MS,
} from "@/features/onboarding/backend";
import { IntegrationsBackend } from "@/features/onboarding/integrations/backend";
import {
  CONNECT_DELAY_MS,
  CONNECTED_ACCOUNTS,
} from "@/features/onboarding/integrations/mock";

const VALID_KEY = "ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OnboardingBackend.layerMock", () => {
  it.effect("hears the mic-check phrase word by word, then stops", () =>
    Effect.gen(function* () {
      const backend = yield* OnboardingBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.micCheck("Раз два три"))
      );
      yield* TestClock.adjust(WORD_INTERVAL_MS * 3);
      assert.deepStrictEqual(Array.from(yield* Fiber.join(fiber)), [
        "Раз",
        "Раз два",
        "Раз два три",
      ]);
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );

  it.effect("streams an input level between 0 and 1 every frame", () =>
    Effect.gen(function* () {
      const backend = yield* OnboardingBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(backend.audioLevel("microphone"), 5))
      );
      yield* TestClock.adjust(LEVEL_INTERVAL_MS * 5);
      const levels = Array.from(yield* Fiber.join(fiber));
      assert.strictEqual(levels.length, 5);
      for (const level of levels) {
        assert.isTrue(level > 0 && level <= 1);
      }
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );

  it.effect("copies to the clipboard", () =>
    Effect.gen(function* () {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const backend = yield* OnboardingBackend;
      yield* backend.copyText("лог");
      assert.deepStrictEqual(writeText.mock.calls, [["лог"]]);
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );

  it.effect("fails with ClipboardError when the clipboard is unavailable", () =>
    Effect.gen(function* () {
      vi.stubGlobal("navigator", {});
      const backend = yield* OnboardingBackend;
      const error = yield* Effect.flip(backend.copyText("лог"));
      assert.instanceOf(error, ClipboardError);
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );
});

describe("IntegrationsBackend.layerMock", () => {
  it.effect("authorizes GitHub once the user presses Authorize", () =>
    Effect.gen(function* () {
      const backend = yield* IntegrationsBackend;
      const fiber = yield* Effect.forkChild(backend.authorizeGitHub);
      yield* TestClock.adjust(CONNECT_DELAY_MS.github);
      assert.strictEqual(yield* Fiber.join(fiber), CONNECTED_ACCOUNTS.github);
    }).pipe(Effect.provide(IntegrationsBackend.layerMock))
  );

  it.effect("connects Outline with a valid key", () =>
    Effect.gen(function* () {
      const backend = yield* IntegrationsBackend;
      const fiber = yield* Effect.forkChild(
        backend.connectOutline("https://docs.pixel.agency", VALID_KEY)
      );
      yield* TestClock.adjust(CONNECT_DELAY_MS.outline);
      assert.strictEqual(yield* Fiber.join(fiber), CONNECTED_ACCOUNTS.outline);
    }).pipe(Effect.provide(IntegrationsBackend.layerMock))
  );

  it.effect.each([
    { field: "url", key: VALID_KEY, url: "https://localhost" },
    { field: "key", key: "ol_api_short", url: "https://docs.pixel.agency" },
  ] as const)("rejects Outline on the $field", ({ field, key, url }) =>
    Effect.gen(function* () {
      const backend = yield* IntegrationsBackend;
      const fiber = yield* Effect.forkChild(
        Effect.flip(backend.connectOutline(url, key))
      );
      yield* TestClock.adjust(CONNECT_DELAY_MS.outline);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "OutlineCheckError");
      assert.strictEqual(error.field, field);
    }).pipe(Effect.provide(IntegrationsBackend.layerMock))
  );

  it.effect("waits for the ClickUp redirect", () =>
    Effect.gen(function* () {
      const backend = yield* IntegrationsBackend;
      const fiber = yield* Effect.forkChild(backend.authorizeClickUp);
      yield* TestClock.adjust(CONNECT_DELAY_MS.clickup - 1);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      assert.strictEqual(yield* Fiber.join(fiber), CONNECTED_ACCOUNTS.clickup);
    }).pipe(Effect.provide(IntegrationsBackend.layerMock))
  );
});
