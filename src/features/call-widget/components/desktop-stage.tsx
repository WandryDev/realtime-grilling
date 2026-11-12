"use client";

import type { ComponentProps } from "react";

import { useWindowChrome } from "@/lib/platform";

import { useNowSeconds } from "../use-call-clock";
import { DesktopScene } from "./desktop-scene";

const weekday = new Intl.DateTimeFormat("ru", { weekday: "short" });
const time = new Intl.DateTimeFormat("ru", {
  hour: "2-digit",
  minute: "2-digit",
});

/** "Пн 12:39", the menu bar clock. */
function formatMenuBarClock(seconds: number) {
  const date = new Date(seconds * 1000);
  const day = weekday.format(date);
  return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${time.format(date)}`;
}

/*
 * The root of the floating windows, /widget and /overlay. It is marked
 * `data-window="floating"`: the page background turns transparent
 * (globals.css) and the dev navigator stays out.
 *
 * In the browser it draws a stand-in for the user's desktop: the Paper
 * desktop scene filling the viewport with a live menu bar clock. In Tauri
 * the widgets are transparent windows over the real desktop, so only the
 * card is drawn, and dragging it moves the window.
 */
export function DesktopStage(
  props: Omit<ComponentProps<typeof DesktopScene>, "className" | "clock">
) {
  const chrome = useWindowChrome();
  const now = useNowSeconds();
  if (chrome !== "browser") {
    return (
      <div
        // No float shadow on the real desktop: the transparent window would
        // clip it. A hairline inside keeps the card's edge.
        className="w-fit [&_.shadow-float]:shadow-[inset_0_0_0_1px_rgb(17_17_17/8%)]"
        data-tauri-drag-region="deep"
        data-window="floating"
      >
        {props.children}
      </div>
    );
  }
  const clock = now === null ? "Пн 12:00" : formatMenuBarClock(now);
  return (
    <div data-window="floating">
      <DesktopScene className="h-svh w-full" clock={clock} {...props} />
    </div>
  );
}
