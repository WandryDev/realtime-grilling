import type { LimitHit, LimitWindow } from "@/bindings";

import { clockTime } from "./clock";

/*
 * The words of the thresholds of Grill (agent-limit-guard), the same on
 * every screen: the start widget, the screen without a call, the call
 * window, the overlay, the summary, the brief and Settings → Агент.
 */

const WINDOW_NAMES: Record<LimitWindow, string> = {
  session: "сессия",
  week: "неделя",
};

/** «сессия», «неделя». */
export function windowName(window: LimitWindow) {
  return WINDOW_NAMES[window];
}

/** «сессия 84 % из 90 %». */
export function hitLine(hit: LimitHit) {
  return `${windowName(hit.window)} ${hit.used} % из ${hit.threshold} %`;
}

const DAY_AND_MONTH = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
});

/** «в 14:09» today, «1 декабря в 00:59» on another day; none unknown. */
export function resetMoment(resetsAt: number | null, now = Date.now()) {
  if (resetsAt === null) {
    return null;
  }
  const time = clockTime(resetsAt, false);
  if (new Date(resetsAt).toDateString() === new Date(now).toDateString()) {
    return `в ${time}`;
  }
  return `${DAY_AND_MONTH.format(resetsAt)} в ${time}`;
}

/** «сброс в 14:09»; «время сброса неизвестно» without one. */
export function resetLine(resetsAt: number | null, now = Date.now()) {
  const moment = resetMoment(resetsAt, now);
  return moment ? `сброс ${moment}` : "время сброса неизвестно";
}

/** «Сессия 93 % из 90 %, сброс в 14:09.»: under «… не собран: достигнут лимит Grill». */
export function hitSentence(hit: LimitHit, now = Date.now()) {
  const line = hitLine(hit);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}, ${resetLine(hit.resetsAt, now)}.`;
}

/** «Лимит почти заполнен: сессия 84 % из 90 %». */
export function nearTitle(hit: LimitHit) {
  return `Лимит почти заполнен: ${hitLine(hit)}`;
}

/** «Лимит Grill исчерпан: неделя 81 % из 80 %». */
export function reachedTitle(hit: LimitHit) {
  return `Лимит Grill исчерпан: ${hitLine(hit)}`;
}
