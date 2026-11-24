"use client";

import { toast } from "@grill/ui/toast";
import { useCallback, useEffect, useState } from "react";
import type { AgentState } from "@/bindings";
import { refreshAgentLimit, useAgentLimit } from "@/data/agent-limit";
import { updateSetting, useSettings } from "@/data/settings";

import { publishAgentState } from "../agent-status";
import { checkAgent, isAbortError } from "../api";
import { AgentLoginDialog, AgentPathDialog } from "../dialogs/agent-dialogs";
import { AGENT_LIMIT_REACHED } from "../mock";
import { AgentSettings } from "../screens/agent-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/**
 * Settings → Агент in the app: what Claude Code answers (`agent_status`)
 * on open and on «Проверить снова», another CLI path checked before it is
 * saved, «Войти» through the onboarding login, and the share of the
 * limit of both windows (`agent_limit_get`, polled again by «Проверить
 * снова»). `limitLow` (?demo=limit-low): the session past its threshold.
 */
export function AgentSection({ limitLow = false }: { limitLow?: boolean }) {
  const values = useSettings();
  const nextSignal = useAbortSignal();
  const [agent, setShownAgent] = useState<AgentState | null>(null);
  const limit = useAgentLimit();
  const [checking, setChecking] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  // What the sidebar status shows follows every answer of this section.
  const setAgent = useCallback((next: AgentState) => {
    setShownAgent(next);
    publishAgentState(next);
  }, []);

  const openPathDialog = useCallback(() => setPathOpen(true), []);
  const openLoginDialog = useCallback(() => setLoginOpen(true), []);

  const readAgent = useCallback(async () => {
    setChecking(true);
    try {
      setAgent(await checkAgent(undefined, nextSignal()));
      setChecking(false);
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setChecking(false);
      setAgent({
        message:
          error instanceof Error ? error.message : "Claude Code не отвечает",
        status: "error",
      });
    }
  }, [nextSignal, setAgent]);

  useEffect(() => {
    readAgent();
  }, [readAgent]);

  // «Проверить снова» asks Claude Code again and polls the limit; the
  // share follows `SubscriptionLimitChanged` either way.
  const recheck = useCallback(() => {
    readAgent();
    refreshAgentLimit().catch((error: unknown) => {
      showErrorToast("Не получилось проверить лимит подписки", error);
    });
  }, [readAgent]);

  const signedIn = useCallback(async () => {
    toast.add({ title: "Вход выполнен", type: "success" });
    await readAgent();
  }, [readAgent]);

  return (
    <>
      <AgentSettings
        agent={agent}
        checking={checking}
        limit={limitLow ? AGENT_LIMIT_REACHED : limit}
        onChange={updateSetting}
        onChangePath={openPathDialog}
        onCheck={recheck}
        onSignIn={openLoginDialog}
        signingIn={loginOpen}
        values={values}
      />
      <AgentPathDialog
        current={values.agentPath ?? ""}
        onOpenChange={setPathOpen}
        onSaved={setAgent}
        open={pathOpen}
      />
      <AgentLoginDialog
        onOpenChange={setLoginOpen}
        onSignedIn={signedIn}
        open={loginOpen}
      />
    </>
  );
}
