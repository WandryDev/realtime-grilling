"use client";

import { useTheme } from "next-themes";
import { useEffect } from "react";

import { useSettingsState } from "@/data/settings";
import { useHydrated } from "@/lib/use-hydrated";

/** The «Тема» values; anything else reads as the default, light. */
const THEMES = new Set(["light", "dark", "system"]);

/**
 * Applies the «Тема» setting to this window: next-themes sets the class on
 * <html> and remembers it for the next window that opens. Every window
 * reads the settings and re-reads them on `DataChanged`, so a change in
 * Settings reaches all open windows at once. Before the settings are read
 * (a Tauri window starts `loading`) nothing changes: the window keeps the
 * theme its inline script applied, so there is no flash of the default.
 * The native appearance (title bar, traffic lights) is Rust's: it applies
 * the setting app-wide when it is stored.
 */
export function ThemeSync() {
  const hydrated = useHydrated();
  const { data, status } = useSettingsState();
  const { setTheme } = useTheme();
  const stored = data.values.theme;
  const theme = THEMES.has(stored) ? stored : "light";
  const ready = hydrated && status === "ready";

  useEffect(() => {
    if (ready) {
      setTheme(theme);
    }
  }, [ready, setTheme, theme]);
  return null;
}
