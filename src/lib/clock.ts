/*
 * Times of day as the screens write them: local wall-clock time, two
 * digits per part.
 */

/** 7 → «07». */
export const pad2 = (value: number) => String(value).padStart(2, "0");

/** «12:02:14», or «12:02» without seconds: the local time of `ms`. */
export function clockTime(ms: number, seconds = true) {
  const date = new Date(ms);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return seconds ? `${time}:${pad2(date.getSeconds())}` : time;
}
