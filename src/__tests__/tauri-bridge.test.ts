import { assert, describe, it } from "@effect/vitest";
import type { EventCallback } from "@tauri-apps/api/event";
import { Effect, Fiber, Stream } from "effect";
import { beforeEach, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>(),
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    tauri.handlers.set(event, handler);
    return Promise.resolve(tauri.unlisten);
  },
}));

const { BackendError, call, listen } = await import("@/effect/tauri");

beforeEach(() => {
  tauri.handlers.clear();
  tauri.invoke.mockReset();
  tauri.unlisten.mockReset();
});

describe("call (generated wrappers)", () => {
  it.effect("returns the data of an ok result", () =>
    Effect.gen(function* () {
      const data = yield* call(() =>
        Promise.resolve({ data: ["telemedia"], status: "ok" as const })
      );
      assert.deepStrictEqual(data, ["telemedia"]);
    })
  );

  it.effect.each(["NotFound", "Invalid", "Storage", "External"] as const)(
    "maps a %s command error to its kind",
    (kind) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          call(() =>
            Promise.resolve({
              error: { kind, message: "нет проекта" },
              status: "error" as const,
            })
          )
        );
        assert.instanceOf(error, BackendError);
        assert.strictEqual(error.kind, kind);
        assert.strictEqual(error.message, "нет проекта");
      })
  );

  it.effect("keeps the reason of an External capture error", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        call(() =>
          Promise.resolve({
            error: {
              kind: "External",
              message: "Нет ни одного микрофона",
              reason: "noDevice",
            },
            status: "error" as const,
          })
        )
      );
      assert.strictEqual(error.kind, "External");
      assert.strictEqual(error.reason, "noDevice");
      assert.strictEqual(error.message, "Нет ни одного микрофона");
    })
  );

  it.effect("maps a rejected wrapper to Transport", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        call(() => Promise.reject(new Error("IPC is down")))
      );
      assert.strictEqual(error.kind, "Transport");
      assert.strictEqual(error.message, "IPC is down");
    })
  );

  it.effect("maps an unknown error payload to Transport", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        call(() =>
          Promise.resolve({
            error: { kind: "Exploded", message: "?" },
            status: "error" as const,
          })
        )
      );
      assert.strictEqual(error.kind, "Transport");
    })
  );
});

describe("call (raw invoke)", () => {
  it.effect("passes the command and its arguments to invoke", () =>
    Effect.gen(function* () {
      tauri.invoke.mockResolvedValue({ id: "p1" });
      const project = yield* call<{ id: string }>("projects_get", {
        id: "p1",
      });
      assert.deepStrictEqual(project, { id: "p1" });
      assert.deepStrictEqual(tauri.invoke.mock.calls[0], [
        "projects_get",
        { id: "p1" },
      ]);
    })
  );

  it.effect("maps a rejected CommandError payload to its kind", () =>
    Effect.gen(function* () {
      tauri.invoke.mockRejectedValue({ kind: "NotFound", message: "нет" });
      const error = yield* Effect.flip(call("projects_get", { id: "x" }));
      assert.strictEqual(error.kind, "NotFound");
      assert.isUndefined(error.reason);
    })
  );

  it.effect("decodes a rejected External payload", () =>
    Effect.gen(function* () {
      tauri.invoke.mockRejectedValue({
        kind: "External",
        message: "Установка не удалась (код 1)",
      });
      const error = yield* Effect.flip(call("agent_install"));
      assert.strictEqual(error.kind, "External");
      assert.strictEqual(error.message, "Установка не удалась (код 1)");
    })
  );

  it.effect("maps any other rejection to Transport", () =>
    Effect.gen(function* () {
      tauri.invoke.mockRejectedValue("command projects_get not allowed");
      const error = yield* Effect.flip(call("projects_get"));
      assert.strictEqual(error.kind, "Transport");
      assert.strictEqual(error.message, "command projects_get not allowed");
    })
  );
});

describe("listen", () => {
  it.effect("emits payloads and unlistens when the stream ends", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(listen<number>("data-changed"), 2))
      );
      yield* Effect.yieldNow;
      const emit = tauri.handlers.get("data-changed");
      assert.isDefined(emit);
      emit?.({ payload: 1 });
      emit?.({ payload: 2 });
      assert.deepStrictEqual(Array.from(yield* Fiber.join(fiber)), [1, 2]);
      assert.strictEqual(tauri.unlisten.mock.calls.length, 1);
    })
  );

  it.effect("unlistens when the subscriber is interrupted", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(listen("data-changed"))
      );
      yield* Effect.yieldNow;
      assert.strictEqual(tauri.unlisten.mock.calls.length, 0);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(tauri.unlisten.mock.calls.length, 1);
    })
  );

  it.effect("accepts a generated event wrapper", () =>
    Effect.gen(function* () {
      const unlisten = vi.fn();
      let handler: EventCallback<string> | undefined;
      const source = {
        listen: (callback: EventCallback<string>) => {
          handler = callback;
          return Promise.resolve(unlisten);
        },
      };
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(Stream.take(listen(source), 1))
      );
      yield* Effect.yieldNow;
      handler?.({ event: "navigate", id: 1, payload: "/settings" });
      assert.deepStrictEqual(Array.from(yield* Fiber.join(fiber)), [
        "/settings",
      ]);
      assert.strictEqual(unlisten.mock.calls.length, 1);
    })
  );

  it.effect("fails with Transport when the listener can't register", () =>
    Effect.gen(function* () {
      const source = {
        listen: () => Promise.reject(new Error("no IPC")),
      };
      const error = yield* Effect.flip(Stream.runDrain(listen(source)));
      assert.strictEqual(error.kind, "Transport");
    })
  );
});
