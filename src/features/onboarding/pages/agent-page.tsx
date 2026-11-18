"use client";

import { useEffect, useMemo } from "react";

import { toast } from "@/components/ui/toast";
import {
  type AgentFailure as AgentSetupFailure,
  type AgentStatus,
  cancelAgentInstall,
  cancelAgentLogin,
  detectAgent,
  forceAgent,
  getAgentSetup,
  installAgent,
  loginAgent,
  recheckAgent,
  refreshAgent,
  submitAgentLoginCode,
  useAgentSetup,
} from "@/data/onboarding-setup";
import { inTauri } from "@/effect/runtime";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";
import { copyToClipboard, openLoginPage } from "../api";
import { CLAUDE_CODE } from "../mock";
import {
  type AgentFailure,
  type AgentHandlers,
  AgentScreen,
  type AgentState,
} from "../screens/agent-screen";
import { useWindowFocus } from "../use-live-audio";

const DEMO_STATES = [
  "checking",
  "ready",
  "needs-login",
  "awaiting-code",
  "not-installed",
  "installing",
  "install-error",
  "error",
] as const satisfies readonly AgentState[];

const FAILURE_TITLES: Record<AgentSetupFailure["during"], string> = {
  check: "Не получилось проверить Claude Code",
  install: "Не получилось установить Claude Code",
  login: "Не получилось начать вход",
};

/*
 * The backend's message is a summary line, then (after a blank line) the
 * log of the installer or the CLI. People see the summary, support gets
 * the log.
 */
function toFailure({ during, message }: AgentSetupFailure): AgentFailure {
  const [summary = "", ...rest] = message.split("\n\n");
  return {
    log: rest
      .join("\n\n")
      .split("\n")
      .filter((line) => line.trim() !== ""),
    summary,
    title: FAILURE_TITLES[during],
  };
}

/** "Скопировать для поддержки": the full failure and this app's build. */
async function copyLog() {
  const { error } = getAgentSetup();
  const lines = error ? [error.message] : CLAUDE_CODE.errorLog;
  const log = [...lines, `Grill, ${navigator.userAgent}`].join("\n");
  const copied = await copyToClipboard(log);
  toast.add(
    copied
      ? { title: "Скопировали лог для поддержки", type: "success" }
      : { title: "Не получилось скопировать", type: "error" }
  );
}

/** "Открыть страницу ещё раз": the login page of the running login. */
function reopenLoginPage() {
  const { loginUrl } = getAgentSetup();
  if (!loginUrl) {
    return;
  }
  openLoginPage(loginUrl);
  if (!inTauri) {
    // MOCK: the app opens the browser itself
    toast.add({
      description: loginUrl,
      title: "Открыли страницу в браузере",
      type: "info",
    });
  }
}

const HANDLERS: AgentHandlers = {
  onCancelInstall: cancelAgentInstall,
  onCancelLogin: cancelAgentLogin,
  onCopyLog: copyLog,
  onInstall: installAgent,
  onLogin: loginAgent,
  onRecheck: recheckAgent,
  onReopenLogin: reopenLoginPage,
  onRetry: installAgent,
  onSubmitCode: submitAgentLoginCode,
};

function screenState(status: AgentStatus): AgentState {
  return status === "unknown" ? "checking" : status;
}

/* /onboarding/agent: step 04, Claude Code. */
export function AgentPage() {
  const demo = useDemoState(DEMO_STATES);
  const agent = useAgentSetup();
  const failure = useMemo(
    () => (agent.error ? toFailure(agent.error) : undefined),
    [agent.error]
  );

  useEffect(() => {
    if (demo) {
      forceAgent(demo);
    } else {
      detectAgent();
    }
  }, [demo]);
  // Installed or logged in in a terminal meanwhile
  useWindowFocus(refreshAgent);

  return (
    <AgentScreen
      agent={{
        ...CLAUDE_CODE,
        account: agent.account,
        installPercent: agent.installPercent,
        plan: agent.plan,
        version: agent.version ?? CLAUDE_CODE.version,
      }}
      backHref={routes.onboarding("speech")}
      className="h-svh"
      failure={failure}
      handlers={HANDLERS}
      loginError={agent.loginError ?? undefined}
      loginPending={agent.loginPending}
      loginSubmitting={agent.loginSubmitting}
      nextHref={routes.onboarding("integrations")}
      state={screenState(agent.status)}
    />
  );
}
