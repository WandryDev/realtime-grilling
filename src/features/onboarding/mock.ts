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
  { id: "uk", label: "Украинский" },
];

/** Model download for the selected language, as the speech step shows it. */
export interface SpeechModelInfo {
  /** The hardware check failed: why, and what to do. */
  checkFailure?: {
    description: string;
    /** "Скачать запасную модель": turbo is too slow here. */
    fallback?: string;
    /** The model has to be downloaded again (it does not load). */
    redownload?: boolean;
    title: string;
  };
  /** "Проверяем модель": the sum of the file, or the hardware check. */
  checking: { caption?: string; description: string; title: string };
  /** Not enough space. */
  disk: {
    /** Under the bar: "Macintosh HD, занято 244,1 из 245 ГБ". */
    caption: string;
    free: string;
    missing: string;
    /** What the download needs. */
    need: string;
    /** The bar and what it measures. */
    percent: number;
    percentLabel: string;
  };
  /** Download in progress. */
  downloaded: string;
  /** "Скачиваем модель для русского языка" */
  downloadingTitle: string;
  /** The download or the file failed. */
  error?: { description: string; title: string };
  /** Free disk space, when known. */
  freeSpace?: string;
  /** Connection lost. */
  interrupted: {
    downloaded: string;
    percent: number;
    retryIn: string;
  };
  /** "Русский язык" */
  languageName: string;
  /** The mic check is listening (the red dot). */
  micListening: boolean;
  /** Instead of the text: nothing heard, or why the check failed. */
  micNote?: string;
  percent: number;
  /** "Готово, но…": the check could not tell or found it slow. */
  readyNote?: string;
  size: string;
  speed: string;
  timeLeft: string;
  /** "Модель для русского языка" */
  title: string;
  /** Mic check once the model is ready. */
  transcript: string;
}

export const SPEECH_MODEL: SpeechModelInfo = {
  checking: {
    caption: "574 МБ из 574 МБ",
    description: "Убеждаемся, что файл скачался целиком, это несколько секунд",
    title: "Проверяем модель",
  },
  disk: {
    caption: "Macintosh HD, занято 244,1 из 245 ГБ",
    free: "0,3 ГБ",
    missing: "0,3 ГБ",
    need: "631 МБ",
    percent: 99,
    percentLabel: "Занято на диске",
  },
  downloaded: "276 МБ",
  downloadingTitle: "Скачиваем модель для русского языка",
  freeSpace: "84 ГБ",
  interrupted: {
    downloaded: "362 МБ",
    percent: 63,
    retryIn: "0:24",
  },
  languageName: "Русский язык",
  micListening: true,
  percent: 48,
  size: "574 МБ",
  speed: "12,4 МБ/с",
  timeLeft: "Осталось меньше минуты",
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
