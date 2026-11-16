import type { SpeechSetup } from "@/data/onboarding-setup";

import { SPEECH_MODEL, type SpeechModelInfo } from "./mock";

/*
 * What the speech step shows for the model the backend reports: sizes,
 * speed and time left, the disk when there is no room, the countdown to
 * the next try without network, and the hardware check's verdict.
 */

const BYTES_PER_MB = 1_000_000;
const MB_PER_GB = 1000;
const SECONDS_PER_MINUTE = 60;
const ABOUT_A_MINUTE = 45;
const ABOUT_TWO_MINUTES = 90;
const MS_PER_SECOND = 1000;
const PERCENT = 100;

const LANGUAGE_NAMES: Record<string, { genitive: string; name: string }> = {
  ru: { genitive: "русского", name: "Русский язык" },
  uk: { genitive: "украинского", name: "Украинский язык" },
};

/** "574 МБ", "1,2 ГБ": decimal units, as macOS counts disk space. */
export function formatBytes(bytes: number) {
  const mb = bytes / BYTES_PER_MB;
  if (mb < MB_PER_GB) {
    return `${Math.round(mb)} МБ`;
  }
  return `${(mb / MB_PER_GB).toFixed(1).replace(".", ",")} ГБ`;
}

function formatSpeed(bytesPerSec: number) {
  return `${(bytesPerSec / BYTES_PER_MB).toFixed(1).replace(".", ",")} МБ/с`;
}

function minutesWord(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return "минуту";
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "минуты";
  }
  return "минут";
}

function timeLeft(remainingBytes: number, bytesPerSec: number) {
  if (bytesPerSec <= 0) {
    return "Считаем, сколько осталось";
  }
  const seconds = remainingBytes / bytesPerSec;
  if (seconds > ABOUT_TWO_MINUTES) {
    const minutes = Math.round(seconds / SECONDS_PER_MINUTE);
    return `Осталось около ${minutes} ${minutesWord(minutes)}`;
  }
  if (seconds > ABOUT_A_MINUTE) {
    return "Осталось около минуты";
  }
  return "Осталось меньше минуты";
}

/** "0:24" until the next try; "0:00" once it is due. */
function retryIn(speech: SpeechSetup, now: number) {
  if (!speech.retry) {
    return "0:00";
  }
  // `now` may be from before the news came
  const passed = Math.max(
    0,
    Math.floor((now - speech.retry.at) / MS_PER_SECOND)
  );
  const left = Math.max(0, speech.retry.inSec - passed);
  const seconds = left % SECONDS_PER_MINUTE;
  return `${Math.floor(left / SECONDS_PER_MINUTE)}:${seconds.toString().padStart(2, "0")}`;
}

function disk(speech: SpeechSetup): SpeechModelInfo["disk"] {
  if (!speech.space) {
    return SPEECH_MODEL.disk;
  }
  const { freeBytes, needBytes } = speech.space;
  const free = formatBytes(freeBytes);
  const need = formatBytes(needBytes);
  return {
    caption: `Свободно ${free}, нужно ${need}`,
    free,
    missing: formatBytes(Math.max(0, needBytes - freeBytes)),
    need,
    percent: needBytes > 0 ? Math.round((freeBytes / needBytes) * PERCENT) : 0,
    percentLabel: "Свободно из нужного",
  };
}

function checking(speech: SpeechSetup): SpeechModelInfo["checking"] {
  if (speech.status === "ready") {
    return {
      description:
        "Смотрим, успевает ли компьютер расшифровывать на лету, это до двух минут",
      title: "Проверяем, как компьютер справляется",
    };
  }
  const size = formatBytes(speech.sizeBytes);
  return {
    caption: `${size} из ${size}`,
    description: "Убеждаемся, что файл скачался целиком, это несколько секунд",
    title: "Проверяем модель",
  };
}

function formatSeconds(ms: number) {
  return (ms / MS_PER_SECOND).toFixed(1).replace(".", ",");
}

function checkFailure(
  speech: SpeechSetup
): SpeechModelInfo["checkFailure"] | undefined {
  if (speech.check.status !== "done" || speech.check.result.passed) {
    return;
  }
  const { result } = speech.check;
  const fallbackSize = "около 490 МБ";
  switch (result.reason) {
    case "inaccurate":
      return {
        description: `На проверочных фразах модель ошиблась в ${Math.round(result.wer * PERCENT)}% слов. Скачайте её заново; если не поможет, напишите нам.`,
        redownload: true,
        title: "Распознавание работает неправильно",
      };
    case "modelFailed":
    case "noModel":
      return {
        description:
          "Файл модели не запускается. Скачайте её заново, это пара минут.",
        redownload: true,
        title: "Модель не запустилась",
      };
    default:
      if (speech.model === "turbo") {
        return {
          description: `Фраза расшифровывается за ${formatSeconds(result.p95Ms)} с, а для живой ленты нужно до 3 с. Запасная модель быстрее, ${fallbackSize}, чуть менее точная.`,
          fallback: "Скачать запасную модель",
          title: "Компьютер не успевает за разговором",
        };
      }
      return {
        description:
          "Живая расшифровка будет отставать, полная появится после звонка. Пользоваться можно.",
        title: "Компьютер не успевает за разговором",
      };
  }
}

function micNote(speech: SpeechSetup) {
  const { micCheck } = speech;
  if (micCheck.status === "failed") {
    return micCheck.message;
  }
  if (micCheck.status === "heard" && micCheck.text.trim() === "") {
    return "Ничего не услышали. Проверьте микрофон и скажите ещё раз";
  }
}

function micText(speech: SpeechSetup) {
  return speech.micCheck.status === "heard" ? speech.micCheck.text : "";
}

function readyNote(speech: SpeechSetup) {
  if (speech.check.status === "skipped") {
    return "Проверить скорость не получилось, проверим в настройках";
  }
}

export function speechModelInfo(
  speech: SpeechSetup,
  now: number
): SpeechModelInfo {
  const names = LANGUAGE_NAMES[speech.language] ?? LANGUAGE_NAMES.ru;
  const paused = speech.status === "paused";
  const percent = Math.round(speech.percent);
  const { sizeBytes } = speech;
  const downloadedBytes = (sizeBytes * speech.percent) / PERCENT;
  const downloaded = formatBytes(downloadedBytes);
  const error = speech.error
    ? {
        description:
          speech.error.reason === "checksum"
            ? "Файл скачался с ошибкой, мы его удалили. Скачайте заново."
            : speech.error.message,
        title: "Не получилось скачать модель",
      }
    : undefined;

  return {
    checkFailure: checkFailure(speech),
    checking: checking(speech),
    disk: disk(speech),
    downloaded,
    downloadingTitle: paused
      ? `Модель для ${names.genitive} языка на паузе`
      : `Скачиваем модель для ${names.genitive} языка`,
    error,
    interrupted: { downloaded, percent, retryIn: retryIn(speech, now) },
    languageName: names.name,
    micListening: speech.micCheck.status === "listening",
    micNote: micNote(speech),
    percent,
    readyNote: readyNote(speech),
    size: sizeBytes > 0 ? formatBytes(sizeBytes) : "",
    speed: formatSpeed(speech.bytesPerSec),
    timeLeft: paused
      ? "Докачаем с того же места"
      : timeLeft(sizeBytes - downloadedBytes, speech.bytesPerSec),
    title: `Модель для ${names.genitive} языка`,
    transcript: micText(speech),
  };
}
