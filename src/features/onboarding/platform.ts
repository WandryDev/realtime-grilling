"use client";

import { platform } from "@tauri-apps/plugin-os";
import { useSyncExternalStore } from "react";

import { inTauri } from "@/effect/runtime";

/*
 * Which variant of the onboarding steps to show. The app asks the OS
 * plugin; the browser, the tests and the prerender are macOS (the Windows
 * variant opens there with `?demo=windows`).
 */

const onWindows = () => inTauri && platform() === "windows";
const never = () => () => undefined;
const notOnServer = () => false;

/** The app runs on Windows. */
export function useRunsOnWindows(): boolean {
  return useSyncExternalStore(never, onWindows, notOnServer);
}
