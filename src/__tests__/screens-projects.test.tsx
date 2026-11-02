import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HomeScreen } from "@/features/projects/screens/home-screen";
import {
  NewProjectScreen,
  type NewProjectState,
} from "@/features/projects/screens/new-project-screen";
import { PersonScreen } from "@/features/projects/screens/person-screen";
import { ProjectScreen } from "@/features/projects/screens/project-screen";

describe("HomeScreen", () => {
  it("lists the projects and the recent calls", () => {
    render(<HomeScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Проекты" })
    ).toBeTruthy();
    const projects = screen.getByRole("list", { name: "Проекты" });
    expect(within(projects).getAllByRole("link")).toHaveLength(4);
    expect(
      screen.getByRole("heading", { name: "Недавние звонки" })
    ).toBeTruthy();
    expect(screen.getByText("3 предложения к брифу")).toBeTruthy();
  });

  it("shows the first run without projects", () => {
    render(<HomeScreen state="first-run" />);

    expect(
      screen.getByRole("heading", { name: "Начнём с первого проекта" })
    ).toBeTruthy();
    expect(screen.getByText("Пока ни одного проекта")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Создать проект" })).toBeTruthy();
  });
});

const WIZARD_HEADINGS: [NewProjectState, string][] = [
  ["name", "Что за проект?"],
  ["name-error", "Что за проект?"],
  ["sources", "Откуда брать контекст"],
  ["people", "Кто будет на звонках"],
  ["notes", "Что знаете только вы"],
  ["building", "Собираю бриф проекта"],
  ["ready", "Бриф готов"],
];

describe("NewProjectScreen", () => {
  it.each(WIZARD_HEADINGS)("renders the %s step", (state, heading) => {
    render(<NewProjectScreen state={state} />);

    expect(
      screen.getByRole("heading", { level: 1, name: heading })
    ).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Шаги нового проекта" })
    ).toBeTruthy();
  });

  it("explains why the name is required", () => {
    render(<NewProjectScreen state="name-error" />);

    expect(
      screen.getByText(
        "Нужно название, по нему вы выберете проект в начале звонка"
      )
    ).toBeTruthy();
  });

  it("marks the current step and lets you go back to finished ones", () => {
    render(<NewProjectScreen state="people" />);

    const steps = screen.getByRole("navigation", {
      name: "Шаги нового проекта",
    });
    expect(within(steps).getAllByRole("button")).toHaveLength(2);
    expect(steps.querySelector("[aria-current='step']")?.textContent).toContain(
      "Люди клиента"
    );
  });
});

describe("ProjectScreen", () => {
  it("renders the brief, people, calls and sources", () => {
    render(<ProjectScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Телемедиа" })
    ).toBeTruthy();
    for (const name of ["Бриф", "Люди клиента", "Звонки", "Источники"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    }
    expect(
      screen.getByText("4 предложения после звонка сегодня в 12:00")
    ).toBeTruthy();
  });

  it("shows the refresh in progress", () => {
    render(<ProjectScreen briefState="updating" />);

    expect(
      screen.getByText(
        "Обновляю: 3 изменённых документа в Outline и 14 новых коммитов"
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Остановить" })).toBeTruthy();
  });

  it("asks to refresh an outdated brief", () => {
    render(<ProjectScreen briefState="outdated" proposals={null} />);

    expect(screen.getByText("Бриф мог устареть")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Обновить бриф" })).toBeTruthy();
    expect(screen.getByText("нет доступа к telemedia/web")).toBeTruthy();
  });

  it("draws the add person dialog over the page", () => {
    render(<ProjectScreen dialog="add-person" proposals={null} />);

    const dialog = screen.getByRole("dialog", { name: "Новый человек" });
    expect(within(dialog).getByLabelText("Имя")).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Добавить" })
    ).toBeTruthy();
  });

  it("confirms the deletion of the project", () => {
    render(<ProjectScreen dialog="delete-project" proposals={null} />);

    const dialog = screen.getByRole("alertdialog", {
      name: "Удалить проект «Телемедиа»?",
    });
    expect(
      within(dialog).getByRole("button", { name: "Удалить проект" })
    ).toBeTruthy();
  });
});

describe("PersonScreen", () => {
  it("shows the profile with the suggestion after the call", () => {
    render(<PersonScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Ольга Демченко" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Предложение после звонка сегодня" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Принять" })).toBeTruthy();
  });

  it("makes the fields editable in edit mode", () => {
    render(<PersonScreen mode="edit" />);

    expect(screen.getByRole("button", { name: "Сохранить" })).toBeTruthy();
    expect(
      screen.getByLabelText("Как формулировать вопросы для Ольги")
    ).toBeTruthy();
    expect(screen.getByLabelText("Темперамент")).toBeTruthy();
    expect(screen.queryByText("Предложение после звонка сегодня")).toBeNull();
  });
});
