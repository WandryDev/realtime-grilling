import type {
  Account,
  BrowseNode,
  ExternalRef,
  SelectionItem,
  Workspace,
} from "@/bindings";

/*
 * The ClickUp of the browser demo (`Connectors.layerMock`), shaped like
 * Rust's (connectors-clickup design.md, decisions 1 and 2): a personal
 * token opens two workspaces, «Pixel Agency» and «Личное», and one is
 * picked when connecting. Pixel Agency has two spaces: «Клиенты» with the
 * folder «Телемедиа» (two lists) and the list «Ветклиника Лапа» outside
 * any folder, and «Внутреннее» with a backlog of 340 tasks, over the
 * limit of 200 a project can take.
 *
 * Container ids carry their kind as Rust's do (`space:`, `folder:`,
 * `list:`); a task's id is bare. The screens treat them as opaque.
 */

export const MOCK_CLICKUP_USER = "Дима Капиш";

/** The workspace the demo is connected to. */
export const MOCK_CLICKUP_AGENCY: Workspace = {
  id: "9001",
  name: "Pixel Agency",
};

export const MOCK_CLICKUP_WORKSPACES: Workspace[] = [
  MOCK_CLICKUP_AGENCY,
  { id: "9002", name: "Личное" },
];

export function mockClickUpAccount(workspace: Workspace): Account {
  return {
    host: null,
    teamId: workspace.id,
    teamName: workspace.name,
    userName: MOCK_CLICKUP_USER,
  };
}

/** A task with its subtasks. */
export interface MockClickUpTask {
  children: MockClickUpTask[];
  id: string;
  title: string;
  /** Milliseconds; a sync takes a new version when it grows. */
  updatedAt: number;
}

export interface MockClickUpList {
  id: string;
  tasks: MockClickUpTask[];
  title: string;
}

export interface MockClickUpFolder {
  id: string;
  lists: MockClickUpList[];
  title: string;
}

export interface MockClickUpSpace {
  folders: MockClickUpFolder[];
  id: string;
  /** Lists outside any folder. */
  lists: MockClickUpList[];
  title: string;
}

/** The spaces of each workspace, by workspace id. */
export type MockClickUp = Record<string, MockClickUpSpace[]>;

const UPDATED = Date.UTC(2026, 9, 14, 9, 30);

function task(
  id: string,
  title: string,
  children: MockClickUpTask[] = []
): MockClickUpTask {
  return { children, id, title, updatedAt: UPDATED };
}

function tasks(prefix: string, titles: string[]): MockClickUpTask[] {
  return titles.map((title, index) => task(`${prefix}-${index + 1}`, title));
}

const BACKLOG_SIZE = 340;

export function mockClickUp(): MockClickUp {
  return {
    "9001": [
      {
        folders: [
          {
            id: "folder:fd-telemedia",
            lists: [
              {
                id: "list:ls-tm-1",
                tasks: [
                  task("tm1-mis", "Интеграция с МИС", [
                    task("tm1-mis-auth", "Авторизация врачей в МИС"),
                    task("tm1-mis-slots", "Слоты расписания"),
                  ]),
                  ...tasks("tm1", [
                    "Видеозвонок врача и пациента",
                    "Запись консультации",
                    "Оплата консультации",
                    "Уведомления о приёме",
                    "Карточка пациента",
                    "Чат после приёма",
                    "Отзывы о враче",
                    "Админка клиники",
                    "Отчёты для главврача",
                    "Онбординг врача",
                    "Политика хранения записей",
                  ]),
                ],
                title: "Телемедиа, этап 1",
              },
              {
                id: "list:ls-tm-2",
                tasks: tasks("tm2", [
                  "Мобильное приложение пациента",
                  "Рецепты в приложении",
                  "Повторный приём",
                  "Семейный аккаунт",
                  "Интеграция с аптеками",
                ]),
                title: "Телемедиа, этап 2",
              },
            ],
            title: "Телемедиа",
          },
        ],
        id: "space:sp-clients",
        lists: [
          {
            id: "list:ls-lapa",
            tasks: tasks("lapa", [
              "Бот записи к ветеринару",
              "Интеграция с CRM",
              "Прайс-лист на сайте",
              "Напоминания о прививках",
              "Карта клиник",
              "Онлайн-оплата",
            ]),
            title: "Ветклиника Лапа",
          },
        ],
        title: "Клиенты",
      },
      {
        folders: [],
        id: "space:sp-internal",
        lists: [
          {
            id: "list:ls-backlog",
            tasks: Array.from({ length: BACKLOG_SIZE }, (_, index) =>
              task(`backlog-${index + 1}`, `Идея ${index + 1}`)
            ),
            title: "Бэклог",
          },
        ],
        title: "Внутреннее",
      },
    ],
    "9002": [
      {
        folders: [],
        id: "space:sp-home",
        lists: [
          {
            id: "list:ls-home",
            tasks: tasks("home", ["Переезд", "Отпуск", "Курсы английского"]),
            title: "Дела",
          },
        ],
        title: "Дом",
      },
    ],
  };
}

export function mockClickUpUrl(taskId: string) {
  return `https://app.clickup.com/t/${taskId}`;
}

/** A task with all its subtasks. */
export function flattenTasks(list: MockClickUpTask[]): MockClickUpTask[] {
  return list.flatMap((item) => [item, ...flattenTasks(item.children)]);
}

function taskNode(item: MockClickUpTask): BrowseNode {
  const children = item.children.map(taskNode);
  return {
    children,
    documentCount: flattenTasks([item]).length,
    hasChildren: children.length > 0,
    id: item.id,
    kind: "document",
    title: item.title,
    url: mockClickUpUrl(item.id),
  };
}

function listNode(list: MockClickUpList): BrowseNode {
  return {
    children: [],
    documentCount: flattenTasks(list.tasks).length,
    hasChildren: list.tasks.length > 0,
    id: list.id,
    kind: "container",
    title: list.title,
    url: null,
  };
}

function folderNode(folder: MockClickUpFolder): BrowseNode {
  const children = folder.lists.map(listNode);
  return {
    children,
    documentCount: children.reduce((sum, list) => sum + list.documentCount, 0),
    hasChildren: children.length > 0,
    id: folder.id,
    kind: "container",
    title: folder.title,
    url: null,
  };
}

function listsOf(space: MockClickUpSpace) {
  return [...space.folders.flatMap((folder) => folder.lists), ...space.lists];
}

/**
 * `connector_browse` of the demo ClickUp: the spaces (counted only when
 * expanded), a space's folders (with their lists) and folderless lists, a
 * folder's lists, a list's tasks with their subtasks.
 */
export function mockClickUpBrowse(
  spaces: MockClickUpSpace[],
  parent: ExternalRef | null
): BrowseNode[] | undefined {
  if (!parent) {
    return spaces.map((space) => ({
      children: [],
      documentCount: 0,
      hasChildren: true,
      id: space.id,
      kind: "container",
      title: space.title,
      url: null,
    }));
  }
  for (const space of spaces) {
    if (space.id === parent.id) {
      return [...space.folders.map(folderNode), ...space.lists.map(listNode)];
    }
    for (const folder of space.folders) {
      if (folder.id === parent.id) {
        return folder.lists.map(listNode);
      }
    }
    for (const list of listsOf(space)) {
      if (list.id === parent.id) {
        return list.tasks.map(taskNode);
      }
    }
  }
}

/** A task of the demo ClickUp, where it lies. */
interface Located {
  /** The ids of its space, folder and list. */
  containers: string[];
  task: MockClickUpTask;
}

function locate(spaces: MockClickUpSpace[]): Located[] {
  const found: Located[] = [];
  for (const space of spaces) {
    const placed = [
      ...space.folders.flatMap((folder) =>
        folder.lists.map((list) => ({ list, path: [space.id, folder.id] }))
      ),
      ...space.lists.map((list) => ({ list, path: [space.id] })),
    ];
    for (const { list, path } of placed) {
      for (const item of flattenTasks(list.tasks)) {
        found.push({ containers: [...path, list.id], task: item });
      }
    }
  }
  return found;
}

/** The parent of each subtask, by id. */
function parents(spaces: MockClickUpSpace[]) {
  const parent = new Map<string, string>();
  const walk = (list: MockClickUpTask[]) => {
    for (const item of list) {
      for (const child of item.children) {
        parent.set(child.id, item.id);
      }
      walk(item.children);
    }
  };
  for (const space of spaces) {
    for (const list of listsOf(space)) {
      walk(list.tasks);
    }
  }
  return parent;
}

/** What one item of a selection brings; `undefined` when it is gone. */
function bring(
  item: SelectionItem,
  known: {
    byId: Map<string, Located>;
    containerIds: Set<string>;
    excluded: Set<string>;
    located: Located[];
  }
): MockClickUpTask[] | undefined {
  if (item.itemKind === "exclude") {
    return [];
  }
  if (item.itemKind === "document") {
    const entry = known.byId.get(item.externalId);
    return entry ? flattenTasks([entry.task]) : undefined;
  }
  if (!known.containerIds.has(item.externalId)) {
    return;
  }
  return known.located
    .filter(
      (entry) =>
        entry.containers.includes(item.externalId) &&
        !entry.containers.some((id) => known.excluded.has(id))
    )
    .map((entry) => entry.task);
}

/**
 * The tasks a selection brings, as Rust's `resolve` (decision 3): the
 * containers' tasks less the excluded containers, each picked task with
 * its subtasks, the subtasks of an excluded task left out with it. What
 * the selection names but the workspace doesn't have is `missing`.
 */
export function mockClickUpResolve(
  spaces: MockClickUpSpace[],
  items: SelectionItem[]
): { missing: Set<string>; tasks: MockClickUpTask[] } {
  const located = locate(spaces);
  const byId = new Map(located.map((entry) => [entry.task.id, entry]));
  const containerIds = new Set(
    spaces.flatMap((space) => [
      space.id,
      ...space.folders.map((folder) => folder.id),
      ...listsOf(space).map((list) => list.id),
    ])
  );
  const excluded = new Set(
    items
      .filter((item) => item.itemKind === "exclude")
      .map((item) => item.externalId)
  );
  const picked = new Set(
    items
      .filter((item) => item.itemKind === "document")
      .map((item) => item.externalId)
  );
  const missing = new Set<string>();
  const found = new Map<string, MockClickUpTask>();
  for (const item of items) {
    const brought = bring(item, { byId, containerIds, excluded, located });
    if (!brought) {
      missing.add(item.externalId);
    }
    for (const nested of brought ?? []) {
      found.set(nested.id, nested);
    }
  }
  // The subtasks of an excluded task go with it, at any depth.
  const parent = parents(spaces);
  const leftOut = (id: string): boolean => {
    if (picked.has(id)) {
      return false;
    }
    if (excluded.has(id)) {
      return true;
    }
    const up = parent.get(id);
    return up !== undefined && leftOut(up);
  };
  return {
    missing,
    tasks: [...found.values()].filter((item) => !leftOut(item.id)),
  };
}
