"use client";

import { useEffect } from "react";

import { toast } from "@/components/ui/toast";
import {
  type AgentStatus,
  detectAgent,
  forceAgent,
  installAgent,
  loginAgent,
  recheckAgent,
  useAgentSetup,
} from "@/data/onboarding-setup";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import { copyToClipboard } from "../api";
import { CLAUDE_CODE } from "../mock";
import {
  type AgentHandlers,
  AgentScreen,
  type AgentState,
} from "../screens/agent-screen";

const DEMO_STATES = [
  "checking",
  "ready",
  "needs-login",
  "not-installed",
  "installing",
  "install-error",
] as const satisfies readonly AgentState[];

function login() {
  loginAgent();
  // MOCK: the real app runs the Claude Code login, which opens the browser
  toast.add({
    description: "Войдите в Claude и вернитесь, Grill заметит сам.",
    title: "Открыли браузер",
    type: "info",
  });
}

async function copyLog() {
  const log = [...CLAUDE_CODE.errorLog, `Grill, ${navigator.userAgent}`].join(
    "\n"
  );
  const copied = await copyToClipboard(log);
  toast.add(
    copied
      ? { title: "Скопировали лог для поддержки", type: "success" }
      : { title: "Не получилось скопировать", type: "error" }
  );
}

const HANDLERS: AgentHandlers = {
  onCopyLog: copyLog,
  onInstall: installAgent,
  onLogin: login,
  onRecheck: recheckAgent,
  onRetry: installAgent,
};

function screenState(status: AgentStatus): AgentState {
  return status === "unknown" ? "checking" : status;
}

/* /onboarding/agent: step 04, Claude Code. */
export function AgentPage() {
  const demo = useDemoState(DEMO_STATES);
  const agent = useAgentSetup();

  useEffect(() => {
    if (demo) {
      forceAgent(demo);
    } else {
      detectAgent();
    }
  }, [demo]);

  return (
    <AgentScreen
      agent={{ ...CLAUDE_CODE, installPercent: agent.installPercent }}
      backHref={routes.onboarding("speech")}
      className="h-svh"
      handlers={HANDLERS}
      loginPending={agent.loginPending}
      nextHref={routes.onboarding("integrations")}
      state={screenState(agent.status)}
    />
  );
}
