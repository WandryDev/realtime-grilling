import type { DemoGroup } from "@/features/dev/demo-link";
import { routes, withDemo } from "@/lib/routes";

const widget = routes.startWidget();
const overlay = routes.overlay();

/** Screens and forced states of this area, listed in the dev navigator. */
export const callWidgetDemo: DemoGroup = {
  links: [
    { href: widget, label: "01 Виджет старта" },
    { href: withDemo(widget, "launching"), label: "01 — запуск, бриф" },
    { href: withDemo(widget, "collapsed"), label: "01 — свёрнут в пилюлю" },
    { href: withDemo(widget, "hidden"), label: "01 — скрыт" },
    {
      href: withDemo(overlay, "mic-released"),
      label: "05 Микрофон освободился",
    },
    { href: overlay, label: "06 Компактный оверлей" },
    {
      href: withDemo(overlay, "final-check"),
      label: "06 — финальная проверка",
    },
    {
      href: withDemo(overlay, "collapsed"),
      label: "06 — свёрнут, новый вопрос",
    },
  ],
  title: "Звонок, виджеты",
};
