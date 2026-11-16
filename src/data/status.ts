"use client";

import type { BackendError } from "@/effect/tauri";

import { refreshCalls, useCallsState } from "./calls";
import { refreshPeople, usePeopleState } from "./people";
import { refreshProjects, useProjectsState } from "./projects";
import { refreshSettings, useSettingsState } from "./settings";
import type { LoadStatus } from "./synced-store";

/*
 * Whether the data of the main window is there: every store it reads has
 * done its first read. In the browser that is at once; in Tauri it waits
 * for the local database, and a failed first read (`Storage`: the
 * database could not be opened or migrated) stops the window.
 */

export interface DataLoad {
  error?: BackendError;
  status: LoadStatus;
}

export function useDataLoad(): DataLoad {
  const states = [
    useProjectsState(),
    usePeopleState(),
    useCallsState(),
    useSettingsState(),
  ];
  const failed = states.find((state) => state.status === "error");
  if (failed) {
    return { error: failed.error, status: "error" };
  }
  if (states.some((state) => state.status === "loading")) {
    return { status: "loading" };
  }
  return { status: "ready" };
}

/** Reads every store again. */
export async function retryDataLoad() {
  await Promise.all([
    refreshProjects(),
    refreshPeople(),
    refreshCalls(),
    refreshSettings(),
  ]);
}
