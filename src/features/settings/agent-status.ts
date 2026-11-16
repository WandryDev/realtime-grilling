"use client";

import { useEffect } from "react";

import type { AgentState } from "@/bindings";
import { createStore } from "@/data/store";

import { checkAgent } from "./api";

/*
 * What Claude Code answered last (`agent_status`), shared by the sidebar
 * status and Settings → Агент. The first subscriber reads it; one that
 * comes while the agent is not ready reads it again (the manager may have
 * signed in or installed it meanwhile). Settings → Агент publishes every
 * answer it gets, so the sidebar follows its «Проверить снова» and «Войти».
 */

const store = createStore<AgentState | null>(null);

let reading: Promise<void> | null = null;

/** Records an answer of `agent_status` (or of «Указать другой»). */
export function publishAgentState(agent: AgentState) {
  store.set(agent);
}

function readAgentState() {
  reading ??= checkAgent().then(
    (agent) => {
      reading = null;
      publishAgentState(agent);
    },
    (error: unknown) => {
      reading = null;
      publishAgentState({
        message:
          error instanceof Error ? error.message : "Claude Code не отвечает",
        status: "error",
      });
    }
  );
  return reading;
}

/** The agent's state, `null` until the first answer. */
export function useAgentState(): AgentState | null {
  const agent = store.use();
  useEffect(() => {
    if (store.get()?.status !== "ready") {
      readAgentState();
    }
  }, []);
  return agent;
}
