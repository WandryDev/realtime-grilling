import type { CallRecording } from "@/bindings";

/*
 * The size of a call's audio, as the summary facts and the transcript's
 * recording card say it.
 */

const BYTES_PER_MB = 1_000_000;
/** From here whole megabytes; below, one decimal. */
const ROUND_MB_FROM = 10;
/** Less than this shows «<0,1 МБ» rather than «0,0 МБ». */
const SMALLEST_MB = 0.1;

/** The bytes of both channels of every recording. */
export function audioBytes(recordings: readonly CallRecording[]) {
  return recordings.reduce(
    (sum, item) => sum + (item.meBytes ?? 0) + (item.othersBytes ?? 0),
    0
  );
}

/** «13 МБ», «0,6 МБ», «<0,1 МБ». */
export function recordingSize(bytes: number) {
  const mb = bytes / BYTES_PER_MB;
  if (mb < SMALLEST_MB) {
    return "<0,1 МБ";
  }
  const shown =
    mb >= ROUND_MB_FROM
      ? String(Math.round(mb))
      : mb.toFixed(1).replace(".", ",");
  return `${shown} МБ`;
}
