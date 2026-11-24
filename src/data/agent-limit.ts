"use client";

import { Effect, Stream } from "effect";
import { useEffect } from "react";
import type { LimitOutlook, SubscriptionLimitView } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";

import { AgentLimitData, mockAgentLimit } from "./services/agent-limit";
import { createStore } from "./store";

/*
 * The share of the subscription limit, as this window has it
 * (agent-limit-guard design.md, decision 9). One store per window, shared
 * by every screen that shows it: the start widget, the screen without a
 * call, the call window, the overlay, Settings → Агент, the summary and
 * the brief. The backend owns the share and the outlook; the store only
 * follows them.
 *
 * In Tauri the store reads the share when the window first uses it and
 * then follows `SubscriptionLimitChanged`. In the browser and the tests
 * the mock answers at once, and every change of `mockAgentLimit` lands in
 * the store synchronously.
 */

const limitStore = createStore<SubscriptionLimitView | null>(
  inTauri ? null : mockAgentLimit.view()
);

let following = false;

/** Reads the share and follows its changes, once per window. */
function follow() {
  if (following) {
    return;
  }
  following = true;
  if (!inTauri) {
    mockAgentLimit.subscribe((view) => limitStore.set(view));
    return;
  }
  appRuntime.runFork(
    AgentLimitData.use((data) =>
      Stream.runForEach(data.limit, (view) =>
        Effect.sync(() => limitStore.set(view))
      )
    ).pipe(
      // Unreadable: no warning shows, nothing stops; the next use retries.
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          following = false;
        })
      )
    )
  );
}

/** The share of the limit; `null` until the backend answered. */
export function useAgentLimit(): SubscriptionLimitView | null {
  useEffect(follow, []);
  return limitStore.use();
}

/** The outlook only: `ok` while the share is not known. */
export function useLimitOutlook(): LimitOutlook {
  return useAgentLimit()?.outlook ?? OK;
}

const OK: LimitOutlook = { kind: "ok" };

/** «Проверить»: a poll of `/usage` now; the store follows its answer. */
export async function refreshAgentLimit(): Promise<SubscriptionLimitView> {
  const view = await appRuntime.runPromise(
    AgentLimitData.use((data) => data.refresh)
  );
  limitStore.set(view);
  return view;
}

/** «Продолжить сверх лимита» for the recording of the call. */
export function allowOverLimit(recordingId: string): Promise<void> {
  return appRuntime.runPromise(
    AgentLimitData.use((data) => data.allowOver(recordingId))
  );
}

/** Tests: the store as a fresh window has it. */
export function resetAgentLimitStore() {
  limitStore.set(inTauri ? null : mockAgentLimit.view());
}
