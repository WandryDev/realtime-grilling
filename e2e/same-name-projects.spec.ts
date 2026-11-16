import { expect, type Page, test } from "@playwright/test";

import { completeOnboarding, createProjectInWizard } from "./flows";

/*
 * Two projects may share a name: each has its own id from the backend and
 * opens on its own page (local-storage spec, "Два проекта с одинаковым
 * названием"). The wizard turns away a name that is already taken, so the
 * user gets there by renaming: the first project is renamed while the
 * second one is created, then renamed back. Ids are not asserted, only
 * that the two entries open different projects.
 */

const NAME = "Пекарня";
const TEMPORARY_NAME = "Пекарня на Садовой";
/** Both descriptions below match it. */
const DESCRIPTION = /точка, на/u;
const PROJECT_URL = /\/project\?/u;

const FIRST = {
  description: "Первая точка, на Садовой",
  name: NAME,
  person: { name: "Анна Белова", role: "Управляющая" },
};

const SECOND = {
  description: "Вторая точка, на Лесной",
  name: NAME,
  person: { name: "Борис Орлов", role: "Владелец" },
};

/** "Изменить" on the open project page: a new name, the rest unchanged. */
async function renameOpenProject(page: Page, name: string) {
  await page
    .getByRole("main")
    .getByRole("button", { name: "Изменить" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Изменить проект" });
  await dialog.getByRole("textbox", { name: "Название" }).fill(name);
  await dialog.getByRole("button", { name: "Сохранить" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole("main").getByRole("heading", { exact: true, level: 1, name })
  ).toBeVisible();
}

/** What the open project page shows: its description, people and URL. */
async function openedProject(page: Page) {
  await expect(page).toHaveURL(PROJECT_URL);
  const main = page.getByRole("main");
  await expect(
    main.getByRole("heading", { exact: true, level: 1, name: NAME })
  ).toBeVisible();
  const description = main.getByText(DESCRIPTION);
  await expect(description).toBeVisible();
  return {
    description: (await description.textContent()) ?? "",
    people:
      (await page
        .getByRole("region", { name: "Люди клиента" })
        .textContent()) ?? "",
    url: page.url(),
  };
}

test("two projects with the same name open separately", async ({ page }) => {
  await completeOnboarding(page);
  const sidebarProjects = page.getByRole("navigation", { name: "Проекты" });

  // The first one, renamed for a while.
  await createProjectInWizard(page, FIRST);
  await page.getByRole("link", { name: "Открыть проект" }).click();
  await renameOpenProject(page, TEMPORARY_NAME);

  // The second one, with the original name.
  await page
    .getByRole("complementary")
    .getByRole("link", { exact: true, name: "Новый проект" })
    .click();
  await createProjectInWizard(page, SECOND);
  await page.getByRole("link", { name: "Открыть проект" }).click();
  await expect(
    page.getByRole("main").getByText(SECOND.description)
  ).toBeVisible();

  // The first one gets its name back.
  await sidebarProjects
    .getByRole("link", { exact: true, name: TEMPORARY_NAME })
    .click();
  await expect(
    page.getByRole("main").getByText(FIRST.description)
  ).toBeVisible();
  await renameOpenProject(page, NAME);

  // Two entries with the same name, each opens its own project.
  const entries = sidebarProjects.getByRole("link", {
    exact: true,
    name: NAME,
  });
  await expect(entries).toHaveCount(2);

  // Home in between, so the second page can't be mistaken for the first.
  const home = page.getByRole("link", { exact: true, name: "Главная" });
  await home.click();
  await entries.first().click();
  const first = await openedProject(page);
  await home.click();
  await entries.last().click();
  const second = await openedProject(page);

  expect(second.url).not.toBe(first.url);
  expect([first.description, second.description].sort()).toEqual(
    [FIRST.description, SECOND.description].sort()
  );
  for (const opened of [first, second]) {
    const project = opened.description === FIRST.description ? FIRST : SECOND;
    expect(opened.people).toContain(project.person.name);
  }
});
