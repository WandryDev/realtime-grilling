import type {
  ProjectConnectorView,
  ProjectSource,
  SelectionItemView,
} from "@/bindings";
import type { IntegrationState } from "@/data/integrations";
import { OutlineSourcesBlock } from "@/features/connectors/outline-sources";

/*
 * «Источники Outline» on the project page and in the wizard: every state
 * of the block (connectors-outline task 4.4), at a fixed «now».
 */

const NOW = Date.UTC(2026, 10, 11, 12);
const HOUR_MS = 3_600_000;
const PROJECT = "telemedia";

const CONNECTED: IntegrationState = {
  account: "docs.pixel.agency",
  host: "https://docs.pixel.agency",
  lastOkAt: NOW - HOUR_MS,
  status: "connected",
  team: "Pixel Agency",
};

function item(
  externalId: string,
  title: string,
  extra: Partial<SelectionItemView> = {}
): SelectionItemView {
  return {
    externalId,
    itemKind: "container",
    otherAccount: false,
    status: "ok",
    title,
    url: null,
    ...extra,
  };
}

function source(
  id: string,
  name: string,
  hoursAgo: number,
  status: ProjectSource["status"] = "ready"
): ProjectSource {
  return {
    createdAt: NOW - hoursAgo * HOUR_MS,
    error: status === "ready" ? null : "В документе только заголовок",
    extension: "md",
    id: `${PROJECT}-${id}`,
    name,
    origin: {
      connector: "outline",
      externalId: id,
      updatedAt: NOW - hoursAgo * HOUR_MS,
      url: `https://docs.pixel.agency/doc/${id}`,
    },
    projectId: PROJECT,
    size: 2400,
    status,
    textChars: status === "ready" ? 2400 : 0,
    truncated: false,
  };
}

const DOCUMENTS = [
  source("tm-brief", "Бриф Телемедиа", 2),
  source("tm-api", "API видеосвязи", 26),
  source("tm-contract", "Договор и этапы", 50),
  source("tm-glossary", "Глоссарий", 50, "noText"),
];

function view(extra: Partial<ProjectConnectorView> = {}): ProjectConnectorView {
  return {
    connected: true,
    items: [
      item("col-telemedia", "Телемедиа"),
      item("tm-meetings", "Встречи с клиентом", { itemKind: "exclude" }),
    ],
    kind: "outline",
    projectId: PROJECT,
    sync: {
      error: null,
      errorKind: null,
      lastAttemptAt: NOW - HOUR_MS,
      lastOkAt: NOW - HOUR_MS,
      skipped: 0,
    },
    syncing: false,
    ...extra,
  };
}

const STATES: {
  note: string;
  props: Parameters<typeof OutlineSourcesBlock>[0];
  title: string;
}[] = [
  {
    note: "Outline не подключён: «Подключить Outline» открывает диалог подключения поверх страницы, мастер остаётся на шаге «Источники».",
    props: { connection: { status: "disconnected" }, documents: [] },
    title: "Не подключён",
  },
  {
    note: "Подключён, ничего не выбрано: «Выбрать в Outline» открывает дерево коллекций с поиском и счётчиком.",
    props: { connection: CONNECTED, documents: [] },
    title: "Ничего не выбрано",
  },
  {
    note: "Выбрана коллекция, один документ исключён. У документов ссылка на Outline (открывается в браузере), время текста, «нет текста», крестик исключает документ. «Обновить» ждёт синхронизацию.",
    props: { connection: CONNECTED, documents: DOCUMENTS, view: view() },
    title: "Выбрана коллекция",
  },
  {
    note: "Синхронизация идёт.",
    props: {
      connection: CONNECTED,
      documents: DOCUMENTS,
      syncing: true,
      view: view(),
    },
    title: "Обновляем",
  },
  {
    note: "Ключ отозвали: документы остаются с последним текстом, причина и время последней успешной синхронизации.",
    props: {
      connection: {
        ...CONNECTED,
        error: "Ключ больше не подходит",
        errorKind: "unauthorized",
        status: "error",
      },
      documents: DOCUMENTS,
      view: view({
        sync: {
          error: "Ключ больше не подходит",
          errorKind: "unauthorized",
          lastAttemptAt: NOW,
          lastOkAt: NOW - 26 * HOUR_MS,
          skipped: 0,
        },
      }),
    },
    title: "Не обновлялось: ключ не подходит",
  },
  {
    note: "Outline не ответил: подключение стоит, документы прежние.",
    props: {
      connection: { ...CONNECTED, errorKind: "unreachable" },
      documents: DOCUMENTS,
      view: view({
        sync: {
          error: "Не удалось подключиться к Outline",
          errorKind: "unreachable",
          lastAttemptAt: NOW,
          lastOkAt: NOW - 3 * HOUR_MS,
          skipped: 0,
        },
      }),
    },
    title: "Не обновлялось: Outline не ответил",
  },
  {
    note: "Коллекцию удалили в Outline, другую выбрали в другой команде: «недоступно», подсказка у чужой.",
    props: {
      connection: CONNECTED,
      documents: DOCUMENTS.slice(0, 2),
      view: view({
        items: [
          item("col-telemedia", "Телемедиа"),
          item("col-old", "Старая документация", { status: "unavailable" }),
          item("col-other", "Wandry: архив", {
            otherAccount: true,
            status: "unavailable",
          }),
        ],
      }),
    },
    title: "Недоступно",
  },
  {
    note: "Коллекция разрослась сверх 200 документов: в проекте 200 последних изменённых.",
    props: {
      connection: CONNECTED,
      documents: DOCUMENTS,
      view: view({
        sync: {
          error: null,
          errorKind: null,
          lastAttemptAt: NOW,
          lastOkAt: NOW - HOUR_MS,
          skipped: 30,
        },
      }),
    },
    title: "30 не загружены",
  },
  {
    note: "Outline отключили в настройках: выбор и документы остались, не обновляются.",
    props: {
      connection: { status: "disconnected" },
      documents: DOCUMENTS,
      view: view({
        connected: false,
        sync: {
          error: "Outline отключён",
          errorKind: "disconnected",
          lastAttemptAt: NOW,
          lastOkAt: NOW - 50 * HOUR_MS,
          skipped: 0,
        },
      }),
    },
    title: "Outline отключён",
  },
];

export function OutlineSourcesStates() {
  return (
    <div className="bg-background grid grid-cols-2 gap-x-12 gap-y-10 p-10">
      {STATES.map((state) => (
        <figure className="flex flex-col gap-3" key={state.title}>
          <figcaption className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold">{state.title}</span>
            <span className="text-muted-foreground text-xs">{state.note}</span>
          </figcaption>
          <OutlineSourcesBlock now={NOW} {...state.props} />
        </figure>
      ))}
    </div>
  );
}
