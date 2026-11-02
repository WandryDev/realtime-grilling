"use client";

import { useRouter } from "next/navigation";
import { useCallback } from "react";

import { useIntegrations } from "@/data/integrations";
import { completeOnboarding } from "@/data/onboarding";
import { useSpeechSetup } from "@/data/onboarding-setup";
import {
  toRequiredSummaryItems,
  toSetupSummaryItems,
} from "@/features/onboarding/integrations/list-items";
import type { SetupSummaryItem } from "@/features/onboarding/integrations/mock";
import { useOnboardingIntegrationsSession } from "@/features/onboarding/integrations/session";
import { DoneScreen } from "@/features/onboarding/screens/done-screen";
import { type IntegrationService, routes } from "@/lib/routes";

/*
 * /onboarding/done — step 06. The integrations group comes from the store:
 * a skipped (or failed) service offers "Подключить", which opens its step
 * and comes back here. The speech row shows the model download progress
 * while it still runs (steps 02–04 state, `src/data/onboarding-setup.ts`). "Добавить первый проект" marks the setup done and
 * opens the app.
 */

const SERVICES: readonly string[] = [
  "github",
  "outline",
  "clickup",
] satisfies IntegrationService[];

function isService(value: string): value is IntegrationService {
  return SERVICES.includes(value);
}

const connectHref = (item: SetupSummaryItem) =>
  isService(item.icon)
    ? routes.onboardingIntegration(item.icon, "done")
    : undefined;

export function DonePage() {
  useOnboardingIntegrationsSession();
  const integrations = useIntegrations();
  const speech = useSpeechSetup();
  const router = useRouter();

  const finish = useCallback(() => {
    completeOnboarding();
    router.push(routes.newProject());
  }, [router]);

  return (
    <DoneScreen
      backHref={routes.onboarding("integrations")}
      className="h-svh"
      connectHref={connectHref}
      integrations={toSetupSummaryItems(integrations)}
      onFinish={finish}
      required={toRequiredSummaryItems(speech)}
    />
  );
}
