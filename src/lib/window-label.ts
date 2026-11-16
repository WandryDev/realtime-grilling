import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/*
 * Which Tauri window this page runs in: `main`, `onboarding`, `widget` or
 * `overlay` (`src-tauri/tauri.conf.json`). The four windows load at start
 * and stay loaded, so a window knows itself by its label, not by the route
 * it shows.
 */

export const MAIN_WINDOW = "main";

/** Label of this Tauri window; `null` in the browser and the prerender. */
export function currentWindowLabel(): string | null {
  return isTauri() ? getCurrentWindow().label : null;
}
