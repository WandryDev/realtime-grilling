"use client";

import type { ComponentProps } from "react";

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
 * The browser stand-in for the user's desktop under the floating windows of
 * /widget and /overlay: the Paper desktop scene filling the viewport with a
 * live menu bar clock. In Tauri the widgets are transparent windows and the
 * real desktop is behind them.
 */
export function DesktopStage(
  props: Omit<ComponentProps<typeof DesktopScene>, "className" | "clock">
) {
  const now = useNowSeconds();
  const clock = now === null ? "Пн 12:00" : formatMenuBarClock(now);
  return <DesktopScene className="h-svh w-full" clock={clock} {...props} />;
}
