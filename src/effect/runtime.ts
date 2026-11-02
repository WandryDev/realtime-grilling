import { type Effect, Fiber, Layer, ManagedRuntime } from "effect";

import { ProjectsBackend } from "@/features/projects/backend";

/*
 * Composition root of the Effect services. Every area adds its backend
 * service here; the mock layers become Tauri layers when the Rust side
 * exists, without touching the screens.
 */
export const AppLayer = Layer.mergeAll(ProjectsBackend.layerMock);

export type AppServices = Layer.Success<typeof AppLayer>;

export const appRuntime = ManagedRuntime.make(AppLayer, {
  memoMap: Layer.makeMemoMapUnsafe(),
});

/**
 * Runs an effect in the background and returns a function that interrupts
 * it: the bridge for React effects and "Остановить" buttons.
 */
export function runCancelable<A, E>(
  effect: Effect.Effect<A, E, AppServices>
): () => void {
  const fiber = appRuntime.runFork(effect);
  return () => {
    appRuntime.runFork(Fiber.interrupt(fiber));
  };
}
