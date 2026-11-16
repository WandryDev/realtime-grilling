import { expect, test } from "@playwright/test";

import { completeOnboarding, createProjectInWizard } from "./flows";

const RECORDING = /Идёт запись/u;
const RECORDING_STOPPED = /Запись остановлена/u;
const PERSON_FIRST_NAME = /Ольга/u;

const PROJECT = {
  description: "Сайт с заказом выпечки",
  name: "Пекарня Хлеб",
  person: { name: "Ольга Смирнова", role: "Директор" },
};

test("onboarding → new project → start widget → call → summary and history", async ({
  page,
}) => {
  await completeOnboarding(page);
  await createProjectInWizard(page, PROJECT);

  // The project page.
  await page.getByRole("link", { name: "Открыть проект" }).click();
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { level: 1, name: PROJECT.name })
  ).toBeVisible();
  await expect(main.getByText(PROJECT.description)).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Люди клиента" })
      .getByRole("link", { name: new RegExp(PROJECT.person.name, "u") })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Звонки" }).getByText("пока пусто")
  ).toBeVisible();

  // History → "Начать звонок" opens the start widget.
  await page.getByRole("link", { name: "История звонков" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Звонки" })
  ).toBeVisible();
  await page.getByRole("link", { name: "Начать звонок" }).click();

  // The widget: the new project and its person on the call.
  await expect(
    page.getByRole("heading", { level: 1, name: "Начать звонок?" })
  ).toBeVisible();
  await page.getByRole("combobox", { name: "Проект" }).click();
  await page
    .getByRole("option", { name: new RegExp(`^${PROJECT.name}`, "u") })
    .click();
  await expect(page.getByRole("combobox", { name: "Проект" })).toContainText(
    PROJECT.name
  );
  await page.getByRole("button", { name: "Добавить участника" }).click();
  await page.getByRole("menuitem", { name: "Ольга" }).click();
  await expect(
    page.getByRole("button", { name: "Убрать Ольга" })
  ).toBeVisible();
  await page.getByRole("button", { exact: true, name: "Начать" }).click();

  // Recording starts while the brief refreshes, then the compact overlay.
  await expect(
    page.getByRole("heading", { level: 1, name: "Готовлю бриф" })
  ).toBeVisible();
  await expect(page.getByText(`${PROJECT.name}, с Ольгой.`)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Свернуть в пилюлю" })
  ).toBeVisible();
  await expect(page.getByRole("timer")).toHaveAccessibleName(RECORDING);
  await expect(page.getByText(PROJECT.name, { exact: true })).toBeVisible();

  // The overlay → the call window.
  await page.getByRole("link", { name: "Открыть окно звонка" }).click();
  await expect(page.getByRole("region", { name: "Расшифровка" })).toBeVisible();
  await expect(page.getByRole("timer")).toHaveAccessibleName(RECORDING);

  // "Завершить": recording stops, the agent collects the summary.
  await page.getByRole("button", { name: "Завершить" }).click();
  await expect(page.getByRole("timer")).toHaveAccessibleName(RECORDING_STOPPED);
  await expect(
    page.getByRole("dialog", { name: "Собираю итоги…" })
  ).toBeVisible();

  // The summary of the call, under the new project.
  await expect(
    page.getByRole("heading", { level: 1, name: "Итоги звонка" })
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Коротко" })).toBeVisible();
  const breadcrumbs = page.getByRole("navigation", { name: "Путь" });
  await expect(
    breadcrumbs.getByRole("link", { name: PROJECT.name })
  ).toBeVisible();

  // History of the project: the call is there.
  await breadcrumbs.getByRole("link", { name: "Звонки" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Звонки" })
  ).toBeVisible();
  await expect(
    page.getByRole("main").getByText(PROJECT.name, { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByRole("navigation", { name: "Проекты" })
      .getByRole("link", { name: `${PROJECT.name} 1` })
  ).toBeVisible();
  const calls = page
    .getByRole("main")
    .getByRole("link", { name: PERSON_FIRST_NAME });
  await expect(calls).toHaveCount(1);

  // And it opens the same summary.
  await calls.click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Итоги звонка" })
  ).toBeVisible();
});
