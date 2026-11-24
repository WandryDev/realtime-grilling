"use client";

import { StartWidget } from "@/features/call-widget/screens/start-widget";

/*
 * Start widget screens of the /dev catalog whose buttons need a handler,
 * which a server page can't pass to a client component.
 */

/** «Открыть настройки» of the catalog: nothing to open. */
function openNothing() {
  // A preview only.
}

const NO_ACCESS_ERROR = {
  description:
    "Разрешите Grill доступ к микрофону в системных настройках и нажмите «Начать» ещё раз.",
  onOpenSettings: openNothing,
  title: "Нет доступа к микрофону",
};

/** «Начать», and the microphone access was taken back. */
export function StartNoAccessDemo() {
  return <StartWidget startError={NO_ACCESS_ERROR} state="prompt" />;
}
