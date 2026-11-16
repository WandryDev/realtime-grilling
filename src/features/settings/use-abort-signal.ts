"use client";

import { useCallback, useEffect, useRef } from "react";

/*
 * Signals for the fake async operations of a screen (see api.ts): each call
 * returns a fresh AbortSignal, and all of them abort when the component
 * unmounts, so no timer outlives the screen.
 */
export function useAbortSignal() {
  const controllers = useRef(new Set<AbortController>());

  useEffect(() => {
    const active = controllers.current;
    return () => {
      for (const controller of active) {
        controller.abort();
      }
      active.clear();
    };
  }, []);

  return useCallback(() => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller.signal;
  }, []);
}
