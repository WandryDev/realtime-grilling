import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * «Тема» in Tauri mode, over the fake IPC (./helpers/fake-tauri.ts): a
 * window keeps the theme it opened with until the settings are read, then
 * follows the stored one, and a change written in another window reaches
 * it through `DataChanged`.
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
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "overlay", listen: fake.listen }),
}));

const { ThemeProvider } = await import("@/components/theme-provider");
const { ThemeSync } = await import("@/features/shell/theme-sync");

const hasClass = (name: string) =>
  document.documentElement.classList.contains(name);

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    matches: false,
    media: query,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  }));
});

describe("«Тема» in Tauri", () => {
  it("keeps the opening theme until the settings are read, then follows them across windows", async () => {
    // The last applied theme, as the inline script found it.
    window.localStorage.setItem("grill.theme", "dark");
    fake.db.settings.theme = "dark";
    let answer: (() => void) | undefined;
    fake.answers.set(
      "settings_get",
      () =>
        new Promise((resolve) => {
          answer = () => resolve(fake.db.settings);
        })
    );

    render(
      <ThemeProvider>
        <ThemeSync />
      </ThemeProvider>
    );
    await waitFor(() => expect(answer).toBeDefined());
    // Not read yet: the default (light) must not flash in.
    expect(hasClass("dark")).toBe(true);
    expect(hasClass("light")).toBe(false);

    fake.answers.delete("settings_get");
    act(() => answer?.());
    await waitFor(() => expect(hasClass("dark")).toBe(true));

    // Settings, in the main window, switch to light.
    fake.db.settings.theme = "light";
    act(() => {
      fake.dataChanged({
        change: "updated",
        entity: "settings",
        id: "settings",
        projectId: null,
      });
    });
    await waitFor(() => expect(hasClass("light")).toBe(true));
    expect(hasClass("dark")).toBe(false);
    expect(window.localStorage.getItem("grill.theme")).toBe("light");
  });
});
