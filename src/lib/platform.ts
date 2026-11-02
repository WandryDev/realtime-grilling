import { isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

/*
 * Which window chrome the app draws (design.md, decision 5):
 * - browser: the macOS drawing from the mockups, nothing is clickable;
 * - macos: Tauri with an overlay title bar, macOS draws the real traffic
 *   lights, the app keeps their room empty;
 * - windows: Tauri without decorations, the app draws the system buttons;
 * - native: any other OS in Tauri keeps the system title bar.
 */
export type WindowChrome = "browser" | "macos" | "windows" | "native";

/** WKWebView and WebView2 report the OS in the user agent. */
export function windowChromeFor({
  tauri,
  userAgent,
}: {
  tauri: boolean;
  userAgent: string;
}): WindowChrome {
  if (!tauri) {
    return "browser";
  }
  if (userAgent.includes("Macintosh")) {
    return "macos";
  }
  if (userAgent.includes("Windows")) {
    return "windows";
  }
  return "native";
}

function currentWindowChrome() {
  return windowChromeFor({
    tauri: isTauri(),
    userAgent: navigator.userAgent,
  });
}

function serverWindowChrome(): WindowChrome {
  return "browser";
}

/** Neither the OS nor Tauri changes while the page lives. */
function subscribe() {
  return () => undefined;
}

/**
 * The chrome of the current window. The static export is prerendered as
 * "browser"; the Tauri window switches right after hydration.
 */
export function useWindowChrome(): WindowChrome {
  return useSyncExternalStore(
    subscribe,
    currentWindowChrome,
    serverWindowChrome
  );
}
