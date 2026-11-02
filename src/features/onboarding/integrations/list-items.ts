import type { IntegrationState, IntegrationsState } from "@/data/integrations";
import { isSpeechModelBusy, type SpeechSetup } from "@/data/onboarding-setup";
import { SPEECH_LANGUAGES } from "@/features/onboarding/mock";
import type { IntegrationService } from "@/lib/routes";

import {
  SERVICE_NAMES,
  SERVICES_NOTHING_CONNECTED,
  SETUP_SUMMARY_REQUIRED,
  type ServiceConnection,
  type ServiceListItem,
  type SetupSummaryItem,
} from "./mock";

/* Store state → rows of the integrations list and of the summary. */

const ROW_STATUS = {
  connected: "connected",
  connecting: "waiting",
  disconnected: "idle",
  error: "error",
} as const satisfies Record<IntegrationState["status"], ServiceConnection>;

const WAITING_DESCRIPTION: Record<IntegrationService, string> = {
  clickup: "Завершите вход во вкладке браузера",
  github: "Подтвердите доступ на github.com",
  outline: "Проверяем ключ",
};

function describe(service: IntegrationService, state: IntegrationState) {
  const idle = SERVICES_NOTHING_CONNECTED.find((item) => item.id === service);
  switch (state.status) {
    case "connected":
      return state.account ?? idle?.description ?? "";
    case "connecting":
      return WAITING_DESCRIPTION[service];
    case "error":
      return state.error ?? "Не подключилось, попробуйте снова";
    default:
      return idle?.description ?? "";
  }
}

export function toServiceListItems(
  integrations: IntegrationsState
): ServiceListItem[] {
  return SERVICES_NOTHING_CONNECTED.map(({ id }) => ({
    description: describe(id, integrations[id]),
    id,
    status: ROW_STATUS[integrations[id].status],
  }));
}

/** What the summary says about a connected service. */
const SUMMARY_VALUE: Record<IntegrationService, string> = {
  clickup: "Pixel Agency",
  github: "12 репозиториев",
  outline: "docs.pixel.agency",
};

/*
 * Integrations of the summary. A service that failed or is still waiting
 * counts as skipped: the error isn't carried past the list.
 */
export function toSetupSummaryItems(
  integrations: IntegrationsState
): SetupSummaryItem[] {
  return SERVICES_NOTHING_CONNECTED.map(({ id }) => {
    const connected = integrations[id].status === "connected";
    return {
      icon: id,
      label: SERVICE_NAMES[id],
      skipped: !connected,
      value: connected ? SUMMARY_VALUE[id] : "пропущено",
    };
  });
}

/*
 * Required steps of the summary. They are always done (the wizard doesn't
 * get here otherwise), but the speech model may still be downloading: then
 * its row shows the progress instead of the language.
 */
export function toRequiredSummaryItems(
  speech: SpeechSetup
): SetupSummaryItem[] {
  const language =
    SPEECH_LANGUAGES.find((item) => item.id === speech.language)?.label ??
    speech.language;
  const value = isSpeechModelBusy(speech.status)
    ? `${Math.round(speech.percent)}%`
    : language.toLowerCase();
  return SETUP_SUMMARY_REQUIRED.map((item) =>
    item.icon === "speech" ? { ...item, value } : item
  );
}
