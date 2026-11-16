"use client";

import { useCallback, useState } from "react";

import { disconnectIntegration, useIntegration } from "@/data/integrations";
import {
  cancelConnect,
  copyToClipboard,
  INITIAL_DEVICE_CODE,
  openInBrowser,
  requestGitHubDeviceCode,
  startGitHubAuthorization,
} from "@/features/onboarding/integrations/api";
import { GITHUB_DEVICE } from "@/features/onboarding/integrations/mock";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import {
  GitHubConnectScreen,
  type GitHubConnectState,
} from "@/features/onboarding/screens/github-connect-screen";

import { returnHref } from "./return-href";

/*
 * Step 05a, the GitHub device flow: the code is shown (and counts as
 * copied), "Открыть github.com/login/device" opens the browser and Grill
 * waits; GitHub answers on its own a moment later. "Готово" returns.
 * The 15-minute expiry is only reachable with ?demo=expired.
 */

export const GITHUB_DEMO_STATES = ["expired"] as const;

function seedExpired() {
  cancelConnect("github");
  disconnectIntegration("github");
}

export function GitHubConnectFlow({
  demo,
  from,
}: {
  demo?: (typeof GITHUB_DEMO_STATES)[number];
  from?: "done";
}) {
  useOnboardingIntegrationsSession(
    demo === "expired" ? seedExpired : undefined
  );
  const github = useIntegration("github");
  const [code, setCode] = useState(INITIAL_DEVICE_CODE);
  const [expired, setExpired] = useState(demo === "expired");

  const openBrowser = useCallback(() => {
    openInBrowser(GITHUB_DEVICE.verificationUrl);
    startGitHubAuthorization();
  }, []);

  const copy = useCallback(() => copyToClipboard(code), [code]);

  const newCode = useCallback(() => {
    const next = requestGitHubDeviceCode();
    setCode(next);
    setExpired(false);
    copyToClipboard(next);
  }, []);

  let state: GitHubConnectState = expired ? "expired" : "code";
  if (github.status === "connected") {
    state = "connected";
  } else if (github.status === "connecting") {
    state = "waiting";
  }

  return (
    <GitHubConnectScreen
      backHref={returnHref(from)}
      className="h-svh"
      device={{ ...GITHUB_DEVICE, code }}
      doneHref={returnHref(from)}
      onCopy={copy}
      onNewCode={newCode}
      onOpenBrowser={openBrowser}
      state={state}
    />
  );
}
