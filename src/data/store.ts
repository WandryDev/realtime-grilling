import { useSyncExternalStore } from "react";

/*
 * A tiny in-memory store for the mock data layer. Each slice in `src/data/*`
 * owns one store and exposes hooks plus actions; when the backend arrives the
 * actions turn into Tauri commands and the hooks keep their signatures.
 *
 * State lives in the JS module, so it survives client-side navigation and
 * resets on a full reload. The server snapshot is always the initial state,
 * which keeps prerendered HTML and the first client render identical.
 */
export interface Store<T> {
  get: () => T;
  set: (next: T | ((current: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
  use: () => T;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();

  const get = () => state;
  const getServerSnapshot = () => initial;

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const set = (next: T | ((current: T) => T)) => {
    state =
      typeof next === "function" ? (next as (current: T) => T)(state) : next;
    for (const listener of listeners) {
      listener();
    }
  };

  const use = () => useSyncExternalStore(subscribe, get, getServerSnapshot);

  return { get, set, subscribe, use };
}
