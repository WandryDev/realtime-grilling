import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CallScreen } from "@/features/call/screens/call-screen";
import type { CallScreenState } from "@/features/call/types";

const MAIN_QUESTION =
  "Записывать в CRM сам звонок или только факт и длительность?";

const CASES: [CallScreenState, string][] = [
  ["reference", MAIN_QUESTION],
  ["starting", "Слушаю. Первые вопросы появятся, когда станет понятна тема"],
  [
    "question-hover",
    "Используем текущую интеграцию с amoCRM или делаем новую?",
  ],
  ["question-pinned", "Закреплён вами в 12:24"],
  ["transcript-collapsed", MAIN_QUESTION],
  ["final-check", "Похоже, разговор идёт к концу"],
  ["mic-released", "Микрофон больше не используется. Завершить звонок?"],
  ["agent-timeout", "Claude Code не отвечает уже 2 минуты"],
  ["limit-reached", "Лимит подписки Claude исчерпан до 15:00"],
  ["transcript-lag", "Расшифровка отстаёт на 40 секунд"],
  ["no-system-audio", "Не слышу собеседников"],
  ["github-unavailable", "Подключить снова"],
  ["finishing", "Собираю итоги…"],
];

describe("CallScreen", () => {
  it.each(CASES)("renders the %s state", (state, text) => {
    render(<CallScreen state={state} />);

    expect(screen.getByText("Телемедиа")).toBeTruthy();
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
  });

  it("says «слушаю» once: the empty state, not the panel header too", () => {
    const { unmount } = render(<CallScreen state="starting" />);
    expect(screen.queryByText("слушаю")).toBeNull();
    unmount();

    render(<CallScreen />);
    expect(screen.getByText("слушаю")).toBeTruthy();
  });

  it("shows the topic headings of the reference screen", () => {
    render(<CallScreen />);

    for (const name of ["Интеграция с CRM", "Приём звонков", "Без темы"]) {
      expect(screen.getByRole("heading", { name })).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Расшифровка" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Контекст" })).toBeTruthy();
  });

  it("swaps the transcript for the rail when collapsed", () => {
    render(<CallScreen state="transcript-collapsed" />);

    expect(screen.queryByRole("heading", { name: "Расшифровка" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Развернуть расшифровку" })
    ).toBeTruthy();
  });

  it("announces agent failures as alerts", () => {
    render(<CallScreen state="agent-timeout" />);

    expect(
      within(screen.getByRole("alert")).getByRole("button", {
        name: "Повторить",
      })
    ).toBeTruthy();
  });

  it("hides the end button and stops recording while finishing", () => {
    render(<CallScreen state="finishing" />);

    expect(
      screen.getByRole("timer", { name: "Запись остановлена, 39:04" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Завершить" })).toBeNull();
  });
});
