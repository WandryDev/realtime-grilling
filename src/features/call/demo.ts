import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

const CALL = routes.call();

/*
 * Screens and forced states of this area, listed in the dev navigator.
 * /call plays the whole call by itself (about a minute: listening, topics,
 * final check, the mic panel); the "сразу" links skip ahead. Failures can't
 * be reached by clicking.
 */
export const callDemo: DemoGroup = {
  links: [
    { href: CALL, label: "Окно звонка, с начала" },
    { href: withDemo(CALL, "reference"), label: "Сразу середина звонка" },
    { href: withDemo(CALL, "final-check"), label: "Сразу финальная проверка" },
    { href: withDemo(CALL, "mic-released"), label: "Микрофон освободился" },
    {
      href: withDemo(CALL, "agent-timeout"),
      label: "Ошибка: агент не отвечает",
    },
    {
      href: withDemo(CALL, "limit-reached"),
      label: "Ошибка: лимит подписки",
    },
    {
      href: withDemo(CALL, "transcript-lag"),
      label: "Ошибка: расшифровка отстаёт",
    },
    {
      href: withDemo(CALL, "no-system-audio"),
      label: "Ошибка: нет системного звука",
    },
    {
      href: withDemo(CALL, "github-unavailable"),
      label: "Ошибка: GitHub недоступен",
    },
  ],
  title: "Звонок, окно",
};
