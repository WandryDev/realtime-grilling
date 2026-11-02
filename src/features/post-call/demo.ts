import { CURRENT_CALL_ID } from "@/data/call-session";
import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

/** Screens and forced states of this area, listed in the dev navigator. */
export const postCallDemo: DemoGroup = {
  links: [
    { href: routes.history(), label: "История — все звонки" },
    { href: routes.history("telemedia"), label: "История — проект Телемедиа" },
    {
      href: routes.history("rhythm"),
      label: "История — новый проект, звонков нет",
    },
    {
      href: withDemo(routes.history(), "search"),
      label: "История — поиск «amoCRM»",
    },
    { href: routes.callSummary(CURRENT_CALL_ID), label: "Итоги звонка" },
    {
      href: withDemo(routes.callSummary(CURRENT_CALL_ID), "processing"),
      label: "Итоги — сборка итогов и тост",
    },
    { href: routes.callTasks(CURRENT_CALL_ID), label: "Карточки задач" },
    { href: routes.callProposals(CURRENT_CALL_ID), label: "Ревью предложений" },
    {
      href: withDemo(routes.callProposals(CURRENT_CALL_ID), "done"),
      label: "Ревью — всё разобрано",
    },
    { href: routes.callTranscript(CURRENT_CALL_ID), label: "Расшифровка" },
    {
      href: routes.callTranscript(CURRENT_CALL_ID, "phone"),
      label: "Расшифровка — момент вопроса",
    },
    {
      href: withDemo(
        routes.callTranscript(CURRENT_CALL_ID),
        "delete-recording"
      ),
      label: "Расшифровка — удаление записи",
    },
    {
      href: routes.callSummary("unknown-call"),
      label: "Звонок не найден",
    },
  ],
  title: "После звонка",
};
