import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * People, home and the start widget in Tauri mode, over the fake IPC
 * (./helpers/fake-tauri.ts): a profile edited in the main window shows in
 * the widget's participants, a deleted person leaves them, the widget asks
 * Rust to refresh an outdated brief when shown, and home counts from
 * `projects_overview`.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const win = vi.hoisted(() => ({ label: "main" }));
const nav = vi.hoisted(() => ({ search: new URLSearchParams() }));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: vi.fn(() => Promise.resolve()),
    label: win.label,
    listen: fake.listen,
  }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => nav.search,
}));

const { fakeCall, fakePerson, fakeProject } = await import(
  "./helpers/fake-tauri"
);
const { StartWidgetPage } = await import(
  "@/features/call-widget/pages/start-widget-page"
);
const { HomePage } = await import("@/features/projects/pages/home-page");
const { PersonPage } = await import("@/features/projects/pages/person-page");
const { refreshProjects } = await import("@/data/projects");
const { refreshPeople } = await import("@/data/people");

const TELEMEDIA = "019a0000-0000-7000-8000-000000000001";
const IGOR = "019a0000-0000-7000-8000-0000000000b1";
const ADD_PARTICIPANT = "Добавить участника";
const SAVE = /Сохранить/u;
const TELEMEDIA_ROW = /Телемедиа/u;

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

function personChanged(change: "updated" | "deleted") {
  act(() => {
    fake.dataChanged({
      change,
      entity: "person",
      id: IGOR,
      projectId: TELEMEDIA,
    });
  });
}

/** The widget with Игорь picked from the "+" menu. */
async function widgetWithIgor() {
  const user = userEvent.setup();
  win.label = "widget";
  render(<StartWidgetPage />);
  await user.click(
    await screen.findByRole("button", { name: ADD_PARTICIPANT })
  );
  await user.click(await screen.findByRole("menuitem", { name: "Игорь" }));
  return screen.findByTitle("Игорь Савчук, в технике: базово");
}

beforeEach(async () => {
  win.label = "main";
  nav.search = new URLSearchParams();
  fake.answers.clear();
  fake.failures.clear();
  fake.db.projects.splice(
    0,
    fake.db.projects.length,
    fakeProject(TELEMEDIA, "Телемедиа")
  );
  fake.db.people.splice(0, fake.db.people.length, {
    ...fakePerson(IGOR, TELEMEDIA, "Игорь Савчук"),
    profile: { tech: 2 },
    role: "Техлид",
  });
  fake.db.calls.length = 0;
  await act(async () => {
    await refreshProjects();
    await refreshPeople();
  });
  fake.invoked.length = 0;
});

describe("people in every window", () => {
  it("shows a level edited in the profile in the widget's participants", async () => {
    const chip = await widgetWithIgor();
    expect(chip).toBeTruthy();

    // The main window raises Игорь to "технарь".
    const [person] = fake.db.people;
    if (person) {
      person.profile = { tech: 5 };
    }
    personChanged("updated");

    expect(
      await screen.findByTitle("Игорь Савчук, в технике: технарь")
    ).toBeTruthy();
    expect(screen.queryByTitle("Игорь Савчук, в технике: базово")).toBeNull();
  });

  it("drops a deleted person from the widget's participants", async () => {
    await widgetWithIgor();
    expect(screen.getByRole("button", { name: "Убрать Игорь" })).toBeTruthy();

    fake.db.people.length = 0;
    personChanged("deleted");

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Убрать Игорь" })).toBeNull()
    );
    expect(
      screen
        .getByRole("button", { name: ADD_PARTICIPANT })
        .hasAttribute("disabled")
    ).toBe(true);
  });

  it("saves the levels of the profile, «не указано» included", async () => {
    nav.search = new URLSearchParams(`project=${TELEMEDIA}&id=${IGOR}`);
    render(<PersonPage />);

    expect(await screen.findByText("базово")).toBeTruthy();
    expect(screen.getByText("не указано")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    fireEvent.click(screen.getByRole("button", { name: "В технике: 5 из 5" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Понимание проекта: 3 из 5" })
    );
    fireEvent.change(screen.getByLabelText("Темперамент"), {
      target: { value: "Спокойный" },
    });
    fireEvent.change(screen.getByLabelText("Что важно знать"), {
      target: { value: "Отвечает за телефонию" },
    });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() =>
      expect(invokedWith("people_update").at(-1)).toEqual({
        id: IGOR,
        patch: {
          profile: expect.objectContaining({
            notes: "Отвечает за телефонию",
            portrait: expect.objectContaining({ Темперамент: "Спокойный" }),
            project: 3,
            tech: 5,
          }),
          role: "Техлид",
        },
      })
    );
  });
});

describe("the start widget and the brief", () => {
  it("asks Rust to refresh an outdated brief and says it is refreshing", async () => {
    const [project] = fake.db.projects;
    if (project) {
      project.brief = { product: "Приём звонков" };
      project.briefState = "outdated";
    }
    await act(() => refreshProjects());
    fake.answers.set("brief_prepare", () => true);
    win.label = "widget";
    render(<StartWidgetPage />);

    await waitFor(() =>
      expect(invokedWith("brief_prepare")).toEqual([{ projectId: TELEMEDIA }])
    );
    act(() =>
      fake.emit("brief-progress", {
        projectId: TELEMEDIA,
        stage: 2,
        state: { status: "running" },
      })
    );
    expect(await screen.findByText("Обновляю бриф…")).toBeTruthy();

    act(() =>
      fake.emit("brief-progress", {
        projectId: TELEMEDIA,
        stage: 5,
        state: { status: "done" },
      })
    );
    await waitFor(() =>
      expect(screen.queryByText("Обновляю бриф…")).toBeNull()
    );
  });
});

describe("home", () => {
  it("counts open questions and the last recording from the overview", async () => {
    const call = {
      ...fakeCall("019a0000-0000-7000-8000-0000000000c1", TELEMEDIA, "Созвон"),
      openQuestions: 4,
      startedAt: Date.UTC(2026, 10, 3, 9, 0),
    };
    fake.db.calls.push(call);
    await act(() => refreshProjects());
    render(<HomePage />);

    const table = await screen.findByRole("list", { name: "Проекты" });
    const row = within(table).getByRole("link", { name: TELEMEDIA_ROW });
    expect(within(row).getByText("4")).toBeTruthy();
    expect(within(row).getByText("последняя запись")).toBeTruthy();
    expect(within(row).queryByText("Звонков ещё не было")).toBeNull();
    expect(invokedWith("projects_overview").length).toBeGreaterThan(0);
  });
});
