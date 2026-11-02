"use client";

import { useSyncExternalStore } from "react";

import { events } from "@/bindings";
import { inTauri } from "@/effect/runtime";

import { setOnboardingCompleted, useOnboardingCompleted } from "./settings";

/*
 * Whether the first-run setup is done; the setup shows once.
 *
 * - In Tauri the flag is the `onboardingCompleted` setting: Rust reads it
 *   to open onboarding or the main window, and `onboarding_complete`
 *   swaps the windows.
 * - In the browser it lives in localStorage, as the mock of that setting.
 *
 * `useOnboardingDone()` returns `null` until the flag is read, so
 * prerendered HTML never guesses.
 */

const STORAGE_KEY = "grill.onboarding-done";
const listeners = new Set<() => void>();

/** The window Rust shows once onboarding is done. */
const MAIN_WINDOW = "main";

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function write(done: boolean) {
  try {
    if (done) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage is unavailable (private mode): the flag lives until reload.
  }
  for (const listener of listeners) {
    listener();
  }
}

function useStoredFlag(): boolean | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export const useOnboardingDone: () => boolean | null = inTauri
  ? useOnboardingCompleted
  : useStoredFlag;

/**
 * "Готово": the setup is done. In Tauri onboarding hides and the main
 * window shows; `next` is the route it opens there.
 */
export async function completeOnboarding(next?: string) {
  if (!inTauri) {
    write(true);
    return;
  }
  const done = await setOnboardingCompleted(true);
  if (done !== undefined && next) {
    await events.navigate.emitTo(MAIN_WINDOW, { route: next });
  }
}

export function resetOnboarding() {
  if (inTauri) {
    setOnboardingCompleted(false);
    return;
  }
  write(false);
}

/*
 * Where onboarding goes on after a restart ("Перезапустить" on the
 * permissions step). Kept in localStorage, which outlives the process in
 * Tauri too, and read once.
 */
const RESUME_KEY = "grill.onboarding-resume";
const ONBOARDING_PREFIX = "/onboarding";

export function rememberOnboardingResume(route: string) {
  try {
    window.localStorage.setItem(RESUME_KEY, route);
  } catch {
    // Storage is unavailable: after the restart onboarding starts over.
  }
}

/** The route to reopen, once; only onboarding routes are accepted. */
export function takeOnboardingResume(): string | null {
  try {
    const route = window.localStorage.getItem(RESUME_KEY);
    window.localStorage.removeItem(RESUME_KEY);
    return route?.startsWith(ONBOARDING_PREFIX) ? route : null;
  } catch {
    return null;
  }
}
