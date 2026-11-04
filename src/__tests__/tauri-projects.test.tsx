import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Brief, BriefProgress, SourceAddResult } from "@/bindings";

/*
 * The project page and the new project wizard in Tauri mode, over the fake
 * IPC (./helpers/fake-tauri.ts): the brief comes from the database with its
 * state, the stages of a build come as `BriefProgress`, documents are
 * picked in the dialog plugin or dropped on the window.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const drops = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: unknown }) => void),
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
    onDragDropEvent: (handler: (event: { payload: unknown }) => void) => {
      drops.handler = handler;
      return Promise.resolve(() => {
        drops.handler = null;
      });
    },
  }),
}));
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

const { fakeProject, fakeSource } = await import("./helpers/fake-tauri");
const { ProjectPage } = await import("@/features/projects/pages/project-page");
const { NewProjectPage } = await import(
  "@/features/projects/pages/new-project-page"
);
const { refreshProjects } = await import("@/data/projects");
const { refreshPeople } = await import("@/data/people");
const { refreshSources } = await import("@/data/sources");
const { toast } = await import("@/components/ui/toast");

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const SOURCE = "019a0000-0000-7000-8000-0000000000d1";
const HOUR_MS = 3_600_000;
const OLGA = /Ольга Николаевна/u;
const KEY_DOCUMENT = /Техническое задание/u;
const NEXT = /Далее/u;

const BRIEF: Brief = {
  glossary: [{ definition: "Пациент без карты", term: "Первичка" }],
  keyDocuments: [
    { sourceId: SOURCE, title: "Техническое задание", why: "Этапы и сроки" },
  ],
  modules: [{ description: "Очередь и перезвоны", name: "Операторы" }],
  product: "Приём звонков сети клиник",
  stack: ["NestJS", "amoCRM API v4"],
};

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function progress(stage: number, state: BriefProgress["state"]) {
  act(() => fake.emit("brief-progress", { projectId: PROJECT, stage, state }));
}

/** The stores outlive a test: read the reset tables. */
async function reload() {
  await act(async () => {
    await refreshProjects();
    await refreshPeople();
    await refreshSources();
  });
}

function openProjectPage() {
  nav.search = new URLSearchParams(`id=${PROJECT}`);
  return render(<ProjectPage />);
}

beforeEach(async () => {
  nav.push.mockReset();
  nav.search = new URLSearchParams();
  fake.answers.clear();
  fake.failures.clear();
  fake.db.projects.splice(0, fake.db.projects.length, {
    ...fakeProject(PROJECT, "Телемедиа"),
    description: "Сеть клиник",
  });
  fake.db.people.length = 0;
  fake.db.sources.length = 0;
  fake.db.calls.length = 0;
  await reload();
  fake.invoked.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("project page: the brief", () => {
  it("offers «Собрать бриф» without a brief and follows the build", async () => {
    openProjectPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Собрать бриф" })
    );

    await waitFor(() =>
      expect(invokedWith("brief_build")).toEqual([{ projectId: PROJECT }])
    );
    progress(1, { status: "running" });
    progress(2, { status: "running" });
    expect(await screen.findByText("Собираю бриф: этап 2 из 5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
    await waitFor(() =>
      expect(invokedWith("brief_cancel")).toEqual([{ projectId: PROJECT }])
    );
  });

  it("shows a fresh brief with its build time and its key documents", async () => {
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now() - 2 * HOUR_MS,
      briefState: "fresh",
    });
    fake.db.sources.push(fakeSource(SOURCE, PROJECT, "ТЗ.docx"));
    await reload();
    openProjectPage();

    expect(await screen.findByText("Приём звонков сети клиник")).toBeTruthy();
    expect(screen.getByText("Обновлён 2 ч назад")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Обновить" })).toBeTruthy();
    expect(screen.getByText("Первичка")).toBeTruthy();
    expect(screen.queryByText("Бриф мог устареть")).toBeNull();
    // The key document leads to its file in "Источники".
    const link = screen.getByRole("link", { name: KEY_DOCUMENT });
    expect(link.getAttribute("href")).toBe(`#source-${SOURCE}`);
    expect(within(link).getByText("ТЗ.docx")).toBeTruthy();
    expect(document.querySelector(`#source-${SOURCE}`)).not.toBeNull();
  });

  it("says the brief may be outdated and offers to refresh it", async () => {
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now() - HOUR_MS,
      briefState: "outdated",
    });
    await reload();
    openProjectPage();

    expect(await screen.findByText("Бриф мог устареть")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Обновить бриф" }));
    await waitFor(() =>
      expect(invokedWith("brief_build")).toEqual([{ projectId: PROJECT }])
    );
  });

  it("shows the build another window started, and stops it", async () => {
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now() - HOUR_MS,
      briefState: "building",
    });
    await reload();
    openProjectPage();

    expect(
      await screen.findByRole("progressbar", { name: "Обновление брифа" })
    ).toBeTruthy();
    progress(4, { status: "running" });
    expect(await screen.findByText("Собираю бриф: этап 4 из 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
    await waitFor(() =>
      expect(invokedWith("brief_cancel")).toEqual([{ projectId: PROJECT }])
    );
  });

  it("marks a brief built from shortened materials", async () => {
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now(),
      briefState: "fresh",
      briefTruncated: true,
    });
    await reload();
    openProjectPage();

    expect(
      await screen.findByText("Собран по сокращённым материалам", {
        exact: false,
      })
    ).toBeTruthy();
    expect(screen.getByText("Обновлён только что")).toBeTruthy();
  });

  it("exports the brief into the folder picked in Finder", async () => {
    const user = userEvent.setup();
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now(),
      briefState: "fresh",
    });
    fake.answers.set("plugin:dialog|open", () => "/Users/dima/Документы");
    await reload();
    openProjectPage();

    await user.click(await screen.findByRole("button", { name: "Ещё" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Экспорт брифа" })
    );
    await waitFor(() =>
      expect(invokedWith("brief_export")).toEqual([
        { folder: "/Users/dima/Документы", projectId: PROJECT },
      ])
    );
  });
});

describe("project page: what is not the brief", () => {
  it("has no demo calls or proposals", async () => {
    openProjectPage();

    expect(
      within(await screen.findByRole("region", { name: "Звонки" })).getByText(
        "пока пусто"
      )
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Разобрать" })).toBeNull();
    // Integrations come later: drawn, nothing to pick.
    const integrations = screen.getByRole("list", { name: "Интеграции" });
    expect(within(integrations).getAllByText("скоро")).toHaveLength(3);
  });

  it("adds documents from the dialog and a drop, and removes them", async () => {
    fake.answers.set("plugin:dialog|open", () => [
      "/Users/dima/ТЗ.docx",
      "/Users/dima/смета.xlsx",
    ]);
    fake.answers.set("project_sources_add", (args) => {
      const results: SourceAddResult[] = [];
      for (const path of args.paths as string[]) {
        const name = path.split("/").at(-1) ?? path;
        if (name.endsWith(".xlsx")) {
          results.push({
            name,
            path,
            result: {
              message: "Поддерживаются .md, .txt, .pdf и .docx",
              outcome: "rejected",
              reason: "unsupportedType",
            },
          });
          continue;
        }
        const source = fakeSource(`doc-${name}`, PROJECT, name);
        fake.db.sources.push(source);
        results.push({ name, path, result: { outcome: "added", source } });
      }
      fake.dataChanged({
        change: "updated",
        entity: "project",
        id: PROJECT,
        projectId: PROJECT,
      });
      return results;
    });
    openProjectPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "Выбрать файлы" })
    );
    const list = await screen.findByRole("list", { name: "Документы проекта" });
    expect(within(list).getByText("ТЗ.docx")).toBeTruthy();
    expect(within(list).getByText("прочитан")).toBeTruthy();
    expect(
      screen.getByText(": Поддерживаются .md, .txt, .pdf и .docx", {
        exact: false,
      })
    ).toBeTruthy();
    expect(invokedWith("project_sources_add")).toEqual([
      {
        paths: ["/Users/dima/ТЗ.docx", "/Users/dima/смета.xlsx"],
        projectId: PROJECT,
      },
    ]);

    // A file dropped on the window.
    await waitFor(() => expect(drops.handler).not.toBeNull());
    act(() =>
      drops.handler?.({
        payload: { paths: ["/Users/dima/переписка.pdf"], type: "drop" },
      })
    );
    expect(await within(list).findByText("переписка.pdf")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Удалить ТЗ.docx" }));
    await waitFor(() =>
      expect(invokedWith("project_sources_remove")).toEqual([
        { id: "doc-ТЗ.docx" },
      ])
    );
    await waitFor(() => expect(within(list).queryByText("ТЗ.docx")).toBeNull());
  });

  it("saves the manager's notes", async () => {
    openProjectPage();

    fireEvent.change(await screen.findByLabelText("Заметки менеджера"), {
      target: { value: "Решения по amoCRM принимает Игорь" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить заметки" }));

    await waitFor(() =>
      expect(invokedWith("projects_update")).toEqual([
        {
          id: PROJECT,
          patch: { notes: "Решения по amoCRM принимает Игорь" },
        },
      ])
    );
  });

  it("adds, edits and removes a person of the client", async () => {
    const user = userEvent.setup();
    openProjectPage();

    fireEvent.click(await screen.findByRole("button", { name: "Добавить" }));
    let dialog = await screen.findByRole("dialog", { name: "Новый человек" });
    fireEvent.change(within(dialog).getByLabelText("Имя"), {
      target: { value: "Ольга Николаевна" },
    });
    fireEvent.change(within(dialog).getByLabelText("Роль"), {
      target: { value: "операционный директор" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));

    await waitFor(() =>
      expect(invokedWith("people_create")).toEqual([
        {
          input: {
            name: "Ольга Николаевна",
            profile: { initials: "ОН" },
            projectId: PROJECT,
            role: "операционный директор",
          },
        },
      ])
    );
    // No levels given: "не указано".
    const card = await screen.findByRole("link", { name: OLGA });
    expect(within(card).getAllByText("В технике: не указано")).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: "Действия: Ольга Николаевна" })
    );
    await user.click(await screen.findByRole("menuitem", { name: "Изменить" }));
    dialog = await screen.findByRole("dialog", { name: "Изменить человека" });
    fireEvent.change(within(dialog).getByLabelText("В технике"), {
      target: { value: "5" },
    });
    fireEvent.change(within(dialog).getByLabelText("Характер"), {
      target: { value: "Ценит цифры" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(invokedWith("people_update").at(-1)).toEqual({
        id: fake.db.people[0]?.id,
        patch: {
          name: "Ольга Николаевна",
          profile: expect.objectContaining({
            initials: "ОН",
            portrait: { Характер: "Ценит цифры" },
            tech: 5,
          }),
          role: "операционный директор",
        },
      })
    );

    await user.click(
      screen.getByRole("button", { name: "Действия: Ольга Николаевна" })
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Убрать из проекта" })
    );
    const confirm = await screen.findByRole("alertdialog", {
      name: "Убрать Ольга Николаевна из проекта?",
    });
    fireEvent.click(within(confirm).getByRole("button", { name: "Убрать" }));
    await waitFor(() => expect(invokedWith("people_delete")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: OLGA })).toBeNull()
    );
  });
});

describe("new project wizard", () => {
  function fillWizard() {
    render(<NewProjectPage />);
    fireEvent.change(screen.getByLabelText("Название"), {
      target: { value: "Пекарня" },
    });
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
  }

  async function finishWizard() {
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.change(screen.getByLabelText("Имя"), {
      target: { value: "Ольга Николаевна" },
    });
    fireEvent.change(screen.getByLabelText("Роль в компании"), {
      target: { value: "операционный директор" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Добавить человека" }));
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.change(screen.getByLabelText("Заметки менеджера"), {
      target: { value: "Сроки горят" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Собрать бриф" }));
    await waitFor(() => {
      if (invokedWith("brief_build").length === 0) {
        throw new Error("The build has not started yet");
      }
    });
  }

  it("saves documents, people and notes, then builds the brief", async () => {
    fake.answers.set("plugin:dialog|open", () => ["/Users/dima/ТЗ.docx"]);
    fillWizard();
    expect(
      screen.getByRole("heading", { name: "Откуда брать контекст" })
    ).toBeTruthy();

    // Integrations come later.
    expect(
      within(screen.getByRole("list", { name: "Интеграции" })).getAllByText(
        "скоро"
      )
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Выбрать файлы" }));
    // The first document saves the project: documents belong to one.
    const list = await screen.findByRole("list", { name: "Документы проекта" });
    expect(within(list).getByText("ТЗ.docx")).toBeTruthy();
    const [create] = invokedWith("projects_create");
    expect(create).toEqual({
      input: { description: "", name: "Пекарня", notes: "" },
    });
    const draft = fake.db.projects.at(-1)?.id ?? "";
    expect(invokedWith("project_sources_add")).toEqual([
      { paths: ["/Users/dima/ТЗ.docx"], projectId: draft },
    ]);

    await finishWizard();
    expect(
      screen.getByRole("heading", { name: "Собираю бриф проекта" })
    ).toBeTruthy();
    expect(invokedWith("projects_create")).toHaveLength(1);
    expect(invokedWith("projects_update")).toEqual([
      {
        id: draft,
        patch: { description: "", name: "Пекарня", notes: "Сроки горят" },
      },
    ]);
    expect(invokedWith("people_create")).toEqual([
      {
        input: {
          name: "Ольга Николаевна",
          profile: { initials: "ОН" },
          projectId: draft,
          role: "операционный директор",
        },
      },
    ]);
    expect(invokedWith("brief_build")).toEqual([{ projectId: draft }]);

    act(() => {
      for (const stage of [1, 2, 3]) {
        fake.emit("brief-progress", {
          projectId: draft,
          stage,
          state: { status: "running" },
        });
      }
    });
    expect(
      await screen.findByRole("progressbar", {
        name: "Сбор брифа, этап 3 из 5",
      })
    ).toBeTruthy();
    expect(screen.getByText("Агент читает материалы")).toBeTruthy();

    act(() =>
      fake.emit("brief-progress", {
        projectId: draft,
        stage: 5,
        state: { status: "done" },
      })
    );
    expect(
      await screen.findByRole("heading", { name: "Бриф готов" })
    ).toBeTruthy();
  });

  it("collapses the build to the background with a toast when ready", async () => {
    const add = vi.spyOn(toast, "add");
    fillWizard();
    await finishWizard();
    const created = fake.db.projects.at(-1)?.id ?? "";

    fireEvent.click(screen.getByRole("button", { name: "Свернуть в фон" }));
    expect(nav.push).toHaveBeenCalledWith("/");
    act(() =>
      fake.emit("brief-progress", {
        projectId: created,
        stage: 5,
        state: { status: "done" },
      })
    );
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Бриф проекта «Пекарня» готов",
          type: "success",
        })
      )
    );
  });

  it("stops the build and keeps the project", async () => {
    fillWizard();
    await finishWizard();
    const created = fake.db.projects.at(-1)?.id ?? "";

    fireEvent.click(screen.getByRole("button", { name: "Остановить" }));
    await waitFor(() =>
      expect(invokedWith("brief_cancel")).toEqual([{ projectId: created }])
    );
    expect(nav.push).toHaveBeenCalledWith(`/project?id=${created}`);
  });

  it("says why the build failed", async () => {
    fillWizard();
    await finishWizard();
    const created = fake.db.projects.at(-1)?.id ?? "";

    act(() =>
      fake.emit("brief-progress", {
        projectId: created,
        stage: 2,
        state: { message: "Claude Code не вошёл в аккаунт", status: "failed" },
      })
    );
    expect(
      await screen.findByText("Claude Code не вошёл в аккаунт", {
        exact: false,
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Собрать ещё раз" })
    ).toBeTruthy();
  });
});
