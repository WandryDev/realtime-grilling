import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

/** Screens and forced states of this area, listed in the dev navigator. */
export const onboardingIntegrationsDemo: DemoGroup = {
  links: [
    { href: routes.onboarding("integrations"), label: "05 Интеграции" },
    {
      href: withDemo(routes.onboarding("integrations"), "partial"),
      label: "05 Интеграции — частично подключено",
    },
    { href: routes.onboardingIntegration("github"), label: "05a GitHub" },
    {
      href: withDemo(routes.onboardingIntegration("github"), "expired"),
      label: "05a GitHub — код истёк",
    },
    { href: routes.onboardingIntegration("outline"), label: "05b Outline" },
    {
      href: withDemo(routes.onboardingIntegration("outline"), "rejected"),
      label: "05b Outline — ключ не подошёл",
    },
    { href: routes.onboardingIntegration("clickup"), label: "05c ClickUp" },
    {
      href: withDemo(routes.onboardingIntegration("clickup"), "error"),
      label: "05c ClickUp — ошибка входа",
    },
    { href: routes.onboarding("done"), label: "06 Готово" },
  ],
  title: "Онбординг 05–06",
};
