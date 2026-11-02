/*
 * Demo data for onboarding steps 01–04, verbatim from the Paper artboards
 * ("Онбординг"). Screens take these as prop defaults.
 */

export const WELCOME_FEATURES = [
  {
    icon: "mic",
    id: "transcribe",
    text: "Слушает звонок и расшифровывает разговор прямо на компьютере",
  },
  {
    icon: "question",
    id: "questions",
    text: "Сам подсказывает, что спросить у клиента, пока вы говорите",
  },
  {
    icon: "notes",
    id: "summary",
    text: "После звонка собирает итоги и список того, что осталось уточнить",
  },
] as const;

export type WelcomeFeature = (typeof WELCOME_FEATURES)[number];

export interface SpeechLanguage {
  id: string;
  label: string;
}

export const SPEECH_LANGUAGES: SpeechLanguage[] = [
  { id: "ru", label: "Русский" },
  { id: "uk", label: "Українська" },
];

/** Model download for the selected language, as the speech step shows it. */
export interface SpeechModelInfo {
  /** Not enough space. */
  disk: {
    name: string;
    used: string;
    total: string;
    usedPercent: number;
    free: string;
    missing: string;
  };
  /** Download in progress. */
  downloaded: string;
  /** "Скачиваем модель для русского языка" */
  downloadingTitle: string;
  freeSpace: string;
  /** Connection lost. */
  interrupted: {
    downloaded: string;
    percent: number;
    retryIn: string;
  };
  /** "Русский язык" */
  languageName: string;
  percent: number;
  size: string;
  speed: string;
  timeLeft: string;
  /** "Модель для русского языка" */
  title: string;
  /** Mic check once the model is ready. */
  transcript: string;
}

export const SPEECH_MODEL: SpeechModelInfo = {
  disk: {
    free: "0,9 ГБ",
    missing: "0,6 ГБ",
    name: "Macintosh HD",
    total: "245 ГБ",
    used: "244,1",
    usedPercent: 99,
  },
  downloaded: "720 МБ",
  downloadingTitle: "Скачиваем модель для русского языка",
  freeSpace: "84 ГБ",
  interrupted: {
    downloaded: "945 МБ",
    percent: 63,
    retryIn: "0:24",
  },
  languageName: "Русский язык",
  percent: 48,
  size: "1,5 ГБ",
  speed: "12,4 МБ/с",
  timeLeft: "Осталось около минуты",
  title: "Модель для русского языка",
  transcript: "Привет, это Дима, проверяю, как Grill меня слышит",
};

export interface AgentInfo {
  account: string;
  downloadedSize: string;
  /** Install steps while the agent isn't installed. */
  downloadSize: string;
  /** Technical reason of a failed install, one line per entry. */
  errorLog: string[];
  installPercent: number;
  name: string;
  plan: string;
  vendor: string;
  version: string;
}

export const CLAUDE_CODE: AgentInfo = {
  account: "dima@pixel.agency",
  downloadedSize: "58 МБ",
  downloadSize: "около 60 МБ",
  errorLog: [
    "Connection timed out after 30 s",
    "claude.ai/install.sh, попытка 2 из 2",
  ],
  installPercent: 70,
  name: "Claude Code",
  plan: "Claude Max",
  vendor: "Агент от Anthropic",
  version: "2.1.4",
};

/** Bar heights (px) of the system sound meter on the Windows step. */
export const SOUND_LEVELS = [6, 12, 18, 10, 14, 8, 5, 4, 4, 4];
