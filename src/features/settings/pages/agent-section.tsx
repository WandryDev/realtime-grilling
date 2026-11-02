"use client";

import { useCallback, useState } from "react";

import { toast } from "@/components/ui/toast";
import { getSettings, updateSetting, useSettings } from "@/data/settings";

import { checkAgent, isAbortError, signInAgent } from "../api";
import { AgentPathDialog, AgentSignOutDialog } from "../dialogs/agent-dialogs";
import { AGENT, AGENT_LIMIT_LOW } from "../mock";
import { AgentSettings } from "../screens/agent-settings";
import { showErrorToast } from "../toasts";
import { useAbortSignal } from "../use-abort-signal";

/**
 * Settings → Агент in the app: re-check, another CLI path, sign out and in.
 * `limitLow` (?demo=limit-low): less than one call left in the window.
 */
export function AgentSection({ limitLow = false }: { limitLow?: boolean }) {
  const values = useSettings();
  const nextSignal = useAbortSignal();
  const [checking, setChecking] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);
  const [signOutOpen, setSignOutOpen] = useState(false);

  const openPathDialog = useCallback(() => setPathOpen(true), []);
  const openSignOutDialog = useCallback(() => setSignOutOpen(true), []);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      await checkAgent(getSettings().agentPath, nextSignal());
      setChecking(false);
      if (getSettings().agentSignedIn) {
        toast.add({ title: "Claude Code готов к звонку", type: "success" });
      } else {
        toast.add({
          description: "Войдите, чтобы агент предлагал вопросы",
          title: "Claude Code найден, вход не выполнен",
          type: "warning",
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setChecking(false);
      showErrorToast("Claude Code не отвечает", error);
    }
  }, [nextSignal]);

  const signOut = useCallback(() => {
    updateSetting("agentSignedIn", false);
    setSignOutOpen(false);
    toast.add({ title: "Вы вышли из Claude Code", type: "info" });
  }, []);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    try {
      await signInAgent(nextSignal());
      updateSetting("agentSignedIn", true);
      setSigningIn(false);
      toast.add({ title: "Вход выполнен", type: "success" });
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      setSigningIn(false);
      showErrorToast("Не получилось войти", error);
    }
  }, [nextSignal]);

  return (
    <>
      <AgentSettings
        agent={limitLow ? AGENT_LIMIT_LOW : AGENT}
        checking={checking}
        limitLow={limitLow}
        onChange={updateSetting}
        onChangePath={openPathDialog}
        onCheck={check}
        onSignIn={signIn}
        onSignOut={openSignOutDialog}
        signingIn={signingIn}
        values={values}
      />
      <AgentPathDialog
        current={values.agentPath}
        onOpenChange={setPathOpen}
        open={pathOpen}
      />
      <AgentSignOutDialog
        onConfirm={signOut}
        onOpenChange={setSignOutOpen}
        open={signOutOpen}
      />
    </>
  );
}
