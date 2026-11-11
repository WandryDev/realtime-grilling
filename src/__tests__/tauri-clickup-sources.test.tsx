import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BrowseNode,
  ConnectorView,
  ProjectConnectorView,
  ProjectSource,
} from "@/bindings";

/*
 * ClickUp among a project's sources in the app (connectors-clickup tasks
 * 4.1 and 4.2), over the fake IPC (./helpers/fake-tauri.ts): the picker's
 * nested containers loaded on demand (space → folder → list → tasks),
 * leaving a list of a picked space out, the limit of 200 by the counter
 * and by the backend's refusal, then the ClickUp block next to the files
 * and Outline, «Подключить» from the wizard and a revoked token.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const opener = vi.hoisted(() => ({
  openUrl: vi.fn((_url: string) => Promise.resolve()),
}));

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: fake.listen }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => Promise.resolve(() => undefined),
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => opener);
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: nav.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => nav.search,
}));

const {
  connectedClickUp,
  connectedOutline,
  fakeConnector,
  fakeNode,
  fakeProject,
  fakeSource,
} = await import("./helpers/fake-tauri");
const { ProjectPage } = await import("@/features/projects/pages/project-page");
const { NewProjectPage } = await import(
  "@/features/projects/pages/new-project-page"
);
const { refreshProjects } = await import("@/data/projects");
const { refreshSources } = await import("@/data/sources");
const { refreshIntegrations } = await import("@/data/integrations");
const { refreshConnectorSelections } = await import(
  "@/data/connector-selections"
);

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const HOUR_MS = 3_600_000;
const TOKEN = "pk_4815162_Q7Z2LM8NX4WD9KTR3HB6YC1P";
const NEXT = /Далее/u;
const LIMIT = /не больше 200 задач/u;
const NOT_UPDATED = /Не обновлялось: токен не подходит/u;
const SKIPPED = /30 не загружены/u;

function task(id: string, title: string, children: BrowseNode[] = []) {
  return { ...fakeNode(id, title, "document", children), url: taskUrl(id) };
}

function taskUrl(id: string) {
  return `https://app.clickup.com/t/${id}`;
}

function container(id: string, title: string, children: BrowseNode[] = []) {
  return { ...fakeNode(id, title, "container", children), url: null };
}

/** A list as Rust gives it: counted, its tasks loaded when expanded. */
function list(id: string, title: string, count: number) {
  return {
    ...container(id, title),
    documentCount: count,
    hasChildren: count > 0,
  };
}

/*
 * «Клиенты»: the folder «Телемедиа» with «Телемедиа, этап 1» (3 tasks,
 * one with two subtasks: 5) and «Телемедиа, этап 2» (2), and the list
 * «Ветклиника Лапа» (1) outside a folder. «Внутреннее»: «Бэклог» of 340.
 * «Архив»: «Старое» counted 150 by ClickUp, 230 open tasks in fact.
 */
function clickupTree() {
  const stage1 = [
    task("mis", "Интеграция с МИС", [
      task("mis-auth", "Авторизация врачей"),
      task("mis-slots", "Слоты расписания"),
    ]),
    task("video", "Видеозвонок"),
    task("pay", "Оплата консультации"),
  ];
  const stage2 = [task("app", "Приложение пациента"), task("drugs", "Аптеки")];
  const lapa = [task("bot", "Бот записи")];
  const backlog = Array.from({ length: 340 }, (_, index) =>
    task(`idea-${index}`, `Идея ${index}`)
  );
  const old = Array.from({ length: 230 }, (_, index) =>
    task(`old-${index}`, `Старая ${index}`)
  );
  const folder = {
    ...container("folder:tm", "Телемедиа", [
      list("list:tm-1", "Телемедиа, этап 1", 5),
      list("list:tm-2", "Телемедиа, этап 2", 2),
    ]),
  };
  fake.clickup.containers = [
    container("space:clients", "Клиенты"),
    container("space:internal", "Внутреннее"),
    container("space:archive", "Архив"),
  ].map((node) => ({ ...node, documentCount: 0, hasChildren: true }));
  fake.clickup.trees = {
    "list:backlog": backlog,
    "list:lapa": lapa,
    "list:old": old,
    "list:tm-1": stage1,
    "list:tm-2": stage2,
    "space:archive": [list("list:old", "Старое", 150)],
    "space:clients": [folder, list("list:lapa", "Ветклиника Лапа", 1)],
    "space:internal": [list("list:backlog", "Бэклог", 340)],
  };
}

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function browsedParents() {
  return invokedWith("connector_browse")
    .filter((args) => args?.kind === "clickup")
    .map((args) => (args?.parent as { id: string } | null)?.id ?? null);
}

function setConnections(clickup: ConnectorView = connectedClickUp()) {
  fake.db.connections = [connectedOutline(), fakeConnector("github"), clickup];
}

async function reload() {
  await act(async () => {
    await refreshProjects();
    await refreshSources();
    await refreshIntegrations();
    await refreshConnectorSelections();
  });
}

function clickupBlock() {
  return screen.getByRole("region", { name: "ClickUp" });
}

function clickupSource(id: string, name: string): ProjectSource {
  return {
    ...fakeSource(id, PROJECT, name),
    extension: "md",
    id: `source-${id}`,
    origin: {
      connector: "clickup",
      externalId: id,
      updatedAt: Date.now() - 2 * HOUR_MS,
      url: taskUrl(id),
    },
  };
}

function outlineSource(id: string, name: string): ProjectSource {
  return {
    ...fakeSource(id, PROJECT, name),
    extension: "md",
    id: `source-${id}`,
    origin: {
      connector: "outline",
      externalId: id,
      updatedAt: Date.now() - 2 * HOUR_MS,
      url: `https://docs.pixel.agency/doc/${id}`,
    },
  };
}

function selection(
  kind: ProjectConnectorView["kind"],
  items: { externalId: string; title: string; otherAccount?: boolean }[],
  view: Partial<ProjectConnectorView> = {}
): ProjectConnectorView {
  return {
    connected: true,
    items: items.map((item) => ({
      externalId: item.externalId,
      itemKind: "container",
      otherAccount: item.otherAccount ?? false,
      status: item.otherAccount ? "unavailable" : "ok",
      title: item.title,
      url: null,
    })),
    kind,
    projectId: PROJECT,
    sync: {
      error: null,
      errorKind: null,
      lastAttemptAt: Date.now() - HOUR_MS,
      lastOkAt: Date.now() - HOUR_MS,
      skipped: 0,
    },
    syncing: false,
    ...view,
  };
}

/** The wizard on step 2 with a name and a description. */
async function openSourcesStep() {
  nav.search = new URLSearchParams();
  render(<NewProjectPage />);
  fireEvent.change(await screen.findByLabelText("Название"), {
    target: { value: "Лапа" },
  });
  fireEvent.change(screen.getByLabelText("Описание"), {
    target: { value: "Сеть ветклиник" },
  });
  fireEvent.click(screen.getByRole("button", { name: NEXT }));
  await screen.findByRole("heading", { name: "Откуда брать контекст" });
}

async function openPicker() {
  await openSourcesStep();
  fireEvent.click(
    within(clickupBlock()).getByRole("button", { name: "Выбрать в ClickUp" })
  );
  return screen.findByRole("dialog", { name: "Задачи из ClickUp" });
}

function openProjectPage() {
  nav.search = new URLSearchParams(`id=${PROJECT}`);
  return render(<ProjectPage />);
}

beforeEach(async () => {
  nav.push.mockReset();
  fake.answers.clear();
  fake.failures.clear();
  opener.openUrl.mockClear();
  fake.db.projects.splice(0, fake.db.projects.length, {
    ...fakeProject(PROJECT, "Телемедиа"),
  });
  fake.db.people.length = 0;
  fake.db.sources.length = 0;
  fake.db.selections = [];
  fake.clickup.workspaces = [{ id: "9001", name: "Pixel Agency" }];
  fake.outline.containers = [];
  fake.outline.trees = {};
  setConnections();
  clickupTree();
  await reload();
  fake.invoked.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ClickUp picker (4.1)", () => {
  it("opens a space, its folder and a list, and picks a task with its subtasks", async () => {
    const dialog = await openPicker();

    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Открыть Клиенты" })
    );
    // The folder came with its lists: opening it asks nothing.
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Открыть Телемедиа" })
    );
    expect(within(dialog).getByText("Телемедиа, этап 2")).toBeTruthy();
    expect(within(dialog).getByText("Ветклиника Лапа")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "Открыть Телемедиа, этап 1",
      })
    );
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Интеграция с МИС" })
    );
    expect(
      within(dialog)
        .getByRole("checkbox", { name: "Слоты расписания" })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(within(dialog).getByText("выбрано 3 задачи")).toBeTruthy();
    expect(browsedParents()).toEqual([null, "space:clients", "list:tm-1"]);

    // Collapsed and opened again: nothing is asked twice.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Свернуть Клиенты" })
    );
    await waitFor(() => {
      expect(within(dialog).queryByText("Ветклиника Лапа")).toBeNull();
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Открыть Клиенты" })
    );
    expect(await within(dialog).findByText("Ветклиника Лапа")).toBeTruthy();
    expect(browsedParents()).toEqual([null, "space:clients", "list:tm-1"]);

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Сохранить выбор" })
    );
    const tasks = await screen.findByRole("list", { name: "Задачи ClickUp" });
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(tasks)
        .getByRole("link", { name: "Интеграция с МИС" })
        .getAttribute("href")
    ).toBe(taskUrl("mis"));
    expect(invokedWith("connector_selection_set")).toEqual([
      expect.objectContaining({
        items: [
          {
            externalId: "mis",
            itemKind: "document",
            title: "Интеграция с МИС",
            url: taskUrl("mis"),
          },
        ],
        kind: "clickup",
      }),
    ]);
  });

  it("leaves a list of a picked space out", async () => {
    const dialog = await openPicker();

    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Клиенты" })
    );
    // The space is counted once its folders and lists came.
    expect(await within(dialog).findByText("выбрано 8 задач")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Открыть Клиенты" })
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Открыть Телемедиа" })
    );
    const stage2 = within(dialog).getByRole("checkbox", {
      name: "Телемедиа, этап 2",
    });
    expect(stage2.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(stage2);
    expect(await within(dialog).findByText("выбрано 6 задач")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Сохранить выбор" })
    );

    await waitFor(() => {
      expect(invokedWith("connector_selection_set")).toHaveLength(1);
    });
    expect(invokedWith("connector_selection_set")[0]?.items).toEqual([
      expect.objectContaining({
        externalId: "space:clients",
        itemKind: "container",
      }),
      expect.objectContaining({ externalId: "list:tm-2", itemKind: "exclude" }),
    ]);
    const tasks = await screen.findByRole("list", { name: "Задачи ClickUp" });
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(6);
    expect(within(tasks).queryByText("Аптеки")).toBeNull();
  });

  it("says about the limit of 200 and saves nothing («Слишком большое пространство»)", async () => {
    const dialog = await openPicker();

    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Внутреннее" })
    );

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      LIMIT
    );
    expect(
      within(dialog)
        .getByRole("button", { name: "Сохранить выбор" })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(invokedWith("connector_selection_set")).toEqual([]);
  });

  it("shows the backend's refusal as the limit and stays open", async () => {
    const dialog = await openPicker();

    // ClickUp counts 150 in the list, the backend finds 230 open tasks.
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Открыть Архив" })
    );
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Старое" })
    );
    expect(within(dialog).getByText("выбрано 150 задач")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Сохранить выбор" })
    );

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toMatch(LIMIT);
    expect(alert.textContent).toContain("230");
    expect(screen.getByRole("dialog", { name: "Задачи из ClickUp" })).toBe(
      dialog
    );
    expect(fake.db.selections).toEqual([]);
  });

  it("says a space did not load and retries it", async () => {
    const dialog = await openPicker();
    const open = await within(dialog).findByRole("button", {
      name: "Открыть Клиенты",
    });
    fake.failures.set("connector_browse", {
      kind: "External",
      message: "ClickUp не ответил",
    });
    fireEvent.click(open);

    expect(await within(dialog).findByText("ClickUp не ответил")).toBeTruthy();
    fake.failures.delete("connector_browse");
    fireEvent.click(within(dialog).getByRole("button", { name: "Повторить" }));
    expect(await within(dialog).findByText("Ветклиника Лапа")).toBeTruthy();
  });
});

describe("ClickUp among the sources (4.2)", () => {
  it("draws the file, the Outline block and the ClickUp block («Файлы, Outline и ClickUp»)", async () => {
    fake.db.selections = [
      selection("outline", [{ externalId: "col-tm", title: "Телемедиа" }]),
      selection("clickup", [
        { externalId: "list:tm-1", title: "Телемедиа, этап 1" },
      ]),
    ];
    fake.db.sources.push(
      fakeSource("019a0000-0000-7000-8000-0000000000d1", PROJECT, "ТЗ.docx"),
      outlineSource("tm-brief", "Бриф Телемедиа"),
      clickupSource("mis", "Интеграция с МИС"),
      clickupSource("video", "Видеозвонок")
    );
    await reload();
    openProjectPage();

    const tasks = await screen.findByRole("list", { name: "Задачи ClickUp" });
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(tasks)
        .getByRole("link", { name: "Видеозвонок" })
        .getAttribute("href")
    ).toBe(taskUrl("video"));
    expect(
      within(screen.getByRole("list", { name: "Документы Outline" })).getByText(
        "Бриф Телемедиа"
      )
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Документы проекта" })).getByText(
        "ТЗ.docx"
      )
    ).toBeTruthy();
    expect(
      within(clickupBlock()).getByText("Pixel Agency, обновлено 1 ч назад")
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Выбрано в ClickUp" })).getByText(
        "Телемедиа, этап 1"
      )
    ).toBeTruthy();
    // GitHub is the only «скоро».
    expect(
      within(screen.getByRole("list", { name: "Интеграции" })).getAllByText(
        "скоро"
      )
    ).toHaveLength(1);
  });

  it("connects ClickUp from the wizard and keeps the draft («Подключить ClickUp из мастера»)", async () => {
    setConnections(fakeConnector("clickup"));
    await reload();
    fake.answers.set("plugin:dialog|open", () => ["/Users/dima/ТЗ.docx"]);
    await openSourcesStep();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файлы" }));
    await screen.findByText("ТЗ.docx");

    fireEvent.click(
      within(clickupBlock()).getByRole("button", {
        name: "Подключить ClickUp",
      })
    );
    const connect = await screen.findByRole("dialog", {
      name: "Подключить ClickUp",
    });
    fireEvent.change(within(connect).getByLabelText("Токен ClickUp"), {
      target: { value: TOKEN },
    });
    fireEvent.click(
      within(connect).getByRole("button", { name: "Подключить" })
    );

    // Connected: the picker opens over the same step.
    expect(
      await screen.findByRole("dialog", { name: "Задачи из ClickUp" })
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(
      screen.getByRole("heading", { name: "Откуда брать контекст" })
    ).toBeTruthy();
    expect(screen.getByText("ТЗ.docx")).toBeTruthy();
    expect(
      within(clickupBlock()).getByRole("button", { name: "Выбрать в ClickUp" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(
      (await screen.findByLabelText<HTMLInputElement>("Название")).value
    ).toBe("Лапа");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Описание").value).toBe(
      "Сеть ветклиник"
    );
  });

  it("keeps the tasks of a revoked token and asks for a new one («Токен отозвали»)", async () => {
    setConnections({
      ...connectedClickUp(Date.now() - 3 * HOUR_MS),
      error: "Токен больше не подходит",
      errorKind: "unauthorized",
      status: "error",
    });
    fake.db.selections = [
      selection("clickup", [
        { externalId: "list:tm-1", title: "Телемедиа, этап 1" },
      ]),
    ];
    fake.db.sources.push(clickupSource("mis", "Интеграция с МИС"));
    await reload();
    openProjectPage();

    // «Обновить» is gone with the token: the block asks for a new one.
    const status = await within(clickupBlock()).findByRole("status");
    expect(status.textContent).toMatch(NOT_UPDATED);
    expect(status.textContent).toContain("задачи с текстом от 1 ч назад");
    expect(
      within(screen.getByRole("list", { name: "Задачи ClickUp" })).getByText(
        "Интеграция с МИС"
      )
    ).toBeTruthy();
    fireEvent.click(
      within(clickupBlock()).getByRole("button", { name: "Обновить токен" })
    );
    expect(
      await screen.findByRole("dialog", { name: "Новый токен ClickUp" })
    ).toBeTruthy();
  });

  it("marks items of another workspace and says a sync runs", async () => {
    fake.db.selections = [
      selection(
        "clickup",
        [
          { externalId: "list:tm-1", title: "Телемедиа, этап 1" },
          { externalId: "list:home", otherAccount: true, title: "Дела" },
        ],
        {
          sync: {
            error: null,
            errorKind: null,
            lastAttemptAt: Date.now(),
            lastOkAt: Date.now(),
            skipped: 30,
          },
          syncing: true,
        }
      ),
    ];
    await reload();
    openProjectPage();

    const picked = await screen.findByRole("list", {
      name: "Выбрано в ClickUp",
    });
    expect(within(picked).getByText("недоступно")).toBeTruthy();
    expect(within(picked).getByText("другое пространство")).toBeTruthy();
    expect(
      within(picked).getByText(": выбрано в другом пространстве ClickUp")
    ).toBeTruthy();
    expect(within(clickupBlock()).getByText("Синхронизация…")).toBeTruthy();
    expect(within(clickupBlock()).getByText(SKIPPED)).toBeTruthy();
  });

  it("updates on «Обновить» through the ClickUp sync", async () => {
    fake.db.selections = [
      selection("clickup", [
        { externalId: "list:tm-1", title: "Телемедиа, этап 1" },
      ]),
    ];
    await reload();
    openProjectPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Обновить задачи ClickUp" })
    );
    await waitFor(() => {
      expect(invokedWith("connector_sync")).toEqual([
        { kind: "clickup", projectId: PROJECT },
      ]);
    });
    const tasks = await screen.findByRole("list", { name: "Задачи ClickUp" });
    expect(within(tasks).getAllByRole("listitem")).toHaveLength(5);
  });
});
