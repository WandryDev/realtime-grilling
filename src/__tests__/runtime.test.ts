import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppLayer,
  appRuntime,
  MockLayer,
  selectAppLayer,
  TauriLayer,
} from "@/effect/runtime";
import { CallBackend } from "@/features/call/backend";
import { CallWidgetBackend } from "@/features/call-widget/backend";
import { OnboardingBackend } from "@/features/onboarding/backend";
import { IntegrationsBackend } from "@/features/onboarding/integrations/backend";
import { ProjectsBackend } from "@/features/projects/backend";
import { RecordingBackend } from "@/features/recording/backend";
import { SettingsBackend } from "@/features/settings/backend";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("app runtime", () => {
  it("uses the mocks outside Tauri", () => {
    expect("__TAURI_INTERNALS__" in window).toBe(false);
    expect(AppLayer).toBe(MockLayer);
  });

  it("picks the Tauri set inside Tauri", async () => {
    expect(selectAppLayer(true)).toBe(TauriLayer);
    expect(selectAppLayer(false)).toBe(MockLayer);

    vi.stubGlobal("isTauri", true);
    vi.resetModules();
    const runtime = await import("@/effect/runtime");
    expect(runtime.AppLayer).toBe(runtime.TauriLayer);
  });

  it("provides the backend of every area", async () => {
    const services = await appRuntime.runPromise(
      Effect.all([
        CallBackend,
        CallWidgetBackend,
        IntegrationsBackend,
        OnboardingBackend,
        ProjectsBackend,
        RecordingBackend,
        SettingsBackend,
      ])
    );
    expect(services).toHaveLength(7);
  });
});
