import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
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

const { fakeProject, fakeSource, NO_LIMIT_DATA } = await import(
  "./helpers/fake-tauri"
);
const { ProjectPage } = await import("@/features/projects/pages/project-page");
const { NewProjectPage } = await import(
  "@/features/projects/pages/new-project-page"
);
const { refreshProjects } = await import("@/data/projects");
const { refreshPeople } = await import("@/data/people");
const { refreshSources } = await import("@/data/sources");
const { toast } = await import("@grill/ui/toast");
const { useAddDocuments } = await import("@/features/projects/api");
const { resetLine } = await import("@/lib/agent-limit");
const { DESCRIPTION_LIMIT_HINT, DESCRIPTION_MAX_CHARS, NOTES_MAX_CHARS } =
  await import("@/data/project-limits");

const PROJECT = "019a0000-0000-7000-8000-000000000001";
const SOURCE = "019a0000-0000-7000-8000-0000000000d1";
const HOUR_MS = 3_600_000;
const OLGA = /Ольга Николаевна/u;
const KEY_DOCUMENT = /Техническое задание/u;
const NEXT = /Далее/u;
const COUNTER = /^33 \/ 50\s000$/u;

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

function progress(
  stage: number,
  state: BriefProgress["state"],
  projectId = PROJECT
) {
  act(() => fake.emit("brief-progress", { projectId, stage, state }));
}

/** Stages `from…to` as `Stages::advance` in run.rs sends them. */
function stagesDone(from: number, to: number, projectId = PROJECT) {
  for (let stage = from; stage <= to; stage += 1) {
    progress(stage, { status: "running" }, projectId);
    progress(stage, { status: "done" }, projectId);
  }
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
  act(() => fake.setLimit(NO_LIMIT_DATA));
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
      expect(invokedWith("brief_build")).toEqual([
        { overLimit: false, projectId: PROJECT },
      ])
    );
    progress(1, { status: "running" });
    progress(1, { status: "done" });
    progress(2, { status: "running" });
    // The first stage's `done` is not the end of the build.
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

  it("lists «Неясно до звонка» with the lens of each gap", async () => {
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: {
        ...BRIEF,
        gaps: [
          { lens: "users", text: "Не сказано, кто разбирает пропущенные" },
          { lens: "budget", text: "Линза не из семи" },
          { lens: "acceptance", text: "Нет критериев готовности очереди" },
        ],
      },
      briefBuiltAt: Date.now() - HOUR_MS,
      briefState: "fresh",
    });
    await reload();
    openProjectPage();

    const heading = await screen.findByRole("heading", {
      name: "Неясно до звонка",
    });
    const section = heading.closest("section");
    if (!section) {
      throw new Error("no section around «Неясно до звонка»");
    }
    const items = within(section)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    // A lens the app doesn't know is left out.
    expect(items).toEqual([
      "пользователиНе сказано, кто разбирает пропущенные",
      "критерии готовностиНет критериев готовности очереди",
    ]);
  });

  it("shows an old brief without «Неясно до звонка» (Старый бриф)", async () => {
    // Built before the gaps: the stored JSON has no `gaps` at all.
    Object.assign(fake.db.projects[0] ?? {}, {
      brief: BRIEF,
      briefBuiltAt: Date.now() - HOUR_MS,
      briefState: "fresh",
    });
    await reload();
    openProjectPage();

    expect(await screen.findByText("Приём звонков сети клиник")).toBeTruthy();
    expect(screen.getByText("Первичка")).toBeTruthy();
    expect(screen.queryByText("Неясно до звонка")).toBeNull();
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
      expect(invokedWith("brief_build")).toEqual([
        { overLimit: false, projectId: PROJECT },
      ])
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
    progress(3, { status: "done" });
    progress(4, { status: "running" });
    expect(await screen.findByText("Собираю бриф: этап 4 из 5")).toBeTruthy();
    progress(4, { status: "done" });
    // Still building: only the last stage's `done` ends it.
    expect(
      screen.getByRole("progressbar", { name: "Обновление брифа" })
    ).toBeTruthy();
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

  it("tells «готов» only at the end, and a failure at stage 4", async () => {
    const add = vi.spyOn(toast, "add");
    openProjectPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Собрать бриф" })
    );
    await waitFor(() =>
      expect(invokedWith("brief_build")).toEqual([
        { overLimit: false, projectId: PROJECT },
      ])
    );

    stagesDone(1, 3);
    progress(4, { status: "running" });
    expect(await screen.findByText("Собираю бриф: этап 4 из 5")).toBeTruthy();
    expect(add).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" })
    );

    progress(4, { message: "Агент ответил не по схеме", status: "failed" });
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Агент ответил не по схеме",
          title: "Не удалось собрать бриф",
          type: "error",
        })
      )
    );
    expect(add).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" })
    );
    // The build is over: the page offers to build again.
    expect(
      await screen.findByRole("button", { name: "Собрать бриф" })
    ).toBeTruthy();
  });

  it("says nothing about the build of a deleted project", async () => {
    const add = vi.spyOn(toast, "add");
    openProjectPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Собрать бриф" })
    );
    await waitFor(() =>
      expect(invokedWith("brief_build")).toEqual([
        { overLimit: false, projectId: PROJECT },
      ])
    );
    stagesDone(1, 1);
    progress(2, { status: "running" });

    // Deleted in another window while the save ran: the save fails on the
    // missing project (a cancel after the commit ends it quietly too).
    fake.db.projects.length = 0;
    progress(2, { message: `Проект ${PROJECT} не найден`, status: "failed" });
    await waitFor(() =>
      expect(invokedWith("projects_get")).toEqual([{ id: PROJECT }])
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(add).not.toHaveBeenCalled();
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
    // GitHub comes later: drawn, nothing to pick.
    const integrations = screen.getByRole("list", { name: "Интеграции" });
    expect(within(integrations).getAllByText("скоро")).toHaveLength(1);
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

  it("forgets the files turned away when another project opens", async () => {
    const other = "019a0000-0000-7000-8000-000000000002";
    fake.answers.set("project_sources_add", (args) =>
      (args.paths as string[]).map((path) => ({
        name: path.split("/").at(-1) ?? path,
        path,
        result: {
          message: "Поддерживаются .md, .txt, .pdf и .docx",
          outcome: "rejected",
          reason: "unsupportedType",
        },
      }))
    );
    const { rerender, result } = renderHook(
      ({ id }: { id: string }) => useAddDocuments(id),
      { initialProps: { id: PROJECT } }
    );
    await act(() => result.current.add(["/Users/dima/смета.xlsx"]));
    expect(result.current.rejected).toEqual([
      { message: "Поддерживаются .md, .txt, .pdf и .docx", name: "смета.xlsx" },
    ]);

    rerender({ id: other });
    expect(result.current.rejected).toEqual([]);
    // Back to the first project: the old rejection is gone too.
    rerender({ id: PROJECT });
    expect(result.current.rejected).toEqual([]);
  });

  it("saves the manager's notes", async () => {
    openProjectPage();

    const field = await screen.findByLabelText("Заметки менеджера");
    // The limit Rust keeps (projects_update refuses longer notes).
    expect(field.getAttribute("maxlength")).toBe(String(NOTES_MAX_CHARS));
    fireEvent.change(field, {
      target: { value: "Решения по amoCRM принимает Игорь" },
    });
    expect(screen.getByText(COUNTER)).toBeTruthy();
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
    render(<NewProjectPage />);
    const description = screen.getByLabelText("Описание");
    expect(description.getAttribute("maxlength")).toBe(
      String(DESCRIPTION_MAX_CHARS)
    );
    expect(screen.getByText(DESCRIPTION_LIMIT_HINT)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Название"), {
      target: { value: "Пекарня" },
    });
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    expect(
      screen.getByRole("heading", { name: "Откуда брать контекст" })
    ).toBeTruthy();

    // GitHub comes later.
    expect(
      within(screen.getByRole("list", { name: "Интеграции" })).getAllByText(
        "скоро"
      )
    ).toHaveLength(1);
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
    expect(invokedWith("brief_build")).toEqual([
      { overLimit: false, projectId: draft },
    ]);

    // The exact events of run.rs: every stage runs, then is done.
    progress(1, { status: "running" }, draft);
    progress(1, { status: "done" }, draft);
    expect(
      await screen.findByRole("progressbar", {
        name: "Сбор брифа, этап 2 из 5",
      })
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Бриф готов" })).toBeNull();
    stagesDone(2, 2, draft);
    progress(3, { status: "running" }, draft);
    expect(
      await screen.findByRole("progressbar", {
        name: "Сбор брифа, этап 3 из 5",
      })
    ).toBeTruthy();
    expect(screen.getByText("Агент читает материалы")).toBeTruthy();

    progress(3, { status: "done" }, draft);
    stagesDone(4, 4, draft);
    progress(5, { status: "running" }, draft);
    expect(screen.queryByRole("heading", { name: "Бриф готов" })).toBeNull();
    progress(5, { status: "done" }, draft);
    expect(
      await screen.findByRole("heading", { name: "Бриф готов" })
    ).toBeTruthy();
  });

  it("makes one draft for two quick drops", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const draft = "019a0000-0000-7000-8000-0000000000aa";
    fake.answers.set("projects_create", async (args) => {
      await gate;
      const input = args.input as { name: string };
      const project = fakeProject(draft, input.name);
      fake.db.projects.push(project);
      fake.dataChanged({
        change: "created",
        entity: "project",
        id: draft,
        projectId: draft,
      });
      return structuredClone(project);
    });
    fake.answers.set("project_sources_add", (args) =>
      (args.paths as string[]).map((path) => {
        const name = path.split("/").at(-1) ?? path;
        const source = fakeSource(`doc-${name}`, String(args.projectId), name);
        fake.db.sources.push(source);
        return { name, path, result: { outcome: "added", source } };
      })
    );
    fillWizard();
    await waitFor(() => expect(drops.handler).not.toBeNull());

    // The second file comes before the project of the first is saved.
    act(() =>
      drops.handler?.({
        payload: { paths: ["/Users/dima/ТЗ.docx"], type: "drop" },
      })
    );
    act(() =>
      drops.handler?.({
        payload: { paths: ["/Users/dima/переписка.pdf"], type: "drop" },
      })
    );
    await act(async () => {
      release();
      await gate;
    });

    await waitFor(() =>
      expect(invokedWith("project_sources_add")).toHaveLength(2)
    );
    expect(invokedWith("projects_create")).toHaveLength(1);
    expect(fake.db.projects.filter((item) => item.id === draft)).toHaveLength(
      1
    );
    expect(invokedWith("project_sources_add")).toEqual([
      { paths: ["/Users/dima/ТЗ.docx"], projectId: draft },
      { paths: ["/Users/dima/переписка.pdf"], projectId: draft },
    ]);
  });

  it("collapses the build to the background with a toast when ready", async () => {
    const add = vi.spyOn(toast, "add");
    fillWizard();
    await finishWizard();
    const created = fake.db.projects.at(-1)?.id ?? "";

    fireEvent.click(screen.getByRole("button", { name: "Свернуть в фон" }));
    expect(nav.push).toHaveBeenCalledWith("/");
    stagesDone(1, 4, created);
    progress(5, { status: "running" }, created);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(add).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" })
    );
    progress(5, { status: "done" }, created);
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

    stagesDone(1, 3, created);
    progress(4, { status: "running" }, created);
    progress(
      4,
      { message: "Claude Code не вошёл в аккаунт", status: "failed" },
      created
    );
    expect(
      await screen.findByText("Claude Code не вошёл в аккаунт", {
        exact: false,
      })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Собрать ещё раз" })
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Бриф готов" })).toBeNull();
  });
});

describe("the brief at a threshold of Grill", () => {
  const LIMIT_TITLE = "Бриф не собран: достигнут лимит Grill";
  const resetsAt = Date.now() + 26 * HOUR_MS;

  /** The week at 85 % of its 80 % threshold. */
  function weekReached() {
    act(() =>
      fake.setLimit({
        ...NO_LIMIT_DATA,
        outlook: {
          hit: { resetsAt, threshold: 80, used: 85, window: "week" },
          kind: "reached",
        },
      })
    );
  }

  /** What run.rs sends when the threshold holds the build back. */
  function heldBack(projectId: string) {
    stagesDone(1, 1, projectId);
    progress(2, { status: "running" }, projectId);
    progress(2, { message: "grillLimit", status: "failed" }, projectId);
  }

  async function wizardHeldBack() {
    weekReached();
    render(<NewProjectPage />);
    fireEvent.change(screen.getByLabelText("Название"), {
      target: { value: "Пекарня" },
    });
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.click(screen.getByRole("button", { name: "Собрать бриф" }));
    await waitFor(() => expect(invokedWith("brief_build")).toHaveLength(1));
    const created = fake.db.projects.at(-1)?.id ?? "";
    heldBack(created);
    return created;
  }

  it("the wizard tells the threshold and builds past it", async () => {
    const add = vi.spyOn(toast, "add");
    const created = await wizardHeldBack();

    expect(await screen.findByText(LIMIT_TITLE)).toBeTruthy();
    expect(
      screen.getByText(`Неделя 85 % из 80 %, ${resetLine(resetsAt)}.`, {
        exact: false,
      })
    ).toBeTruthy();
    expect(screen.queryByText("Не удалось собрать бриф")).toBeNull();
    expect(add).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Собрать сверх лимита" })
    );
    await waitFor(() =>
      expect(invokedWith("brief_build")).toEqual([
        { overLimit: false, projectId: created },
        { overLimit: true, projectId: created },
      ])
    );
  });

  it("Мастер за порогом: the project is saved, its page offers «Собрать сверх лимита»", async () => {
    const created = await wizardHeldBack();
    expect(await screen.findByText(LIMIT_TITLE)).toBeTruthy();
    expect(fake.db.projects.find((item) => item.id === created)?.brief).toBe(
      null
    );

    cleanup();
    nav.search = new URLSearchParams(`id=${created}`);
    render(<ProjectPage />);
    const notice = (await screen.findByText(LIMIT_TITLE)).closest(
      "[data-slot=alert]"
    );
    expect(notice?.textContent).toContain("Неделя 85 % из 80 %");
    fireEvent.click(
      within(notice as HTMLElement).getByRole("button", {
        name: "Собрать сверх лимита",
      })
    );
    await waitFor(() =>
      expect(invokedWith("brief_build").at(-1)).toEqual({
        overLimit: true,
        projectId: created,
      })
    );
  });

  it("the project page drops the notice once the threshold let go", async () => {
    weekReached();
    openProjectPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Собрать бриф" })
    );
    await waitFor(() =>
      expect(invokedWith("brief_build")).toEqual([
        { overLimit: false, projectId: PROJECT },
      ])
    );
    heldBack(PROJECT);
    expect(await screen.findByText(LIMIT_TITLE)).toBeTruthy();

    act(() => fake.setLimit(NO_LIMIT_DATA));
    await waitFor(() => expect(screen.queryByText(LIMIT_TITLE)).toBeNull());
    expect(screen.getByRole("button", { name: "Собрать бриф" })).toBeTruthy();
  });
});
