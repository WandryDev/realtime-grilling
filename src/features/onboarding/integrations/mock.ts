/*
 * Demo data of the onboarding integration steps (05, 05a–05c, 06), text
 * verbatim from Paper.
 */

import type { IntegrationService } from "@/lib/routes";

export type ServiceId = "github" | "outline" | "clickup";

export type ServiceConnection = "idle" | "connected" | "waiting" | "error";

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
    description: "dima-kapish, доступ к 12 репозиториям",
    id: "github",
    status: "connected",
  },
  {
    description: "Ключ не подошёл, проверьте его",
    id: "outline",
    status: "error",
  },
  {
    description: "Завершите вход во вкладке браузера",
    id: "clickup",
    status: "waiting",
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

export const CLICKUP_WORKSPACE = {
  errorCode: "access_denied, 12:04",
  listsCount: "38 списков",
  moreCount: 6,
  name: "Pixel Agency",
  people: ["Андрей, разработчик", "Марта, дизайнер"],
  summary: "рабочее пространство ClickUp",
};

export const CLICKUP_CAPABILITIES = [
  { allowed: true, label: "Читать задачи, описания и комментарии" },
  { allowed: true, label: "Видеть, кто из команды над чем работает" },
  { allowed: false, label: "Ничего не меняет и не создаёт в ClickUp" },
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
  clickup: 2200,
  github: 2500,
  outline: 1200,
} as const satisfies Record<IntegrationService, number>;

/** What the list shows for each service once it is connected. */
export const CONNECTED_ACCOUNTS = {
  clickup: "Workspace «Pixel Agency», 38 списков",
  github: "dima-kapish, доступ к 12 репозиториям",
  outline: "docs.pixel.agency, 14 коллекций",
} as const satisfies Record<IntegrationService, string>;
