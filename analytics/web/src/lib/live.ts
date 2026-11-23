"use client";

// Live changes (spec «Живое обновление»): the page listens to the server's
// SSE for what it shows and reads it again. EventSource reconnects by
// itself and sends `Last-Event-ID`: what was missed comes then.

import { useEffect, useRef, useState } from "react";
import { apiBase } from "./api";

export interface Watch {
  readonly call?: string;
  readonly project?: string;
}

export type Connection = "connecting" | "live" | "lost";

/** Calls `onChange` (at most every 300 ms) while changes of `watch` come. */
export const useLive = (
  watch: Watch | null,
  onChange: () => void
): Connection => {
  const [connection, setConnection] = useState<Connection>("connecting");
  const latest = useRef(onChange);
  latest.current = onChange;
  const key = watch ? `${watch.project ?? ""}|${watch.call ?? ""}` : null;

  useEffect(() => {
    if (key === null || typeof EventSource === "undefined") {
      return;
    }
    const [project, call] = key.split("|");
    const params = new URLSearchParams();
    if (project) {
      params.set("project", project);
    }
    if (call) {
      params.set("call", call);
    }
    const source = new EventSource(`${apiBase()}/api/live?${params}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.addEventListener("open", () => setConnection("live"));
    source.addEventListener("error", () => setConnection("lost"));
    source.addEventListener("change", () => {
      setConnection("live");
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          latest.current();
        }, 300);
      }
    });
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [key]);

  return connection;
};
