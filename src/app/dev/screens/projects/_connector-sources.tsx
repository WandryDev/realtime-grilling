import type {
  ProjectConnectorView,
  ProjectSource,
  SelectionItemView,
} from "@/bindings";
import type { IntegrationState } from "@/data/integrations";
import { ConnectorSourcesBlock } from "@/features/connectors/connector-sources";

/*
 * The Outline and ClickUp blocks among the sources of the project page and
 * the wizard: every state of each (connectors-outline task 4.4,
 * connectors-clickup task 4.2), at a fixed «now».
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

type BlockProps = Omit<Parameters<typeof ConnectorSourcesBlock>[0], "kind">;

const STATES: {
  note: string;
  props: BlockProps;
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

const CLICKUP_CONNECTED: IntegrationState = {
  account: "Pixel Agency",
  lastOkAt: NOW - HOUR_MS,
  status: "connected",
  team: "Pixel Agency",
  user: "Дима Капиш",
};

function task(
  id: string,
  name: string,
  hoursAgo: number,
  status: ProjectSource["status"] = "ready"
): ProjectSource {
  return {
    ...source(id, name, hoursAgo, status),
    error: status === "ready" ? null : "В задаче только название",
    origin: {
      connector: "clickup",
      externalId: id,
      updatedAt: NOW - hoursAgo * HOUR_MS,
      url: `https://app.clickup.com/t/${id}`,
    },
  };
}

const TASKS = [
  task("tm1-mis", "Интеграция с МИС", 1),
  task("tm1-mis-auth", "Авторизация врачей в МИС", 1),
  task("tm1-video", "Видеозвонок врача и пациента", 5),
  task("tm1-pay", "Оплата консультации", 30),
];

function clickupView(
  extra: Partial<ProjectConnectorView> = {}
): ProjectConnectorView {
  return {
    ...view(),
    items: [
      item("list:ls-tm-1", "Телемедиа, этап 1"),
      item("tm1-reviews", "Отзывы о враче", { itemKind: "exclude" }),
    ],
    kind: "clickup",
    ...extra,
  };
}

const CLICKUP_STATES: {
  note: string;
  props: BlockProps;
  title: string;
}[] = [
  {
    note: "ClickUp не подключён: «Подключить ClickUp» открывает диалог токена поверх страницы, мастер остаётся на шаге «Источники» с прежними данными.",
    props: { connection: { status: "disconnected" }, documents: [] },
    title: "ClickUp не подключён",
  },
  {
    note: "Подключён, ничего не выбрано: «Выбрать в ClickUp» открывает дерево пространств: пространство → папки и списки → задачи с подзадачами.",
    props: { connection: CLICKUP_CONNECTED, documents: [] },
    title: "ClickUp: ничего не выбрано",
  },
  {
    note: "Выбран список, одна задача исключена. У задач ссылка на ClickUp, время текста, крестик исключает задачу.",
    props: {
      connection: CLICKUP_CONNECTED,
      documents: TASKS,
      view: clickupView(),
    },
    title: "ClickUp: выбран список",
  },
  {
    note: "Первая синхронизация большого списка идёт минуты: ClickUp отвечает не больше чем на 100 запросов в минуту, Grill ждёт сброса лимита.",
    props: {
      connection: CLICKUP_CONNECTED,
      documents: TASKS.slice(0, 2),
      view: clickupView({ syncing: true }),
    },
    title: "ClickUp: синхронизация",
  },
  {
    note: "Токен удалили в ClickUp: задачи остаются с последним текстом, «Обновить токен».",
    props: {
      connection: {
        ...CLICKUP_CONNECTED,
        error: "Токен больше не подходит",
        errorKind: "unauthorized",
        status: "error",
      },
      documents: TASKS,
      view: clickupView({
        sync: {
          error: "Токен больше не подходит",
          errorKind: "unauthorized",
          lastAttemptAt: NOW,
          lastOkAt: NOW - 26 * HOUR_MS,
          skipped: 0,
        },
      }),
    },
    title: "ClickUp: токен не подходит",
  },
  {
    note: "Список удалили в ClickUp, другой выбран в прежнем пространстве до переподключения: «недоступно», у второго «другое пространство».",
    props: {
      connection: CLICKUP_CONNECTED,
      documents: TASKS.slice(0, 2),
      view: clickupView({
        items: [
          item("list:ls-tm-1", "Телемедиа, этап 1"),
          item("list:ls-old", "Старый бэклог", { status: "unavailable" }),
          item("list:ls-home", "Дела", {
            otherAccount: true,
            status: "unavailable",
          }),
        ],
      }),
    },
    title: "ClickUp: недоступно",
  },
  {
    note: "Список разросся до 230 открытых задач: в проекте 200 последних изменённых.",
    props: {
      connection: CLICKUP_CONNECTED,
      documents: TASKS,
      view: clickupView({
        sync: {
          error: null,
          errorKind: null,
          lastAttemptAt: NOW,
          lastOkAt: NOW - HOUR_MS,
          skipped: 30,
        },
      }),
    },
    title: "ClickUp: 30 не загружены",
  },
];

function StatesGrid({
  kind,
  states,
}: {
  kind: "outline" | "clickup";
  states: typeof STATES;
}) {
  return (
    <div className="bg-background grid grid-cols-2 gap-x-12 gap-y-10 p-10">
      {states.map((state) => (
        <figure className="flex flex-col gap-3" key={state.title}>
          <figcaption className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold">{state.title}</span>
            <span className="text-muted-foreground text-xs">{state.note}</span>
          </figcaption>
          <ConnectorSourcesBlock kind={kind} now={NOW} {...state.props} />
        </figure>
      ))}
    </div>
  );
}

export function OutlineSourcesStates() {
  return <StatesGrid kind="outline" states={STATES} />;
}

export function ClickUpSourcesStates() {
  return <StatesGrid kind="clickup" states={CLICKUP_STATES} />;
}
