"use client";

import { setIntegration, useIntegration } from "@/data/integrations";
import {
  CLICKUP_DENIED_SUMMARY,
  cancelClickUpAuthorization,
  cancelConnect,
  startClickUpAuthorization,
} from "@/features/onboarding/integrations/api";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import {
  ClickUpConnectScreen,
  type ClickUpConnectState,
} from "@/features/onboarding/screens/clickup-connect-screen";

import { returnHref } from "./return-href";

/*
 * Step 05c, ClickUp OAuth: "Продолжить в браузере" opens the browser and
 * Grill waits for the redirect; the workspace connects a moment later.
 * "Отменить" goes back to the intro. A denied or abandoned sign-in is only
 * reachable with ?demo=error.
 */

export const CLICKUP_DEMO_STATES = ["error"] as const;

const STATE: Record<
  ReturnType<typeof useIntegration>["status"],
  ClickUpConnectState
> = {
  connected: "connected",
  connecting: "waiting",
  disconnected: "intro",
  error: "error",
};

function seedError() {
  cancelConnect("clickup");
  setIntegration("clickup", { error: CLICKUP_DENIED_SUMMARY, status: "error" });
}

export function ClickUpConnectFlow({
  demo,
  from,
}: {
  demo?: (typeof CLICKUP_DEMO_STATES)[number];
  from?: "done";
}) {
  useOnboardingIntegrationsSession(demo === "error" ? seedError : undefined);
  const clickup = useIntegration("clickup");

  return (
    <ClickUpConnectScreen
      backHref={returnHref(from)}
      className="h-svh"
      doneHref={returnHref(from)}
      onCancel={cancelClickUpAuthorization}
      onOpenBrowser={startClickUpAuthorization}
      onStart={startClickUpAuthorization}
      state={STATE[clickup.status]}
    />
  );
}
