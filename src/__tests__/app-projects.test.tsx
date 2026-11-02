import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeOnboarding, resetOnboarding } from "@/data/onboarding";
import { getProjects } from "@/data/projects";
import { HomePage } from "@/features/projects/pages/home-page";
import { NewProjectPage } from "@/features/projects/pages/new-project-page";
import { PersonPage } from "@/features/projects/pages/person-page";
import { ProjectPage } from "@/features/projects/pages/project-page";

const OLGA = /Ольга Демченко/u;
const MARINA = /Марина Ковальчук/u;
const NEXT = /Далее/u;
const SAVE = /Сохранить/u;

const push = vi.fn();
const replace = vi.fn();
let search = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ back: vi.fn(), prefetch: vi.fn(), push, replace }),
  useSearchParams: () => search,
}));

function setSearch(query: string) {
  search = new URLSearchParams(query);
}

beforeEach(() => {
  push.mockClear();
  replace.mockClear();
  setSearch("");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HomePage", () => {
  it("sends a new user to onboarding", () => {
    resetOnboarding();
    render(<HomePage />);

    expect(replace).toHaveBeenCalledWith("/onboarding");
    expect(screen.queryByRole("heading", { name: "Проекты" })).toBeNull();
  });

  it("lists the projects once onboarding is done", () => {
    completeOnboarding();
    render(<HomePage />);

    const table = screen.getByRole("list", { name: "Проекты" });
    const rows = within(table).getAllByRole("link");
    expect(rows).toHaveLength(4);
    expect(rows[0]?.getAttribute("href")).toBe("/project?id=telemedia");
    const call = screen.getByText("Приём звонков, интеграция с CRM");
    expect(call.closest("a")?.getAttribute("href")).toBe(
      "/calls/proposals?id=telemedia-19-oct"
    );
  });

  it("forces the first run with ?demo=first-run", () => {
    completeOnboarding();
    setSearch("demo=first-run");
    render(<HomePage />);

    expect(
      screen.getByRole("heading", { name: "Начнём с первого проекта" })
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Создать проект" })
        .getAttribute("href")
    ).toBe("/project/new");
  });
});

describe("ProjectPage", () => {
  it("shows the stored project with links to its people and calls", () => {
    setSearch("id=telemedia");
    render(<ProjectPage />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Телемедиа" })
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: OLGA }).getAttribute("href")).toBe(
      "/project/person?id=olga&project=telemedia"
    );
    expect(
      screen
        .getByRole("button", { name: "Показать ещё 3" })
        .getAttribute("href")
    ).toBe("/history?project=telemedia");
  });

  it("falls back to an empty state for an unknown id", () => {
    setSearch("id=nope");
    render(<ProjectPage />);

    expect(
      screen.getByRole("heading", { name: "Проект не найден" })
    ).toBeTruthy();
  });

  it("adds a person from the live dialog", async () => {
    setSearch("id=telemedia&demo=add-person");
    render(<ProjectPage />);

    const dialog = await screen.findByRole("dialog", { name: "Новый человек" });
    fireEvent.change(within(dialog).getByLabelText("Имя"), {
      target: { value: "Марина Ковальчук" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить" }));

    expect(await screen.findByRole("link", { name: MARINA })).toBeTruthy();
  });

  it("deletes a project only after its name is typed", async () => {
    setSearch("id=lapa&demo=delete");
    render(<ProjectPage />);

    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить проект «Ветклиника Лапа»?",
    });
    const confirm = within(dialog).getByRole("button", {
      name: "Удалить проект",
    });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    fireEvent.change(
      within(dialog).getByLabelText(
        "Чтобы подтвердить, введите название проекта"
      ),
      { target: { value: "Ветклиника Лапа" } }
    );
    fireEvent.click(confirm);

    expect(push).toHaveBeenCalledWith("/");
    expect(getProjects().some((project) => project.id === "lapa")).toBe(false);
  });
});

describe("NewProjectPage", () => {
  it("walks the wizard and builds the brief of a new project", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<NewProjectPage />);

    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    expect(
      screen.getByText(
        "Нужно название, по нему вы выберете проект в начале звонка"
      )
    ).toBeTruthy();

    const name = screen.getByLabelText("Название");
    fireEvent.change(name, { target: { value: "Ромашка" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(
      screen.getByRole("heading", { name: "Откуда брать контекст" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.change(screen.getByLabelText("Имя"), {
      target: { value: "Анна Петрова" },
    });
    fireEvent.submit(screen.getByRole("form", { name: "Добавить человека" }));
    expect(screen.getByText("Анна Петрова")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: NEXT }));
    fireEvent.click(screen.getByRole("button", { name: "Собрать бриф" }));
    expect(
      screen.getByRole("heading", { name: "Собираю бриф проекта" })
    ).toBeTruthy();
    expect(getProjects().some((project) => project.name === "Ромашка")).toBe(
      true
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByRole("heading", { name: "Бриф готов" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Открыть проект" })
        .getAttribute("href")
    ).toBe(`/project?id=${encodeURIComponent("ромашка")}`);
  });

  it("asks before leaving a filled wizard", async () => {
    render(<NewProjectPage />);

    fireEvent.change(screen.getByLabelText("Название"), {
      target: { value: "Черновик" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Выйти без сохранения?",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Выйти" }));

    expect(push).toHaveBeenCalledWith("/");
  });
});

describe("PersonPage", () => {
  it("accepts the suggestion and saves edits", async () => {
    setSearch("project=telemedia&id=olga");
    render(<PersonPage />);

    fireEvent.click(screen.getByRole("button", { name: "Принять" }));
    expect(
      screen.queryByRole("heading", {
        name: "Предложение после звонка сегодня",
      })
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    fireEvent.click(screen.getByRole("button", { name: "В технике: 2 из 5" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Роль" }), {
      target: { value: "Основательница сети" },
    });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => {
      expect(screen.getByText("Основательница сети")).toBeTruthy();
    });
    expect(screen.getByText("базово")).toBeTruthy();
  });

  it("shows an empty state for an unknown person", () => {
    setSearch("project=telemedia&id=nobody");
    render(<PersonPage />);

    expect(
      screen.getByRole("heading", { name: "Профиль не найден" })
    ).toBeTruthy();
  });
});
