import { SPEECH_MODEL, type SpeechModelInfo } from "./mock";

/*
 * What the speech step shows for a language and a download progress. The
 * figures are mock (1,5 ГБ at 12,4 МБ/с); the backend will report its own.
 */

const MODEL_MB = 1536;
const SPEED_MB_PER_SECOND = 12.4;
const MB_PER_GB = 1024;
const ABOUT_TWO_MINUTES = 90;
const ABOUT_A_MINUTE = 45;

const LANGUAGE_NAMES: Record<string, { genitive: string; name: string }> = {
  ru: { genitive: "русского", name: "Русский язык" },
  uk: { genitive: "украинского", name: "Украинский язык" },
};

function formatSize(mb: number) {
  if (mb < MB_PER_GB) {
    return `${Math.round(mb)} МБ`;
  }
  return `${(mb / MB_PER_GB).toFixed(1).replace(".", ",")} ГБ`;
}

function timeLeft(percent: number) {
  const seconds = (MODEL_MB * (1 - percent / 100)) / SPEED_MB_PER_SECOND;
  if (seconds > ABOUT_TWO_MINUTES) {
    return "Осталось около 2 минут";
  }
  if (seconds > ABOUT_A_MINUTE) {
    return "Осталось около минуты";
  }
  return "Осталось меньше минуты";
}

export function speechModelInfo({
  language,
  paused = false,
  percent,
}: {
  language: string;
  paused?: boolean;
  percent: number;
}): SpeechModelInfo {
  const names = LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.ru;
  const rounded = Math.round(percent);
  const downloaded = formatSize((MODEL_MB * percent) / 100);

  return {
    ...SPEECH_MODEL,
    downloaded,
    downloadingTitle: paused
      ? `Модель для ${names.genitive} языка на паузе`
      : `Скачиваем модель для ${names.genitive} языка`,
    interrupted: { ...SPEECH_MODEL.interrupted, downloaded, percent: rounded },
    languageName: names.name,
    percent: rounded,
    timeLeft: paused ? "Докачаем с того же места" : timeLeft(percent),
    title: `Модель для ${names.genitive} языка`,
  };
}
