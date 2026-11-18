import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vitest";

import {
  AgentLoginCodeError,
  ClipboardError,
  LEVEL_INTERVAL_MS,
  MOCK_DELAY_MS,
  MOCK_LOGIN_URL,
  mockComputer,
  OnboardingBackend,
} from "@/features/onboarding/backend";
import { IntegrationsBackend } from "@/features/onboarding/integrations/backend";
import {
  CONNECT_DELAY_MS,
  CONNECTED_ACCOUNTS,
} from "@/features/onboarding/integrations/mock";

afterEach(() => {
  vi.unstubAllGlobals();
  mockComputer.reset();
});

describe("OnboardingBackend.layerMock", () => {
  it.effect("streams an input level between 0 and 1 every frame", () =>
    Effect.gen(function* () {
      const backend = yield* OnboardingBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(backend.audioLevel("microphone"), 5))
      );
      yield* TestClock.adjust(LEVEL_INTERVAL_MS * 5);
      const levels = Array.from(yield* Fiber.join(fiber));
      assert.strictEqual(levels.length, 5);
      for (const { level } of levels) {
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

describe("OnboardingBackend.layerMock, the mock computer", () => {
  it.effect("asks for an access and waits for the dialog's answer", () =>
    Effect.gen(function* () {
      const backend = yield* OnboardingBackend;
      const fiber = yield* Effect.forkChild(
        backend.requestPermission("microphone")
      );
      yield* TestClock.adjust(MOCK_DELAY_MS.permissionsCheck);
      assert.isUndefined(fiber.pollUnsafe());
      mockComputer.answer("microphone", false);
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        message: null,
        state: "denied",
      });

      // Opening System Settings turns the refused access on
      yield* backend.openPermissionSettings("microphone");
      const read = yield* Effect.forkChild(backend.permissions);
      yield* TestClock.adjust(MOCK_DELAY_MS.permissionsCheck);
      assert.deepStrictEqual(yield* Fiber.join(read), {
        microphone: { message: null, state: "granted" },
        systemAudio: { message: null, state: "notDetermined" },
      });
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );

  it.effect("installs the agent with progress, then asks for a login", () =>
    Effect.gen(function* () {
      mockComputer.setAgent("notInstalled");
      const backend = yield* OnboardingBackend;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(backend.installAgent)
      );
      yield* TestClock.adjust(MOCK_DELAY_MS.installTick * 25);
      const events = Array.from(yield* Fiber.join(fiber));
      assert.deepStrictEqual(events[0], {
        percent: 4,
        stage: "downloading",
        type: "progress",
      });
      assert.deepStrictEqual(events.at(-1), {
        agent: { status: "needsLogin", version: "2.1.4" },
        type: "installed",
      });
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );

  it.effect("logs in with the code from the browser", () =>
    Effect.gen(function* () {
      const backend = yield* OnboardingBackend;
      const start = yield* Effect.forkChild(backend.loginStart);
      yield* TestClock.adjust(MOCK_DELAY_MS.loginStart);
      assert.strictEqual(yield* Fiber.join(start), MOCK_LOGIN_URL);

      const submit = yield* Effect.forkChild(backend.loginSubmit("aB3dE5gH"));
      yield* TestClock.adjust(MOCK_DELAY_MS.loginSubmit);
      assert.deepStrictEqual(yield* Fiber.join(submit), {
        email: "dima@pixel.agency",
        status: "ready",
        subscription: "max",
        version: "2.1.4",
      });
    }).pipe(Effect.provide(OnboardingBackend.layerMock))
  );

  it.effect("rejects a short code and closes the login", () =>
    Effect.gen(function* () {
      mockComputer.openLogin();
      const backend = yield* OnboardingBackend;
      const short = yield* Effect.forkChild(
        Effect.flip(backend.loginSubmit("abc"))
      );
      yield* TestClock.adjust(MOCK_DELAY_MS.loginSubmit);
      assert.instanceOf(yield* Fiber.join(short), AgentLoginCodeError);

      // The session is over, even a right code needs a new login
      const again = yield* Effect.forkChild(
        Effect.flip(backend.loginSubmit("aB3dE5gH"))
      );
      yield* TestClock.adjust(MOCK_DELAY_MS.loginSubmit);
      const expired = yield* Fiber.join(again);
      assert.strictEqual(expired._tag, "BackendError");
      assert.strictEqual(
        expired._tag === "BackendError" ? expired.kind : null,
        "NotFound"
      );
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
});
