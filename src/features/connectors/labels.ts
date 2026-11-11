import type { ErrorKind, SyncState } from "@/bindings";
import { relativeTime } from "@/features/projects/project-data";
import { plural } from "@/lib/plural";

/*
 * Words of the connector screens: why a sync did not run, when the
 * service last answered, how many documents a pick brings.
 */

/** «Не обновлялось: <reason>». */
const SYNC_REASON: Record<ErrorKind, string> = {
  disconnected: "Outline отключён",
  forbidden: "нет доступа",
  other: "ошибка Outline",
  unauthorized: "ключ не подходит",
  unreachable: "Outline не ответил",
};

/** Why the last sync failed, in a few words; `null` after a success. */
export function syncFailure(sync: SyncState | null): string | null {
  if (!sync?.errorKind) {
    return null;
  }
  if (sync.errorKind === "other" && sync.error) {
    return sync.error;
  }
  return SYNC_REASON[sync.errorKind];
}

/** «обновлено 5 мин назад», «ещё не обновлялось». */
export function updatedLabel(at: number | null | undefined, now?: number) {
  return at ? `обновлено ${relativeTime(at, now)}` : "ещё не обновлялось";
}

/** «1 документ», «12 документов». */
export function documentsCount(count: number) {
  return `${count} ${plural(count, "документ", "документа", "документов")}`;
}

/** «30 не загружены»: documents over the limit the last sync left out. */
export function skippedLabel(count: number) {
  return `${count} ${plural(count, "не загружен", "не загружены", "не загружены")}`;
}
