"use client";

import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { useMemo } from "react";

import {
  WindowControls,
  WindowTrafficLights,
} from "@/components/ui/window-titlebar";
import { useWindowChrome } from "@/lib/platform";

/*
 * The platform part of a window title bar (`src/lib/platform.ts`):
 * `WindowChromeStart` goes where the traffic lights are drawn,
 * `WindowChromeEnd` closes the right side.
 */

function run(action: (window: Window) => Promise<void>) {
  // The capability grants these; if Tauri refuses, the window stays as is.
  action(getCurrentWindow()).catch(() => undefined);
}

/** Minimize, maximize and close the current Tauri window. */
export function useWindowActions() {
  return useMemo(
    () => ({
      close: () => run((window) => window.close()),
      minimize: () => run((window) => window.minimize()),
      toggleMaximize: () => run((window) => window.toggleMaximize()),
    }),
    []
  );
}

/**
 * The drawn traffic lights in the browser; in Tauri on macOS the same room,
 * left empty under the native ones; nothing elsewhere.
 */
export function WindowChromeStart() {
  const chrome = useWindowChrome();
  if (chrome === "browser") {
    return <WindowTrafficLights />;
  }
  if (chrome === "macos") {
    return (
      <WindowTrafficLights
        className="*:invisible"
        data-native-traffic-lights=""
      />
    );
  }
  return null;
}

/** The Windows system buttons, only in Tauri on Windows. */
export function WindowChromeEnd({ className }: { className?: string }) {
  const chrome = useWindowChrome();
  const actions = useWindowActions();
  if (chrome !== "windows") {
    return null;
  }
  return (
    <WindowControls
      className={className}
      onClose={actions.close}
      onMaximize={actions.toggleMaximize}
      onMinimize={actions.minimize}
    />
  );
}
