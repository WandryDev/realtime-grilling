import { isTauri } from "@tauri-apps/api/core";
import { type Effect, Fiber, Layer, ManagedRuntime } from "effect";

import { DataLayerMock, DataLayerTauri } from "@/data/services/layers";
import { CallBackend } from "@/features/call/backend";
import { CallWidgetBackend } from "@/features/call-widget/backend";
import { OnboardingBackend } from "@/features/onboarding/backend";
import { IntegrationsBackend } from "@/features/onboarding/integrations/backend";
import { PostCallBackend } from "@/features/post-call/backend";
import { ProjectsBackend } from "@/features/projects/backend";
import { SettingsBackend } from "@/features/settings/backend";
import { ShellBackend } from "@/features/shell/backend";

/*
 * Composition root of the Effect services. Every area adds its backend
 * service to both sets: `MockLayer` for the browser, the tests and the
 * prerender, `TauriLayer` for the app. An area without a Tauri layer yet
 * reuses its mock in the Tauri set, so the screens never know which one
 * runs. The data services (`src/data/services`) back the stores of
 * `src/data/*`: the local database in Tauri, an in-memory one otherwise.
 */
export const MockLayer = Layer.mergeAll(
  DataLayerMock,
  CallBackend.layerMock,
  CallWidgetBackend.layerMock,
  IntegrationsBackend.layerMock,
  OnboardingBackend.layerMock,
  PostCallBackend.layerMock,
  ProjectsBackend.layerMock,
  SettingsBackend.layerMock,
  ShellBackend.layerMock
);

export const TauriLayer = Layer.mergeAll(
  DataLayerTauri,
  CallBackend.layerMock,
  CallWidgetBackend.layerMock,
  IntegrationsBackend.layerMock,
  OnboardingBackend.layerTauri,
  PostCallBackend.layerMock,
  ProjectsBackend.layerMock,
  SettingsBackend.layerMock,
  ShellBackend.layerTauri
);

/** The layer set for the current environment. */
export function selectAppLayer(tauri: boolean) {
  return tauri ? TauriLayer : MockLayer;
}

/** Whether this window runs in Tauri. `false` while prerendering. */
export const inTauri = isTauri();

/** Chosen once, when the module loads. */
export const AppLayer = selectAppLayer(inTauri);

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
