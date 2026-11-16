import type { ConnectorKind, ErrorKind, SyncState } from "@/bindings";
import { relativeTime } from "@/features/projects/project-data";
import { plural } from "@/lib/plural";

/*
 * Words of the connector screens (connectors-clickup design.md, decision
 * 6): each service that gives a project its sources has its own (Outline:
 * collections and documents, a key; ClickUp: spaces and tasks, a token).
 * Why a sync did not run, when the service last answered, how many
 * documents a pick brings.
 */

/** The connectors that give a project its sources. */
export type SourceConnector = Extract<ConnectorKind, "outline" | "clickup">;

export const SOURCE_CONNECTORS: SourceConnector[] = ["outline", "clickup"];

export function isSourceConnector(kind: string): kind is SourceConnector {
  return kind === "outline" || kind === "clickup";
}

export interface ConnectorWords {
  /** The chip of a picked item, by its kind. */
  readonly chip: Record<"container" | "document" | "exclude", string>;
  /** «Подключить Outline». */
  readonly connect: string;
  /** The list of the project's documents of the service. */
  readonly documents: string;
  /** What it brings, in the plural: «документы», «задачи». */
  readonly items: string;
  /** A picked item of another workspace, in full and on its chip. */
  readonly otherAccount: string;
  readonly otherAccountShort: string;
  /** «Выберите отдельные документы или снимите часть». */
  readonly overLimitHint: string;
  /** «Выбрать в Outline». */
  readonly pick: string;
  /** «Выбрано в Outline». */
  readonly picked: string;
  /** The picker's explanation. */
  readonly pickerDescription: string;
  /** The picker's title. */
  readonly pickerTitle: string;
  /** «выберите коллекции или документы». */
  readonly pickHint: string;
  /** What the block is for, before it is connected. */
  readonly pitch: string;
  /** «Обновить ключ» / «Обновить токен». */
  readonly reconnect: string;
  /** «Обновить документы Outline». */
  readonly refresh: string;
  /** The top level of the picker: «Коллекции Outline». */
  readonly roots: string;
  /** «В Outline нет коллекций». */
  readonly rootsEmpty: string;
  /** «Загружаем коллекции». */
  readonly rootsLoading: string;
  readonly service: string;
  /** Why a picked item is «недоступно». */
  readonly unavailable: string;
  /** Plural forms of what it brings: документ, документа, документов. */
  readonly unit: readonly [string, string, string];
  /** What the limit left out: «документов», «задач». */
  readonly unitMany: string;
}

export const CONNECTOR_WORDS: Record<SourceConnector, ConnectorWords> = {
  clickup: {
    chip: { container: "все задачи", document: "задача", exclude: "без" },
    connect: "Подключить ClickUp",
    documents: "Задачи ClickUp",
    items: "задачи",
    otherAccount: "выбрано в другом пространстве ClickUp",
    otherAccountShort: "другое пространство",
    overLimitHint: "Выберите списки или отдельные задачи или снимите часть.",
    pick: "Выбрать в ClickUp",
    picked: "Выбрано в ClickUp",
    pickerDescription:
      "Пространство, папка или список берутся целиком, с задачами, которые появятся в них позже. Задача берётся с подзадачами. Grill только читает ClickUp.",
    pickerTitle: "Задачи из ClickUp",
    pickHint: "выберите пространства, списки или задачи",
    pitch: "Задачи и комментарии",
    reconnect: "Обновить токен",
    refresh: "Обновить задачи ClickUp",
    roots: "Пространства ClickUp",
    rootsEmpty: "В ClickUp нет пространств",
    rootsLoading: "Загружаем пространства",
    service: "ClickUp",
    unavailable: "удалено в ClickUp или нет доступа",
    unit: ["задача", "задачи", "задач"],
    unitMany: "задач",
  },
  outline: {
    chip: {
      container: "коллекция",
      document: "документ",
      exclude: "без документа",
    },
    connect: "Подключить Outline",
    documents: "Документы Outline",
    items: "документы",
    otherAccount: "выбрано в другой команде Outline",
    otherAccountShort: "другая команда",
    overLimitHint: "Выберите отдельные документы или снимите часть.",
    pick: "Выбрать в Outline",
    picked: "Выбрано в Outline",
    pickerDescription:
      "Коллекция берётся целиком, с документами, которые появятся в ней позже. Документ берётся с вложенными. Grill только читает Outline.",
    pickerTitle: "Документы из Outline",
    pickHint: "выберите коллекции или документы",
    pitch: "Документация из базы знаний",
    reconnect: "Обновить ключ",
    refresh: "Обновить документы Outline",
    roots: "Коллекции Outline",
    rootsEmpty: "В Outline нет коллекций",
    rootsLoading: "Загружаем коллекции",
    service: "Outline",
    unavailable: "удалено в Outline или нет доступа",
    unit: ["документ", "документа", "документов"],
    unitMany: "документов",
  },
};

/** «Не обновлялось: <reason>». */
const SYNC_REASON: Record<SourceConnector, Record<ErrorKind, string>> = {
  clickup: {
    disconnected: "ClickUp отключён",
    forbidden: "нет доступа",
    other: "ошибка ClickUp",
    unauthorized: "токен не подходит",
    unreachable: "ClickUp не ответил",
  },
  outline: {
    disconnected: "Outline отключён",
    forbidden: "нет доступа",
    other: "ошибка Outline",
    unauthorized: "ключ не подходит",
    unreachable: "Outline не ответил",
  },
};

/** Why the last sync failed, in a few words; `null` after a success. */
export function syncFailure(
  sync: SyncState | null,
  kind: SourceConnector = "outline"
): string | null {
  if (!sync?.errorKind) {
    return null;
  }
  if (sync.errorKind === "other" && sync.error) {
    return sync.error;
  }
  return SYNC_REASON[kind][sync.errorKind];
}

/** The reason when the connection itself is off or broken. */
export function connectionFailure(
  status: "disconnected" | "error",
  kind: SourceConnector = "outline"
) {
  return SYNC_REASON[kind][
    status === "disconnected" ? "disconnected" : "unauthorized"
  ];
}

/** «обновлено 5 мин назад», «ещё не обновлялось». */
export function updatedLabel(at: number | null | undefined, now?: number) {
  return at ? `обновлено ${relativeTime(at, now)}` : "ещё не обновлялось";
}

/** «1 документ», «12 документов»; «3 задачи» of ClickUp. */
export function documentsCount(
  count: number,
  kind: SourceConnector = "outline"
) {
  const [one, few, many] = CONNECTOR_WORDS[kind].unit;
  return `${count} ${plural(count, one, few, many)}`;
}

/** «30 не загружены»: documents over the limit the last sync left out. */
export function skippedLabel(count: number) {
  return `${count} ${plural(count, "не загружен", "не загружены", "не загружены")}`;
}
