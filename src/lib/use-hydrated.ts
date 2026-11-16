import { useSyncExternalStore } from "react";

const subscribe = () => () => undefined;

/**
 * `false` while prerendering and hydrating, `true` after: for what the
 * prerendered HTML must not guess.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore<boolean>(
    subscribe,
    () => true,
    () => false
  );
}
