"use client";

import { useCallback } from "react";

import {
  clearIntegration,
  getIntegrations,
  type IntegrationState,
  setIntegration,
  useIntegration,
} from "@/data/integrations";
import { useConnectorContainers } from "@/features/connectors/api";
import { useClickUpConnect } from "@/features/connectors/clickup-connect";
import { CLICKUP_REJECTED_SUMMARY } from "@/features/onboarding/integrations/api";
import {
  CLICKUP_CONNECTION,
  CLICKUP_TOKENS,
  CLICKUP_WORKSPACES,
} from "@/features/onboarding/integrations/mock";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import {
  ClickUpConnectScreen,
  type ClickUpConnectState,
} from "@/features/onboarding/screens/clickup-connect-screen";
import { plural } from "@/lib/plural";

import { returnHref } from "./return-href";

/*
 * Step 05c, ClickUp by a personal token, on the `Connectors` service
 * (connectors spec, «Подключить ClickUp в онбординге»): the token is
 * checked with ClickUp; a refused one marks the field and keeps the focus
 * in it; a token that opens several workspaces asks which one, then
 * «Подключить» connects it. Success shows the workspace, whose token it
 * is and the spaces Grill sees; it is the same connection Settings shows.
 * `?demo=rejected` and `?demo=choose` force those states.
 */

export const CLICKUP_DEMO_STATES = ["rejected", "choose"] as const;

type Demo = (typeof CLICKUP_DEMO_STATES)[number];

const REJECTED = "Токен не подошёл. Скопируйте его целиком или создайте новый.";

/** How many space chips the card shows before «и ещё N». */
const CHIPS = 3;

function seedRejected() {
  setIntegration("clickup", {
    error: CLICKUP_REJECTED_SUMMARY,
    status: "error",
  });
}

/** The onboarding list keeps a refusal as «Исправить» until it is fixed. */
function rememberRefusal() {
  if (getIntegrations().clickup.status === "connected") {
    return;
  }
  setIntegration("clickup", {
    error: CLICKUP_REJECTED_SUMMARY,
    status: "error",
  });
}

/** The card of a connected ClickUp: workspace, user, spaces. */
function useConnection(clickup: IntegrationState) {
  const connected = clickup.status === "connected";
  const { state } = useConnectorContainers("clickup", connected);
  const spaces = state.status === "ready" ? state.nodes : [];
  return {
    moreCount: Math.max(0, spaces.length - CHIPS),
    spaces: spaces.slice(0, CHIPS).map((node) => node.title),
    spacesCount:
      state.status === "ready"
        ? `${spaces.length} ${plural(spaces.length, "пространство", "пространства", "пространств")}`
        : "",
    user: clickup.user ?? CLICKUP_CONNECTION.user,
    workspace: clickup.team ?? CLICKUP_CONNECTION.workspace,
  };
}

export function ClickUpConnectFlow({
  demo,
  from,
}: {
  demo?: Demo;
  from?: "done";
}) {
  useOnboardingIntegrationsSession(
    demo === "rejected" ? seedRejected : undefined
  );
  const clickup = useIntegration("clickup");
  const connection = useConnection(clickup);
  const connected = useCallback(() => clearIntegration("clickup"), []);
  const form = useClickUpConnect({
    initialError: demo === "rejected" ? REJECTED : undefined,
    initialToken: demo
      ? CLICKUP_TOKENS[demo === "rejected" ? "rejected" : "valid"]
      : "",
    initialWorkspaces: demo === "choose" ? CLICKUP_WORKSPACES : null,
    onConnected: connected,
    onRefused: rememberRefusal,
  });

  let state: ClickUpConnectState = form.error ? "rejected" : "form";
  if (clickup.status === "connected") {
    state = "connected";
  } else if (form.checking) {
    state = "checking";
  } else if (form.workspaces) {
    state = "choose";
  }

  return (
    <ClickUpConnectScreen
      backHref={returnHref(from)}
      className="h-svh"
      connection={connection}
      doneHref={returnHref(from)}
      form={form}
      state={state}
    />
  );
}
