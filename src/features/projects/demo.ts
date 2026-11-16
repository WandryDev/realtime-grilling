import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

const DEMO_PROJECT = "telemedia";
const DEMO_PERSON = "olga";

/** Screens and forced states of this area, listed in the dev navigator. */
export const projectsDemo: DemoGroup = {
  links: [
    { href: routes.home(), label: "Главная" },
    {
      href: withDemo(routes.home(), "first-run"),
      label: "Главная, первый запуск",
    },
    { href: routes.newProject(), label: "Новый проект, шаг 1" },
    {
      href: withDemo(routes.newProject(), "name-error"),
      label: "Новый проект, ошибка названия",
    },
    {
      href: withDemo(routes.newProject(), "sources"),
      label: "Новый проект, источники",
    },
    {
      href: withDemo(routes.newProject(), "people"),
      label: "Новый проект, люди",
    },
    {
      href: withDemo(routes.newProject(), "notes"),
      label: "Новый проект, заметки",
    },
    {
      href: withDemo(routes.newProject(), "building"),
      label: "Новый проект, собираю бриф",
    },
    {
      href: withDemo(routes.newProject(), "ready"),
      label: "Новый проект, бриф готов",
    },
    { href: routes.project(DEMO_PROJECT), label: "Проект Телемедиа" },
    {
      href: withDemo(routes.project(DEMO_PROJECT), "updating"),
      label: "Проект, бриф обновляется",
    },
    {
      href: withDemo(routes.project(DEMO_PROJECT), "outdated"),
      label: "Проект, бриф устарел",
    },
    {
      href: withDemo(routes.project(DEMO_PROJECT), "add-person"),
      label: "Проект, диалог «Новый человек»",
    },
    {
      href: withDemo(routes.project(DEMO_PROJECT), "edit"),
      label: "Проект, диалог «Изменить»",
    },
    {
      href: withDemo(routes.project(DEMO_PROJECT), "delete"),
      label: "Проект, удаление",
    },
    { href: routes.project("lapa"), label: "Проект без людей (Лапа)" },
    {
      href: routes.project("missing"),
      label: "Проект не найден",
    },
    {
      href: routes.person(DEMO_PROJECT, DEMO_PERSON),
      label: "Человек, профиль с предложением",
    },
    {
      href: withDemo(routes.person(DEMO_PROJECT, DEMO_PERSON), "edit"),
      label: "Человек, редактирование",
    },
    {
      href: routes.person(DEMO_PROJECT, "missing"),
      label: "Человек не найден",
    },
  ],
  title: "Проекты",
};
