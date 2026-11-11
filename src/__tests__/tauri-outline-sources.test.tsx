import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Brief, ProjectConnectorView, ProjectSource } from "@/bindings";

/*
 * Outline among a project's sources in the app (connectors-outline tasks
 * 4.3 and 4.4), over the fake IPC (./helpers/fake-tauri.ts): the picker in
 * the wizard and on the project page, «Подключить» from the wizard that
 * keeps its draft, taking a collection off, and every state of the
 * Outline rows.
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

const { connectedOutline, fakeConnector, fakeNode, fakeProject, fakeSource } =
  await import("./helpers/fake-tauri");
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
const GOOD_KEY = "ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2";
const NEXT = /Далее/u;
const LIMIT = /не больше 200/u;
const NOT_UPDATED = /Не обновлялось: ключ не подходит/u;
const SKIPPED = /30 не загружены/u;

const BRIEF: Brief = {
  glossary: [],
  keyDocuments: [],
  modules: [],
  product: "Приём звонков сети клиник",
  stack: [],
};

/** «Телемедиа» with 3 documents (one nested), «Архив» with 340. */
function outlineTree() {
  const telemedia = [
    fakeNode("tm-brief", "Бриф Телемедиа", "document", [
      fakeNode("tm-goals", "Цели запуска"),
    ]),
    fakeNode("tm-contract", "Договор и этапы"),
  ];
  const archive = Array.from({ length: 340 }, (_, index) =>
    fakeNode(`ar-${index}`, `Заметка ${index}`)
  );
  fake.outline.trees = { "col-archive": archive, "col-telemedia": telemedia };
  fake.outline.containers = [
    fakeNode("col-telemedia", "Телемедиа", "container", telemedia),
    fakeNode("col-archive", "Архив", "container", archive),
  ].map((node) => ({ ...node, children: [] }));
}

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function setOutline(view = connectedOutline()) {
  fake.db.connections = [
    view,
    fakeConnector("github"),
    fakeConnector("clickup"),
  ];
}

async function reload() {
  await act(async () => {
    await refreshProjects();
    await refreshSources();
    await refreshIntegrations();
    await refreshConnectorSelections();
  });
}

function outlineBlock() {
  return screen.getByRole("region", { name: "Outline" });
}

function outlineSource(
  id: string,
  name: string,
  status: ProjectSource["status"] = "ready"
): ProjectSource {
  return {
    ...fakeSource(id, PROJECT, name, status),
    error: status === "ready" ? null : "В документе только заголовок",
    extension: "md",
    origin: {
      connector: "outline",
      externalId: id,
      updatedAt: Date.now() - 2 * HOUR_MS,
      url: `https://docs.pixel.agency/doc/${id}`,
    },
  };
}

function telemediaSelection(
  view: Partial<ProjectConnectorView> = {}
): ProjectConnectorView {
  return {
    connected: true,
    items: [
      {
        externalId: "col-telemedia",
        itemKind: "container",
        otherAccount: false,
        status: "ok",
        title: "Телемедиа",
        url: "https://docs.pixel.agency/collection/col-telemedia",
      },
    ],
    kind: "outline",
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
  setOutline();
  outlineTree();
  await reload();
  fake.invoked.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Outline in the wizard (4.3)", () => {
  it("picks a collection on the Sources step («Шаг источников с подключённым Outline»)", async () => {
    await openSourcesStep();

    // Files and Outline; GitHub and ClickUp are «скоро».
    expect(screen.getByRole("button", { name: "Выбрать файлы" })).toBeTruthy();
    const soon = screen.getByRole("list", { name: "Интеграции" });
    expect(within(soon).getAllByText("скоро")).toHaveLength(2);

    fireEvent.click(
      within(outlineBlock()).getByRole("button", { name: "Выбрать в Outline" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Документы из Outline",
    });
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Телемедиа" })
    );
    expect(await within(dialog).findByText("выбрано 3 документа")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Сохранить выбор" })
    );

    // The pick saves the draft: a selection belongs to a project.
    const documents = await screen.findByRole("list", {
      name: "Документы Outline",
    });
    expect(within(documents).getAllByRole("listitem")).toHaveLength(3);
    const [created] = invokedWith("projects_create");
    expect(created).toMatchObject({
      input: { description: "Сеть ветклиник", name: "Лапа" },
    });
    expect(invokedWith("connector_selection_set")).toEqual([
      {
        items: [
          {
            externalId: "col-telemedia",
            itemKind: "container",
            title: "Телемедиа",
            url: "https://docs.pixel.agency/collection/col-telemedia",
          },
        ],
        kind: "outline",
        projectId: fake.db.projects.at(-1)?.id,
      },
    ]);
  });

  it("says about the limit of 200 before saving and saves nothing", async () => {
    await openSourcesStep();
    fireEvent.click(
      within(outlineBlock()).getByRole("button", { name: "Выбрать в Outline" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Документы из Outline",
    });
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Архив" })
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

  it("leaves a document of a picked collection out, its nested one stays", async () => {
    await openSourcesStep();
    fireEvent.click(
      within(outlineBlock()).getByRole("button", { name: "Выбрать в Outline" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Документы из Outline",
    });
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Телемедиа" })
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Открыть Телемедиа" })
    );
    fireEvent.click(
      await within(dialog).findByRole("checkbox", { name: "Бриф Телемедиа" })
    );
    expect(await within(dialog).findByText("выбрано 2 документа")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Сохранить выбор" })
    );

    await waitFor(() => {
      expect(invokedWith("connector_selection_set")).toHaveLength(1);
    });
    const [saved] = invokedWith("connector_selection_set");
    expect(saved?.items).toEqual([
      expect.objectContaining({ externalId: "col-telemedia" }),
      expect.objectContaining({ externalId: "tm-brief", itemKind: "exclude" }),
    ]);
    const documents = await screen.findByRole("list", {
      name: "Документы Outline",
    });
    expect(within(documents).getByText("Договор и этапы")).toBeTruthy();
    expect(within(documents).getByText("Цели запуска")).toBeTruthy();
    expect(within(documents).queryByText("Бриф Телемедиа")).toBeNull();
  });

  it("connects Outline from the wizard and keeps the draft («Подключить Outline из мастера»)", async () => {
    setOutline(fakeConnector("outline"));
    await reload();
    fake.answers.set("plugin:dialog|open", () => ["/Users/dima/ТЗ.docx"]);
    await openSourcesStep();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файлы" }));
    await screen.findByText("ТЗ.docx");

    fireEvent.click(
      within(outlineBlock()).getByRole("button", {
        name: "Подключить Outline",
      })
    );
    const connect = await screen.findByRole("dialog", {
      name: "Подключить Outline",
    });
    fireEvent.change(within(connect).getByLabelText("Адрес Outline"), {
      target: { value: "docs.pixel.agency" },
    });
    fireEvent.change(within(connect).getByLabelText("API-ключ"), {
      target: { value: GOOD_KEY },
    });
    fireEvent.click(
      within(connect).getByRole("button", { name: "Подключить" })
    );

    // Connected: the picker opens over the same step.
    expect(
      await screen.findByRole("dialog", { name: "Документы из Outline" })
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
      within(outlineBlock()).getByRole("button", { name: "Выбрать в Outline" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(
      (await screen.findByLabelText<HTMLInputElement>("Название")).value
    ).toBe("Лапа");
    expect(screen.getByLabelText<HTMLTextAreaElement>("Описание").value).toBe(
      "Сеть ветклиник"
    );
  });
});

describe("Outline on the project page (4.3)", () => {
  it("takes a collection off: its documents go, the brief may be outdated («Снять коллекцию»)", async () => {
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now() - HOUR_MS,
      briefState: "fresh",
    });
    fake.db.selections = [telemediaSelection()];
    fake.db.sources.push(
      outlineSource("tm-brief", "Бриф Телемедиа"),
      outlineSource("tm-contract", "Договор и этапы"),
      fakeSource("019a0000-0000-7000-8000-0000000000d1", PROJECT, "ТЗ.docx")
    );
    await reload();
    openProjectPage();

    const documents = await screen.findByRole("list", {
      name: "Документы Outline",
    });
    expect(within(documents).getAllByRole("listitem")).toHaveLength(2);
    // The file stays with the files.
    expect(
      within(screen.getByRole("list", { name: "Документы проекта" })).getByText(
        "ТЗ.docx"
      )
    ).toBeTruthy();
    expect(screen.queryByText("Бриф мог устареть")).toBeNull();

    fireEvent.click(
      within(outlineBlock()).getByRole("button", {
        name: "Снять выбор Телемедиа",
      })
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("list", { name: "Документы Outline" })
      ).toBeNull();
    });
    expect(invokedWith("connector_selection_set")).toEqual([
      { items: [], kind: "outline", projectId: PROJECT },
    ]);
    expect(await screen.findByText("Бриф мог устареть")).toBeTruthy();
    expect(screen.getByText("ТЗ.docx")).toBeTruthy();
  });

  it("leaves one document of the collection out from its row", async () => {
    fake.db.selections = [telemediaSelection()];
    fake.db.sources.push(
      outlineSource("tm-brief", "Бриф Телемедиа"),
      outlineSource("tm-contract", "Договор и этапы")
    );
    await reload();
    openProjectPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Убрать Договор и этапы из проекта",
      })
    );

    await waitFor(() => {
      expect(invokedWith("connector_selection_set")).toHaveLength(1);
    });
    expect(invokedWith("connector_selection_set")[0]?.items).toEqual([
      expect.objectContaining({ itemKind: "container" }),
      {
        externalId: "tm-contract",
        itemKind: "exclude",
        title: "Договор и этапы",
        url: "https://docs.pixel.agency/doc/tm-contract",
      },
    ]);
  });

  it("two quick crosses both count: the second starts from the first", async () => {
    fake.db.selections = [telemediaSelection()];
    fake.db.sources.push(
      outlineSource("tm-brief", "Бриф Телемедиа"),
      outlineSource("tm-contract", "Договор и этапы")
    );
    await reload();
    openProjectPage();

    const contract = await screen.findByRole("button", {
      name: "Убрать Договор и этапы из проекта",
    });
    const brief = screen.getByRole("button", {
      name: "Убрать Бриф Телемедиа из проекта",
    });
    fireEvent.click(contract);
    fireEvent.click(brief);

    await waitFor(() => {
      expect(invokedWith("connector_selection_set")).toHaveLength(2);
    });
    const last = invokedWith("connector_selection_set")[1]?.items;
    expect(last).toEqual([
      expect.objectContaining({ itemKind: "container" }),
      expect.objectContaining({
        externalId: "tm-contract",
        itemKind: "exclude",
      }),
      expect.objectContaining({ externalId: "tm-brief", itemKind: "exclude" }),
    ]);
  });
});

describe("Outline rows among the sources (4.4)", () => {
  it("shows the service, the link, the update time and «нет текста»", async () => {
    fake.db.selections = [telemediaSelection()];
    fake.db.sources.push(
      outlineSource("tm-brief", "Бриф Телемедиа"),
      outlineSource("tm-glossary", "Глоссарий", "noText")
    );
    await reload();
    openProjectPage();

    const documents = await screen.findByRole("list", {
      name: "Документы Outline",
    });
    const link = within(documents).getByRole("link", {
      name: "Бриф Телемедиа",
    });
    expect(link.getAttribute("href")).toBe(
      "https://docs.pixel.agency/doc/tm-brief"
    );
    expect(within(documents).getAllByText("текст от 2 ч назад")).toHaveLength(
      1
    );
    const glossary = within(documents)
      .getByText("Глоссарий")
      .closest("li") as HTMLElement;
    expect(within(glossary).getByText("нет текста")).toBeTruthy();
    expect(
      within(outlineBlock()).getByText("docs.pixel.agency, обновлено 1 ч назад")
    ).toBeTruthy();

    // The link opens in the browser, not in the app's window.
    fireEvent.click(link);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        "https://docs.pixel.agency/doc/tm-brief"
      );
    });
  });

  it("updates on «Обновить» and waits for the sync", async () => {
    fake.db.selections = [telemediaSelection()];
    await reload();
    openProjectPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Обновить документы Outline" })
    );
    await waitFor(() => {
      expect(invokedWith("connector_sync")).toEqual([
        { kind: "outline", projectId: PROJECT },
      ]);
    });
    // The fake sync brought the collection's documents.
    expect(
      await screen.findByRole("list", { name: "Документы Outline" })
    ).toBeTruthy();
  });

  it("says why it was not updated and since when («Не обновлялось»)", async () => {
    fake.db.selections = [
      telemediaSelection({
        sync: {
          error: "Ключ больше не подходит",
          errorKind: "unauthorized",
          lastAttemptAt: Date.now(),
          lastOkAt: Date.now() - 3 * HOUR_MS,
          skipped: 0,
        },
      }),
    ];
    await reload();
    openProjectPage();

    expect(
      (await within(outlineBlock()).findByRole("status")).textContent
    ).toMatch(NOT_UPDATED);
    expect(within(outlineBlock()).getByRole("status").textContent).toContain(
      "3 ч назад"
    );
  });

  it("marks lost items «недоступно», with a hint for another team", async () => {
    fake.db.selections = [
      telemediaSelection({
        items: [
          {
            externalId: "col-old",
            itemKind: "container",
            otherAccount: false,
            status: "unavailable",
            title: "Старая коллекция",
            url: null,
          },
          {
            externalId: "col-other",
            itemKind: "container",
            otherAccount: true,
            status: "unavailable",
            title: "Чужая коллекция",
            url: null,
          },
        ],
      }),
    ];
    await reload();
    openProjectPage();

    const picked = await screen.findByRole("list", {
      name: "Выбрано в Outline",
    });
    expect(within(picked).getAllByText("недоступно")).toHaveLength(2);
    expect(within(picked).getByText("другая команда")).toBeTruthy();
    expect(
      within(picked).getByText(": выбрано в другой команде Outline")
    ).toBeTruthy();
  });

  it("says how many documents the limit left out («N не загружены»)", async () => {
    fake.db.selections = [
      telemediaSelection({
        sync: {
          error: null,
          errorKind: null,
          lastAttemptAt: Date.now(),
          lastOkAt: Date.now(),
          skipped: 30,
        },
      }),
    ];
    await reload();
    openProjectPage();

    expect(await within(outlineBlock()).findByText(SKIPPED)).toBeTruthy();
  });

  it("keeps the documents of a disconnected Outline and says so", async () => {
    setOutline(fakeConnector("outline"));
    fake.db.selections = [telemediaSelection({ connected: false })];
    fake.db.sources.push(outlineSource("tm-brief", "Бриф Телемедиа"));
    await reload();
    openProjectPage();

    expect(
      (await within(outlineBlock()).findByRole("status")).textContent
    ).toContain("Не обновлялось: Outline отключён");
    expect(
      within(outlineBlock()).getByRole("button", { name: "Подключить Outline" })
    ).toBeTruthy();
    expect(
      within(screen.getByRole("list", { name: "Документы Outline" })).getByText(
        "Бриф Телемедиа"
      )
    ).toBeTruthy();
  });
});
