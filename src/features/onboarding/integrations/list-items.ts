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

/** What a service that isn't in the app yet will do. */
const SOON_DESCRIPTION: Record<IntegrationService, string> = {
  clickup: "Задачи и комментарии, подключится позже",
  github: "Код проектов, подключится позже",
  outline: "Документация, подключится позже",
};

export function toServiceListItems(
  integrations: IntegrationsState
): ServiceListItem[] {
  return SERVICES_NOTHING_CONNECTED.map(({ id }) => {
    const state = integrations[id];
    if (state.available === false) {
      return { description: SOON_DESCRIPTION[id], id, status: "soon" };
    }
    return {
      description: describe(id, state),
      id,
      status: ROW_STATUS[state.status],
    };
  });
}

/** What the summary says about a connected service. */
const SUMMARY_VALUE: Record<IntegrationService, string> = {
  clickup: "Pixel Agency",
  github: "12 репозиториев",
  outline: "docs.pixel.agency",
};

function summaryValue(service: IntegrationService, state: IntegrationState) {
  if (state.available === false) {
    return "скоро";
  }
  if (state.status !== "connected") {
    return "пропущено";
  }
  return (
    (service === "outline" ? state.team : undefined) ?? SUMMARY_VALUE[service]
  );
}

/*
 * Integrations of the summary. A service that failed or is still waiting
 * counts as skipped: the error isn't carried past the list.
 */
export function toSetupSummaryItems(
  integrations: IntegrationsState
): SetupSummaryItem[] {
  return SERVICES_NOTHING_CONNECTED.map(({ id }) => {
    const state = integrations[id];
    return {
      icon: id,
      label: SERVICE_NAMES[id],
      skipped: state.status !== "connected",
      soon: state.available === false,
      value: summaryValue(id, state),
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
