/*
 * Demo data of the onboarding integration steps (05, 05a–05c, 06), text
 * verbatim from Paper.
 */

import { MOCK_CONNECT_DELAY_MS } from "@/data/services/connectors";
import type { IntegrationService } from "@/lib/routes";

export type ServiceId = "github" | "outline" | "clickup";

/** `soon`: not in the app yet (GitHub, ClickUp), nothing to connect. */
export type ServiceConnection =
  | "idle"
  | "connected"
  | "waiting"
  | "error"
  | "soon";

export interface ServiceListItem {
  /** What the service is for, the account, or what went wrong. */
  description: string;
  id: ServiceId;
  status: ServiceConnection;
}

export const SERVICE_NAMES: Record<ServiceId, string> = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
};

export const SERVICES_NOTHING_CONNECTED: ServiceListItem[] = [
  { description: "Код проектов, только чтение", id: "github", status: "idle" },
  {
    description: "Документация и брифы проектов",
    id: "outline",
    status: "idle",
  },
  {
    description: "Задачи и комментарии, только чтение",
    id: "clickup",
    status: "idle",
  },
];

export const SERVICES_PARTLY_CONNECTED: ServiceListItem[] = [
  {
    description: "Подтвердите доступ на github.com",
    id: "github",
    status: "waiting",
  },
  {
    description: "Ключ не подошёл, проверьте его",
    id: "outline",
    status: "error",
  },
  {
    description: "Pixel Agency, Дима Капиш",
    id: "clickup",
    status: "connected",
  },
];

export const GITHUB_DEVICE = {
  code: "WDJB-MJHT",
  remainingAtStart: "14:52",
  remainingWhileWaiting: "13:47",
  verificationUrl: "github.com/login/device",
};

export const GITHUB_ACCOUNT = {
  initial: "Д",
  login: "dima-kapish",
  moreCount: 9,
  repositories: ["telemedia/backend", "telemedia/web", "lapa/app"],
  summary: "Доступ к 12 репозиториям, только чтение",
};

export const OUTLINE_CONNECTION = {
  collections: ["Телемедиа", "Ветклиника Лапа", "Логистик Про"],
  collectionsCount: "14 коллекций",
  host: "docs.pixel.agency",
  moreCount: 11,
  team: "Pixel Agency",
  url: "https://docs.pixel.agency",
};

export const OUTLINE_KEYS = {
  rejected: "ol_api_x9Pq4Lm2Vb7Nd3Wf7Xk",
  valid: "ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2",
};

/** What the ClickUp step shows once connected (previews). */
export const CLICKUP_CONNECTION = {
  moreCount: 0,
  spaces: ["Клиенты", "Внутреннее"],
  spacesCount: "2 пространства",
  user: "Дима Капиш",
  workspace: "Pixel Agency",
};

export const CLICKUP_TOKENS = {
  rejected: "pk_4815162_Q7Z2ABCDEF1234567890",
  valid: "pk_4815162_Q7Z2LM8NX4WD9KTR3HB6YC1P",
};

/** The workspaces a token opens, for the «choose» preview. */
export const CLICKUP_WORKSPACES = [
  { id: "9001", name: "Pixel Agency" },
  { id: "9002", name: "Личное" },
];

export type SetupSummaryIcon =
  | "microphone"
  | "speech"
  | "claude"
  | "github"
  | "outline"
  | "clickup";

export interface SetupSummaryItem {
  icon: SetupSummaryIcon;
  label: string;
  /** Skipped integrations are gray and offer "Подключить". */
  skipped?: boolean;
  /** Not in the app yet: gray, «скоро», nothing to connect. */
  soon?: boolean;
  value: string;
  /** Versions are set in mono. */
  valueMono?: boolean;
}

export const SETUP_SUMMARY_REQUIRED: SetupSummaryItem[] = [
  { icon: "microphone", label: "Микрофон и звук звонка", value: "разрешено" },
  { icon: "speech", label: "Распознавание речи", value: "русский" },
  {
    icon: "claude",
    label: "Агент Claude Code",
    value: "2.1.4",
    valueMono: true,
  },
];

export const SETUP_SUMMARY_INTEGRATIONS: SetupSummaryItem[] = [
  { icon: "github", label: "GitHub", value: "12 репозиториев" },
  { icon: "outline", label: "Outline", skipped: true, value: "пропущено" },
  { icon: "clickup", label: "ClickUp", value: "Pixel Agency" },
];

/* Mock backend (`IntegrationsBackend.layerMock`) ------------------------ */

/** How long each fake round trip takes. */
export const CONNECT_DELAY_MS = {
  clickup: MOCK_CONNECT_DELAY_MS,
  github: 2500,
  outline: MOCK_CONNECT_DELAY_MS,
} as const satisfies Record<IntegrationService, number>;

/** What the list shows for each service once it is connected. */
export const CONNECTED_ACCOUNTS = {
  clickup: "Pixel Agency, Дима Капиш",
  github: "dima-kapish, доступ к 12 репозиториям",
  outline: "docs.pixel.agency, 14 коллекций",
} as const satisfies Record<IntegrationService, string>;
