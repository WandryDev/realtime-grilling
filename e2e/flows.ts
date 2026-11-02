import { expect, type Page } from "@playwright/test";

const ONBOARDING_URL = /\/onboarding$/u;

/*
 * Steps shared by the scenarios. The app keeps its state in JS memory, so a
 * scenario opens `/` once and moves on by clicks only: a reload starts over.
 */

/**
 * Opens the app and goes through the setup like a first-time user: allows
 * both permissions in the mock macOS prompts, downloads the speech model,
 * logs in to Claude Code, skips the integrations. Ends on the new project
 * wizard ("Добавить первый проект").
 */
export async function completeOnboarding(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(ONBOARDING_URL);
  await expect(
    page.getByRole("heading", { level: 1, name: "Здравствуйте, это Grill" })
  ).toBeVisible();
  await page.getByRole("link", { name: "Начать" }).click();

  // 02: each "Разрешить" opens the system prompt, allowed in its dialog.
  await expect(
    page.getByRole("heading", { name: "Разрешите Grill слышать звонок" })
  ).toBeVisible();
  const main = page.getByRole("main");
  const prompt = page.getByRole("dialog");
  await main.getByRole("button", { name: "Разрешить" }).first().click();
  await prompt.getByRole("button", { name: "Разрешить" }).click();
  await main.getByRole("button", { name: "Разрешить" }).click();
  await prompt.getByRole("button", { name: "Разрешить" }).click();
  await expect(
    page.getByRole("heading", { name: "Всё разрешено" })
  ).toBeVisible();
  await page.getByRole("link", { name: "Продолжить" }).click();

  // 03: the model downloads and is checked, then "Продолжить" unlocks.
  await expect(
    page.getByRole("heading", { level: 1, name: "Распознавание речи" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Скачать" }).click();
  await page.getByRole("link", { name: "Продолжить" }).click();

  // 04: Claude Code is found without a login.
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Агент, который придумывает вопросы",
    })
  ).toBeVisible();
  await page.getByRole("button", { name: "Войти" }).click();
  await page.getByRole("link", { name: "Продолжить" }).click();

  // 05: integrations are optional.
  await expect(
    page.getByRole("heading", { name: "Подключите рабочие сервисы" })
  ).toBeVisible();
  await page.getByRole("link", { name: "Пропустить" }).click();

  // 06: the summary, then the app.
  await expect(
    page.getByRole("heading", { name: "Grill готов к первому звонку" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Добавить первый проект" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Что за проект?" })
  ).toBeVisible();
}

export interface NewProject {
  description: string;
  name: string;
  /** A client person added on the "Люди клиента" step. */
  person: { name: string; role: string };
}

/**
 * Goes through the open new project wizard and waits for the brief. Ends on
 * "Бриф готов"; the project is saved by then.
 */
export async function createProjectInWizard(page: Page, project: NewProject) {
  await expect(
    page.getByRole("heading", { level: 1, name: "Что за проект?" })
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Название" }).fill(project.name);
  await page
    .getByRole("textbox", { name: "Описание" })
    .fill(project.description);
  await page.getByRole("button", { name: "Далее" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Откуда брать контекст" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Далее" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Кто будет на звонках" })
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Имя" }).fill(project.person.name);
  await page
    .getByRole("textbox", { name: "Роль в компании" })
    .fill(project.person.role);
  await page.getByRole("button", { exact: true, name: "Добавить" }).click();
  await expect(
    page.getByRole("list", { name: "Люди клиента" }).getByRole("listitem")
  ).toContainText(project.person.name);
  await page.getByRole("button", { name: "Далее" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Что знаете только вы" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Собрать бриф" }).click();

  await expect(
    page.getByRole("heading", { level: 1, name: "Собираю бриф проекта" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 1, name: "Бриф готов" })
  ).toBeVisible();
}
