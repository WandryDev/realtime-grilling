"use client";

import { setIntegration, useIntegrations } from "@/data/integrations";
import {
  CONNECTED_ACCOUNTS,
  cancelAllConnects,
  OUTLINE_REJECTED_SUMMARY,
} from "@/features/onboarding/integrations/api";
import { toServiceListItems } from "@/features/onboarding/integrations/list-items";
import type { ServiceId } from "@/features/onboarding/integrations/mock";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import { IntegrationsScreen } from "@/features/onboarding/screens/integrations-screen";
import { routes } from "@/lib/routes";
import { useDemoState } from "@/lib/use-demo-state";

/*
 * /onboarding/integrations — step 05. Rows reflect the integrations store:
 * connect a service on its step, come back and the row shows the new
 * status. "Пропустить" (nothing touched) or "Продолжить" leads to 06.
 */

export const INTEGRATIONS_DEMO_STATES = ["partial"] as const;

/*
 * Paper's mixed list: GitHub connected, the Outline key rejected, ClickUp
 * waiting for the browser ("Ждём браузер" opens its step, where "Открыть
 * вкладку ещё раз" finishes the sign-in).
 */
function seedPartial() {
  cancelAllConnects();
  setIntegration("github", {
    account: CONNECTED_ACCOUNTS.github,
    status: "connected",
  });
  setIntegration("outline", {
    error: OUTLINE_REJECTED_SUMMARY,
    status: "error",
  });
  setIntegration("clickup", { status: "connecting" });
}

const serviceHref = (service: ServiceId) =>
  routes.onboardingIntegration(service);

export function IntegrationsPage() {
  const demo = useDemoState(INTEGRATIONS_DEMO_STATES);
  useOnboardingIntegrationsSession(
    demo === "partial" ? seedPartial : undefined
  );
  const integrations = useIntegrations();

  return (
    <IntegrationsScreen
      backHref={routes.onboarding("agent")}
      className="h-svh"
      items={toServiceListItems(integrations)}
      nextHref={routes.onboarding("done")}
      serviceHref={serviceHref}
    />
  );
}
