"use client";

import { Effect, Stream } from "effect";
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import type { WindowLabel } from "@/bindings";
import { toast } from "@/components/ui/toast";
import { appRuntime, inTauri, runCancelable } from "@/effect/runtime";
import type { BackendError } from "@/effect/tauri";

import { ShellBackend } from "./backend";

/**
 * Calls `open` with every route Rust asks this window to open; the
 * returned function stops listening (call it on unmount).
 */
export function subscribeToNavigate(open: (route: string) => void) {
  return runCancelable(
    ShellBackend.use((shell) =>
      Stream.runForEach(shell.navigate, (route) =>
        Effect.sync(() => open(route))
      )
    ).pipe(Effect.catch(() => Effect.void))
  );
}

const HTML_SUFFIX = /\.html$/u;

/** The window a route belongs to: the floating ones, else the main window. */
export function windowOfRoute(route: string): WindowLabel {
  const [path = ""] = route.split("?");
  const page = path.replace(HTML_SUFFIX, "");
  if (page === "/overlay") {
    return "overlay";
  }
  if (page === "/widget") {
    return "widget";
  }
  return "main";
}

function showFailure(error: BackendError) {
  toast.add({
    description: error.message,
    title: "Не удалось открыть окно",
    type: "error",
  });
}

/** Shows the window `route` belongs to (Tauri); the main window opens it. */
function showWindowOf(route: string) {
  const label = windowOfRoute(route);
  return ShellBackend.use((shell) =>
    shell.show(label, label === "main" ? route : null)
  );
}

/**
 * From a floating window (Tauri): shows the window `route` belongs to and
 * hides this one. The main window opens the route; a floating one shows
 * the page it always has.
 */
export function handOver(route: string) {
  return appRuntime.runPromise(
    showWindowOf(route).pipe(
      Effect.andThen(ShellBackend.use((shell) => shell.hide)),
      Effect.catch((error) => Effect.sync(() => showFailure(error)))
    )
  );
}

/**
 * From the main window (Tauri): shows the floating window of `route`
 * ("Начать звонок" shows the start widget) and stays as it is.
 */
export function showFloatingWindow(route: string) {
  return appRuntime.runPromise(
    showWindowOf(route).pipe(
      Effect.catch((error) => Effect.sync(() => showFailure(error)))
    )
  );
}

/** Hides this window (Tauri); nothing in the browser. */
export function hideWindow() {
  return appRuntime.runPromise(
    ShellBackend.use((shell) => shell.hide).pipe(
      Effect.catch(() => Effect.void)
    )
  );
}

/**
 * Opens a route from a floating window: in Tauri by handing over to the
 * window it belongs to, in the browser by navigating the page.
 */
export function useOpenRoute() {
  const router = useRouter();
  return useCallback(
    (route: string) => {
      if (inTauri) {
        handOver(route);
      } else {
        router.push(route);
      }
    },
    [router]
  );
}

/**
 * Opens the local database again ("Повторить" on the storage error
 * screen). If it still fails, the stores' next read reports why.
 */
export function reopenStorage() {
  return appRuntime.runPromise(
    ShellBackend.use((shell) => shell.reopenStorage).pipe(
      Effect.catch(() => Effect.void)
    )
  );
}
