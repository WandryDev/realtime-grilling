"use client";

import { toast } from "@grill/ui/toast";
import { useCallback, useEffect, useState } from "react";
import type { AgentState, AgentUsage } from "@/bindings";
import { updateSetting, useSettings } from "@/data/settings";

import { publishAgentState } from "../agent-status";
import { checkAgent, isAbortError, readAgentUsage } from "../api";
import { AgentLoginDialog, AgentPathDialog } from "../dialogs/agent-dialogs";
import { AGENT_UTILIZATION_LOW } from "../mock";
import { AgentSettings } from "../screens/agent-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/**
 * Settings → Агент in the app: what Claude Code answers (`agent_status`)
 * on open and on «Проверить снова», another CLI path checked before it is
 * saved, «Войти» through the onboarding login, and the last known share
 * of the limit (`agent_usage`). `limitLow` (?demo=limit-low): less than
 * one call left in the window.
 */
export function AgentSection({ limitLow = false }: { limitLow?: boolean }) {
  const values = useSettings();
  const nextSignal = useAbortSignal();
  const [agent, setShownAgent] = useState<AgentState | null>(null);
  const [usage, setUsage] = useState<AgentUsage | null>(null);
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
    readAgentUsage(nextSignal()).then(
      (read) =>
        setUsage(
          limitLow && read
            ? { ...read, utilization: AGENT_UTILIZATION_LOW }
            : read
        ),
      (error: unknown) => {
        if (!isAbortError(error)) {
          showErrorToast("Не получилось прочитать лимит подписки", error);
        }
      }
    );
  }, [limitLow, nextSignal, readAgent]);

  const recheck = useCallback(() => {
    readAgent();
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
        onChange={updateSetting}
        onChangePath={openPathDialog}
        onCheck={recheck}
        onSignIn={openLoginDialog}
        signingIn={loginOpen}
        usage={usage}
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
