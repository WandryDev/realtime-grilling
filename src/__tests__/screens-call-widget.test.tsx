import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CompactOverlay } from "@/features/call-widget/screens/compact-overlay";
import { MicReleasedWidget } from "@/features/call-widget/screens/mic-released-widget";
import { StartWidget } from "@/features/call-widget/screens/start-widget";

const REMOVE_OLGA = /Убрать.*Ольга/u;

describe("StartWidget", () => {
  it("asks to start the call with the last project and people", () => {
    render(<StartWidget />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Начать звонок?" })
    ).toBeTruthy();
    expect(screen.getByText("Телемедиа")).toBeTruthy();
    expect(screen.getByRole("button", { name: REMOVE_OLGA })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Начать" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("Найти проект")).toBeNull();
    // The 24px avatar of a participant holds one letter.
    const initials = [
      ...document.querySelectorAll(
        "[data-slot=person-chip] [data-slot=avatar-fallback]"
      ),
    ].map((fallback) => fallback.textContent);
    expect(initials.length).toBeGreaterThan(0);
    for (const initial of initials) {
      expect(Array.from(initial ?? "")).toHaveLength(1);
    }
  });

  it("draws the project list open while choosing a project", () => {
    render(<StartWidget state="choosing-project" />);

    expect(screen.getByPlaceholderText("Найти проект")).toBeTruthy();
    expect(screen.getByText("Ветклиника Лапа")).toBeTruthy();
    expect(screen.getByText("Звонок без проекта")).toBeTruthy();
  });

  it("shows the brief being prepared after the start", () => {
    render(<StartWidget state="launching" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Готовлю бриф" })
    ).toBeTruthy();
    expect(screen.getByText("12 док.")).toBeTruthy();
    expect(
      screen.getByRole("progressbar", { name: "Готовность брифа" })
    ).toBeTruthy();
  });

  it("collapses into a pill that can still start the call", () => {
    render(<StartWidget state="collapsed" />);

    expect(screen.getByText("звонок в Zoom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Начать" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("MicReleasedWidget", () => {
  it("offers to end the call with a countdown", () => {
    render(<MicReleasedWidget />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Микрофон больше не используется. Завершить звонок?",
      })
    ).toBeTruthy();
    expect(screen.getByText("6:48")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Завершить" })).toBeTruthy();
  });
});

describe("CompactOverlay", () => {
  it("shows the current topic and its top questions", () => {
    render(<CompactOverlay />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Интеграция с CRM" })
    ).toBeTruthy();
    expect(screen.getByText("Новый, только что")).toBeTruthy();
    expect(screen.getAllByRole("group")).toHaveLength(3);
    expect(screen.getByText("слушаю")).toBeTruthy();
  });

  it("says it is hidden from screen sharing only when it is", () => {
    const { unmount } = render(<CompactOverlay />);
    expect(screen.getByText("не видно в демонстрации")).toBeTruthy();
    unmount();

    render(<CompactOverlay hiddenFromShare={false} />);
    expect(screen.queryByText("не видно в демонстрации")).toBeNull();
    expect(screen.getByText("слушаю")).toBeTruthy();
  });

  it("switches to the final check with topics over the questions", () => {
    render(<CompactOverlay state="final-check" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Финальная проверка" })
    ).toBeTruthy();
    expect(screen.getAllByText("Приём звонков")).toHaveLength(2);
    expect(screen.getByText("ещё 1 в окне")).toBeTruthy();
  });

  it("collapses into a pill with a new question card", () => {
    render(<CompactOverlay state="collapsed" />);

    expect(screen.getByLabelText("5 открытых вопросов")).toBeTruthy();
    expect(screen.getByText("Новый вопрос")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Закрыть" })).toBeTruthy();
  });
});
