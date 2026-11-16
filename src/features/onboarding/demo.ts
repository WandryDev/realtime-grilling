import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

const permissions = routes.onboarding("permissions");
const speech = routes.onboarding("speech");
const agent = routes.onboarding("agent");

/** Screens and forced states of this area, listed in the dev navigator. */
export const onboardingDemo: DemoGroup = {
  links: [
    { href: routes.onboarding(), label: "01 Приветствие" },
    { href: permissions, label: "02 Разрешения" },
    { href: withDemo(permissions, "granted"), label: "02 — всё разрешено" },
    { href: withDemo(permissions, "denied"), label: "02 — отказано" },
    {
      href: withDemo(permissions, "unknown"),
      label: "02 — системный звук не узнать",
    },
    { href: withDemo(permissions, "windows"), label: "02 — Windows" },
    { href: speech, label: "03 Модель речи" },
    { href: withDemo(speech, "downloading"), label: "03 — скачивание" },
    { href: withDemo(speech, "paused"), label: "03 — на паузе" },
    { href: withDemo(speech, "checking"), label: "03 — проверка" },
    { href: withDemo(speech, "ready"), label: "03 — модель готова" },
    { href: withDemo(speech, "no-space"), label: "03 — нет места" },
    { href: withDemo(speech, "no-network"), label: "03 — нет сети" },
    { href: agent, label: "04 Агент" },
    { href: withDemo(agent, "ready"), label: "04 — готов к работе" },
    { href: withDemo(agent, "needs-login"), label: "04 — нужен вход" },
    {
      href: withDemo(agent, "awaiting-code"),
      label: "04 — ждём код из браузера",
    },
    { href: withDemo(agent, "not-installed"), label: "04 — не установлен" },
    { href: withDemo(agent, "installing"), label: "04 — установка" },
    { href: withDemo(agent, "install-error"), label: "04 — ошибка установки" },
    { href: withDemo(agent, "error"), label: "04 — не отвечает" },
  ],
  title: "Онбординг 01–04",
};
