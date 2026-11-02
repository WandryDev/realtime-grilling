import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

/** Screens and forced states of this area, listed in the dev navigator. */
export const settingsDemo: DemoGroup = {
  links: [
    { href: routes.settings("general"), label: "Общие" },
    { href: routes.settings("audio"), label: "Звук и распознавание" },
    {
      href: withDemo(routes.settings("audio"), "mic-disabled"),
      label: "Звук: микрофон отключён",
    },
    {
      href: withDemo(routes.settings("audio"), "in-call"),
      label: "Звук: идёт звонок, выбор заблокирован",
    },
    { href: routes.settings("agent"), label: "Агент" },
    {
      href: withDemo(routes.settings("agent"), "limit-low"),
      label: "Агент: лимит почти исчерпан",
    },
    { href: routes.settings("shortcuts"), label: "Виджет и клавиши" },
    {
      href: withDemo(routes.settings("shortcuts"), "recording"),
      label: "Клавиши: запись сочетания",
    },
    { href: routes.settings("privacy"), label: "Приватность и хранение" },
    { href: routes.settings("integrations"), label: "Интеграции" },
    {
      href: withDemo(routes.settings("integrations"), "outline-broken"),
      label: "Интеграции: ключ Outline не работает",
    },
    {
      href: withDemo(routes.settings("integrations"), "confirm-disconnect"),
      label: "Интеграции: отключить GitHub?",
    },
    {
      href: withDemo(routes.settings("integrations"), "github-disconnected"),
      label: "Интеграции: GitHub отключён, тост «Вернуть»",
    },
  ],
  title: "Настройки",
};
