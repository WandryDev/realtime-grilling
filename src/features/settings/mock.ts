import type {
  AgentState,
  DataSummary,
  InputDevice,
  ModelId,
  RecordingsInfo,
  SpeechModel,
} from "@/bindings";
import type { StoredBenchmark } from "@/data/settings";

/*
 * Demo data of the settings screens, text verbatim from the Paper file.
 */

export type SettingsSectionId =
  | "general"
  | "audio"
  | "agent"
  | "widget"
  | "integrations"
  | "privacy";

export interface SettingsSectionInfo {
  description: string;
  id: SettingsSectionId;
  label: string;
  title: string;
}

/** Sections in the order of the settings sidebar. */
export const SETTINGS_SECTIONS: SettingsSectionInfo[] = [
  {
    description:
      "Язык звонков, запуск и где Grill хранит записи на этом компьютере",
    id: "general",
    label: "Общие",
    title: "Общие",
  },
  {
    description:
      "Откуда Grill слышит вас и клиента и как превращает речь в текст. Всё работает на этом компьютере",
    id: "audio",
    label: "Звук и распознавание",
    title: "Звук и распознавание",
  },
  {
    description:
      "Локальный CLI, который слушает расшифровку и предлагает вопросы клиенту",
    id: "agent",
    label: "Агент",
    title: "Агент",
  },
  {
    description:
      "Как Grill появляется, когда начинается звонок, и как им управлять, не переключая окна",
    id: "widget",
    label: "Виджет и клавиши",
    title: "Виджет и клавиши",
  },
  {
    description:
      "Все необязательные. Подключённые сервисы доступны во всех проектах, а какие репозитории, коллекции и списки задач смотреть, выбирается в каждом проекте.",
    id: "integrations",
    label: "Интеграции",
    title: "Интеграции",
  },
  {
    description:
      "Записи и расшифровки лежат только на этом компьютере. Решите, сколько их держать",
    id: "privacy",
    label: "Приватность и хранение",
    title: "Приватность и хранение",
  },
];

export interface SelectOption {
  label: string;
  value: string;
}

/* ---------------------------------------------------------------- Общие */

export const CALL_LANGUAGES: SelectOption[] = [
  { label: "Русский", value: "ru" },
  { label: "Украинский", value: "uk" },
  { label: "Оба", value: "both" },
];

export const THEMES: SelectOption[] = [
  { label: "Светлая", value: "light" },
  { label: "Тёмная", value: "dark" },
  { label: "Как в системе", value: "system" },
];

/** The recordings' folder of the demo. */
export const RECORDINGS: RecordingsInfo = {
  bytes: 1_200_000_000,
  calls: 38,
  path: "~/Library/Application Support/Grill/recordings",
};

/* ------------------------------------------------- Звук и распознавание */

/** The demo's microphones: the MacBook's own one is the default. */
export const MICROPHONES: InputDevice[] = [
  { id: "Микрофон MacBook Pro", isDefault: true, name: "Микрофон MacBook Pro" },
  { id: "AirPods Pro Димы", isDefault: false, name: "AirPods Pro Димы" },
];

/** The headphones of the «микрофон отключён» demo. */
export const DISCONNECTED_MICROPHONE = "AirPods Pro Димы";

/** How long ago the headphones of the demo went missing, ms. */
export const DISCONNECTED_AGO_MS = 2 * 60_000;

/** The speech models of the preview: turbo ready and selected. */
export const SPEECH_MODELS: SpeechModel[] = [
  {
    id: "turbo",
    name: "Whisper large-v3-turbo",
    selected: true,
    sizeBytes: 574_041_195,
    state: { status: "ready" },
  },
  {
    id: "small",
    name: "Whisper small",
    selected: false,
    sizeBytes: 487_601_967,
    state: { status: "notDownloaded" },
  },
];

/** What each model is for, under its name. */
export const SPEECH_MODEL_NOTES: Record<ModelId, string> = {
  small: "Запасная: быстрее на слабых компьютерах, чуть менее точная",
  turbo: "Основная: русский и украинский, точнее на смешанной речи",
};

/** The hardware check of the preview's selected model. */
export const SPEECH_BENCHMARK: StoredBenchmark = {
  p95Ms: 1473,
  passed: true,
  rtf: 0.18,
  wer: 0.032,
};

/* ---------------------------------------------------------------- Агент */

/** Claude Code of the demo: found, signed in. */
export const AGENT: AgentState = {
  status: "ready",
  subscriptionType: "max",
  version: "2.1.14",
};

/** The share of the subscription limit of the demo, 0–1. */
export const AGENT_UTILIZATION = 0.38;

/** From this share up the limit turns red: less than one call left. */
export const AGENT_LIMIT_LOW = 0.9;

/** The demo's limit in ?demo=limit-low. */
export const AGENT_UTILIZATION_LOW = 0.94;

export const QUESTION_FREQUENCY: SelectOption[] = [
  { label: "Реже", value: "rare" },
  { label: "Обычно", value: "normal" },
  { label: "Чаще", value: "often" },
];

export const QUESTION_COUNT: SelectOption[] = [
  { label: "1", value: "1" },
  { label: "3", value: "3" },
  { label: "5", value: "5" },
];

/* ----------------------------------------------------- Виджет и клавиши */

export const MIC_BUSY_BEHAVIORS: (SelectOption & { description: string })[] = [
  {
    description:
      "С последним проектом и участниками. Звонок начнётся по кнопке «Начать»",
    label: "Показать виджет старта",
    value: "widget",
  },
  {
    description:
      "Виджет покажет, что запись идёт, и даст отменить в первые 30 секунд",
    label: "Начинать запись сразу",
    value: "record",
  },
  {
    description:
      "Звонок начинается только вручную, из окна или сочетанием клавиш",
    label: "Ничего не делать",
    value: "nothing",
  },
];

export const AUTO_END: SelectOption[] = [
  { label: "5 мин", value: "5" },
  { label: "10 мин", value: "10" },
  { label: "Никогда", value: "never" },
];

export interface Shortcut {
  id: string;
  keys: string[];
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  {
    id: "toggle-call",
    keys: ["⌥", "⌘", "G"],
    label: "Начать или завершить звонок",
  },
  {
    id: "toggle-overlay",
    keys: ["⌥", "⌘", "O"],
    label: "Показать или скрыть оверлей",
  },
  { id: "next-question", keys: ["⌥", "⌘", "→"], label: "Следующий вопрос" },
  {
    id: "mark-asked",
    keys: ["⌥", "⌘", "↩"],
    label: "Отметить вопрос заданным",
  },
  { id: "hide-question", keys: ["⌥", "⌘", "⌫"], label: "Скрыть вопрос" },
];

/* ------------------------------------------------- Приватность и хранение */

export const DATA_POLICY = [
  {
    id: "local",
    kind: "check",
    text: "Аудио, расшифровки и итоги звонков не покидают этот компьютер. Своего облака у Grill нет",
  },
  {
    id: "agent",
    kind: "agent",
    text: "Единственное исключение: агент Claude Code получает фрагменты расшифровки и бриф, чтобы предложить вопросы. Это идёт через вашу подписку Anthropic",
  },
  {
    id: "integrations",
    kind: "check",
    text: "Outline, GitHub и ClickUp Grill только читает. Ключи лежат в Keychain",
  },
] as const;

/** Days of `audioRetention`, as Rust stores them. */
export const AUDIO_RETENTION: SelectOption[] = [
  { label: "7 дней", value: "7" },
  { label: "30 дней", value: "30" },
  { label: "90 дней", value: "90" },
  { label: "Не удалять", value: "never" },
];

/** Days of `transcriptRetention`, as Rust stores them. */
export const TRANSCRIPT_RETENTION: SelectOption[] = [
  { label: "Через 3 месяца", value: "90" },
  { label: "Через 6 месяцев", value: "180" },
  { label: "Через год", value: "365" },
  { label: "Не удалять", value: "never" },
];

/** What «Удалить всё» deletes in the demo. */
export const DATA_SUMMARY: DataSummary = {
  bytes: 1_200_000_000,
  calls: 38,
  projects: 4,
};

/* ----------------------------------------------------------- Интеграции */

export const GITHUB = {
  account: "Аккаунт dima-kapish, доступ к 12 репозиториям, только чтение",
  hiddenRepos: 9,
  pitch: "Код репозиториев для технических вопросов на звонке",
  repos: ["telemedia/backend", "telemedia/web", "lapa/app"],
};

export const OUTLINE = {
  connected: "Документы и коллекции, только чтение",
  error: "Ключ больше не подходит: истёк или был отозван",
  host: "docs.pixel.agency",
  impact:
    "Пока ключ не обновлён, документы Outline в проектах остаются с последним текстом. Последний раз работало 14 октября.",
  pitch: "Документация и договорённости из базы знаний",
};

export const CLICKUP = {
  description: "Пространство Pixel Agency, только чтение задач и комментариев",
  error: "Токен больше не подходит: истёк или был отозван",
  impact:
    "Пока токен не обновлён, задачи ClickUp в проектах остаются с последним текстом.",
  pitch: "Задачи и комментарии, чтобы спрашивать по делу",
  syncedAt: "12:04",
  user: "Дима Капиш",
  workspace: "Pixel Agency",
};

export const SERVICE_NAMES = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
} as const;

/**
 * How the services' data reaches the agent (connectors spec, «Данные
 * коннекторов и агент»): Grill reads them itself, the agent gets the text.
 */
export const AGENT_MCP = {
  description:
    "Grill сам загружает документы и задачи, выбранные в проекте, и передаёт агенту их текст. Доступа к сервисам, ключей и токенов у агента нет.",
  version: "2.1.4",
};

export interface DisconnectContent {
  consequences: string[];
  description: string;
  footnote: string;
  title: string;
}

export const DISCONNECT_GITHUB: DisconnectContent = {
  consequences: [
    "Выбранные в проектах репозитории запомнятся",
    "Итоги прошлых звонков останутся как есть",
  ],
  description:
    "На звонках Grill перестанет заглядывать в код. Это коснётся двух проектов: «Телемедиа» и «Ветклиника Лапа».",
  footnote:
    "Токен удалится с этого компьютера. Полностью отозвать доступ Grill можно на github.com в настройках аккаунта.",
  title: "Отключить GitHub?",
};

export const DISCONNECT_OUTLINE: DisconnectContent = {
  consequences: [
    "Выбранные в проектах коллекции и документы запомнятся",
    "Документы Outline останутся в проектах с последним текстом",
    "Обновляться они снова начнут, когда Outline подключат",
  ],
  description:
    "Grill перестанет обновлять документы из Outline. Это коснётся проекта «Телемедиа».",
  footnote:
    "Ключ удалится из Keychain. Отозвать его можно в настройках Outline, раздел API.",
  title: "Отключить Outline?",
};

/** «Телемедиа», «Телемедиа» и «Лапа», «А», «Б» и «В». */
function quotedList(names: string[]) {
  const quoted = names.map((name) => `«${name}»`);
  if (quoted.length < 2) {
    return quoted.join("");
  }
  return `${quoted.slice(0, -1).join(", ")} и ${quoted.at(-1)}`;
}

/** «Это коснётся проекта «Телемедиа».» */
function touchesLine(projects: string[], nothing: string) {
  if (projects.length === 1) {
    return `Это коснётся проекта ${quotedList(projects)}.`;
  }
  if (projects.length > 1) {
    return `Это коснётся проектов ${quotedList(projects)}.`;
  }
  return nothing;
}

/** «Отключить Outline?» naming the projects that picked its documents. */
export function disconnectOutlineContent(
  projects: string[]
): DisconnectContent {
  const touches = touchesLine(
    projects,
    "Ни один проект пока не выбрал документы Outline."
  );
  return {
    ...DISCONNECT_OUTLINE,
    description: `Grill перестанет обновлять документы из Outline. ${touches}`,
  };
}

export const DISCONNECT_CLICKUP: DisconnectContent = {
  consequences: [
    "Выбранные в проектах пространства, списки и задачи запомнятся",
    "Задачи ClickUp останутся в проектах с последним текстом",
    "Обновляться они снова начнут, когда ClickUp подключат",
  ],
  description:
    "Grill перестанет обновлять задачи из ClickUp. Это коснётся проекта «Телемедиа».",
  footnote:
    "Токен удалится из Keychain. Отозвать его можно в ClickUp: Settings → Apps.",
  title: "Отключить ClickUp?",
};

/** «Отключить ClickUp?» naming the projects that picked its tasks. */
export function disconnectClickUpContent(
  projects: string[]
): DisconnectContent {
  const touches = touchesLine(
    projects,
    "Ни один проект пока не выбрал задачи ClickUp."
  );
  return {
    ...DISCONNECT_CLICKUP,
    description: `Grill перестанет обновлять задачи из ClickUp. ${touches}`,
  };
}

/* ------------------------------------------------- Состояния для ?demo */

/** The word to type before "Очистить всё" deletes everything. */
export const DELETE_CONFIRM_WORD = "удалить";
