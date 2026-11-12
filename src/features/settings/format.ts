import type { AgentState, DataSummary, RecordingsInfo } from "@/bindings";
import { formatBytes } from "@/features/onboarding/speech-model";
import { clockTime } from "@/lib/clock";
import { plural } from "@/lib/plural";

/*
 * Lines the settings screens build from the backend's numbers: the
 * recordings' folder, the «Удалить всё» summary, the agent's state.
 */

function callsCount(count: number) {
  return `${count} ${plural(count, "звонок", "звонка", "звонков")}`;
}

/** «Аудио звонков. Занято 1,2 ГБ, 38 звонков». */
export function recordingsUsage({ bytes, calls }: RecordingsInfo) {
  if (calls === 0 && bytes === 0) {
    return "Аудио звонков. Пока пусто";
  }
  return `Аудио звонков. Занято ${formatBytes(bytes)}, ${callsCount(calls)}`;
}

/** «4 проекта, 38 звонков, 1,2 ГБ аудио и профили людей…». */
export function dataSummaryText({ bytes, calls, projects }: DataSummary) {
  const projectsCount = `${projects} ${plural(projects, "проект", "проекта", "проектов")}`;
  return `${projectsCount}, ${callsCount(calls)}, ${formatBytes(bytes)} аудио и профили людей. Подключения сервисов тоже сбросятся`;
}

const DAY_AND_MONTH = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
});

/** «12:41» today, «11 ноября, 12:41» on another day. */
export function momentLabel(ms: number, now = Date.now()) {
  const time = clockTime(ms, false);
  if (new Date(ms).toDateString() === new Date(now).toDateString()) {
    return time;
  }
  return `${DAY_AND_MONTH.format(ms)}, ${time}`;
}

/** `max` → «Max». */
export function subscriptionName(subscription: string | null) {
  if (!subscription) {
    return null;
  }
  return `${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}`;
}

/** The status line under «Claude Code»; `null` state: the first check runs. */
export function agentStatusLine(agent: AgentState | null) {
  switch (agent?.status) {
    case undefined:
      return "Проверяем…";
    case "ready":
      return "Найден, вход выполнен, готов к звонку";
    case "needsLogin":
      return "Найден, но вход не выполнен: звонок пройдёт без вопросов";
    case "notInstalled":
      return "Не найден: звонок пройдёт без вопросов";
    default:
      return "Не отвечает: звонок пройдёт без вопросов";
  }
}
