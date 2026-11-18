"use client";

import { Effect, Stream } from "effect";
import { useEffect, useState } from "react";

import type { UpdateStatus } from "@/bindings";
import { appRuntime, runCancelable } from "@/effect/runtime";

import { UpdatesBackend } from "./backend";

/*
 * React side of the updates (`./backend.ts`): the status as a hook, the
 * check and the install as promises. A failed install rejects with the
 * tagged error, whose `message` the caller shows.
 */

/** The update status, `null` until the backend answered. */
export function useUpdateStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(
    () =>
      runCancelable(
        UpdatesBackend.use((backend) =>
          backend.status.pipe(
            Stream.runForEach((next) => Effect.sync(() => setStatus(next))),
            // Without the status the screens show no update: nothing to do.
            Effect.ignore
          )
        )
      ),
    []
  );
  return status;
}

/** «Проверить обновления». */
export function checkForUpdates(): Promise<UpdateStatus> {
  return appRuntime.runPromise(UpdatesBackend.use((backend) => backend.check));
}

/** «Перезапустить»: the app restarts into the downloaded version. */
export function installUpdate(): Promise<void> {
  return appRuntime.runPromise(
    UpdatesBackend.use((backend) => backend.install)
  );
}
