"use client";

import { useSearchParams } from "next/navigation";

import { DEMO_PARAM } from "./routes";

/*
 * Reads `?demo=<state>` so any screen state can be opened directly while the
 * backend doesn't exist yet (errors, empty states, the middle of a flow).
 * Ignored in production. Returns `undefined` when the param is missing or
 * not one of `states`.
 *
 * Uses useSearchParams: the component calling it must sit inside <Suspense>,
 * otherwise the static export fails to build.
 */
export function useDemoState<const T extends string>(
  states: readonly T[]
): T | undefined {
  const params = useSearchParams();
  if (process.env.NODE_ENV === "production") {
    return undefined;
  }
  const value = params.get(DEMO_PARAM);
  return states.find((state) => state === value);
}
