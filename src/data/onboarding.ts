"use client";

import { useSyncExternalStore } from "react";

/*
 * Whether the first-run setup is done. Unlike the other slices this one is
 * persisted (localStorage now, the app config later): the setup shows once.
 *
 * `useOnboardingDone()` returns `null` until the client has read the flag,
 * so prerendered HTML never guesses.
 */

const STORAGE_KEY = "grill.onboarding-done";
const listeners = new Set<() => void>();

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

export function useOnboardingDone(): boolean | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

export function completeOnboarding() {
  write(true);
}

export function resetOnboarding() {
  write(false);
}
