"use client";

import { useSyncExternalStore } from "react";

import { useCallSession } from "@/data/call-session";

/*
 * Ticking time for the widgets. The current second comes from a shared
 * 1-second interval; the server snapshot is null, so prerendered HTML shows
 * the static fallback and the client starts ticking after hydration.
 */

const TICK_MS = 1000;
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (interval === undefined) {
    interval = setInterval(() => {
      for (const item of listeners) {
        item();
      }
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(interval);
      interval = undefined;
    }
  };
}

const nowSeconds = () => Math.floor(Date.now() / TICK_MS);
const serverSeconds = () => null;

/** Seconds since the epoch, or null before hydration. */
export function useNowSeconds(): number | null {
  return useSyncExternalStore(subscribe, nowSeconds, serverSeconds);
}

const pad = (value: number) => String(value).padStart(2, "0");

/** 366 → "06:06", 3725 → "1:02:05". */
export function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`;
}

/** 408 → "6:48", the countdown look. */
export function formatCountdown(totalSeconds: number) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** "12:39", wall clock time. */
export function formatClockTime(seconds: number) {
  const date = new Date(seconds * TICK_MS);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "24:18" → 1458. */
export function parseDuration(value: string) {
  return value
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

// Opened without a running call (direct URL, ?demo): pretend the demo call
// started `fallback` ago, once per page load.
let demoStartedAt: number | undefined;

/**
 * Elapsed recording time of the current call, formatted. Falls back to the
 * demo time when no call was started from the widget.
 */
export function useCallTime(fallback: string): string {
  const now = useNowSeconds();
  const { startedAt, status } = useCallSession();
  if (now === null) {
    return fallback;
  }
  if (status !== "idle" && startedAt !== undefined) {
    return formatDuration(now - Math.floor(startedAt / TICK_MS));
  }
  demoStartedAt ??= now - parseDuration(fallback);
  return formatDuration(now - demoStartedAt);
}
