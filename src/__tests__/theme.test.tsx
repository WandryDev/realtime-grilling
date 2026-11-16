import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeProvider } from "@/components/theme-provider";
import { getSettings, resetSettings, updateSetting } from "@/data/settings";
import { SettingsPage } from "@/features/settings/pages/settings-page";
import { ThemeSync } from "@/features/shell/theme-sync";

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/general",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** A `matchMedia` whose `prefers-color-scheme` the test flips. */
function fakeColorScheme(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const matchMedia = (query: string) =>
    ({
      addEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void
      ) => listeners.add(listener),
      addListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
      dispatchEvent: () => true,
      get matches() {
        return query === DARK_QUERY && dark;
      },
      media: query,
      onchange: null,
      removeEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void
      ) => listeners.delete(listener),
      removeListener: (listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    }) as unknown as MediaQueryList;
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    set(next: boolean) {
      dark = next;
      for (const listener of listeners) {
        listener({ matches: next, media: DARK_QUERY } as MediaQueryListEvent);
      }
    },
  };
}

const html = () => document.documentElement;
const hasClass = (name: string) => html().classList.contains(name);

function renderThemed() {
  return render(
    <ThemeProvider>
      <ThemeSync />
    </ThemeProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  html().className = "";
  html().removeAttribute("style");
  resetSettings();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("«Тема»", () => {
  it("puts the stored theme on <html> and follows a change", async () => {
    fakeColorScheme(false);
    renderThemed();
    await waitFor(() => expect(hasClass("light")).toBe(true));
    expect(hasClass("dark")).toBe(false);

    act(() => updateSetting("theme", "dark"));
    await waitFor(() => expect(hasClass("dark")).toBe(true));
    expect(hasClass("light")).toBe(false);
    expect(html().style.colorScheme).toBe("dark");

    act(() => updateSetting("theme", "light"));
    await waitFor(() => expect(hasClass("light")).toBe(true));
    expect(hasClass("dark")).toBe(false);
  });

  it("«Как в системе» follows prefers-color-scheme live", async () => {
    const scheme = fakeColorScheme(true);
    updateSetting("theme", "system");
    renderThemed();
    await waitFor(() => expect(hasClass("dark")).toBe(true));

    act(() => scheme.set(false));
    await waitFor(() => expect(hasClass("light")).toBe(true));
    expect(hasClass("dark")).toBe(false);

    act(() => scheme.set(true));
    await waitFor(() => expect(hasClass("dark")).toBe(true));
  });

  it("remembers the applied theme for the next window", async () => {
    fakeColorScheme(false);
    updateSetting("theme", "dark");
    renderThemed();
    await waitFor(() =>
      expect(window.localStorage.getItem("grill.theme")).toBe("dark")
    );
  });

  it("offers light, dark and the system's in Settings", async () => {
    fakeColorScheme(false);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeSync />
        <SettingsPage section="general" />
      </ThemeProvider>
    );
    for (const name of ["Светлая", "Тёмная", "Как в системе"]) {
      const option = screen.getByRole("button", { name });
      expect(option.hasAttribute("data-disabled")).toBe(false);
      expect(option.getAttribute("aria-disabled")).not.toBe("true");
    }
    expect(screen.queryByText("Тёмная появится позже")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Тёмная" }));
    expect(getSettings().theme).toBe("dark");
    await waitFor(() => expect(hasClass("dark")).toBe(true));
  });
});
