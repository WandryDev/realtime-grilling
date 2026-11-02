import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CallDetailsScreen } from "@/features/post-call/screens/call-details-screen";
import { CallHistoryScreen } from "@/features/post-call/screens/call-history-screen";
import { CallSummaryScreen } from "@/features/post-call/screens/call-summary-screen";
import { ProposalsReviewScreen } from "@/features/post-call/screens/proposals-review-screen";
import { TaskCardsScreen } from "@/features/post-call/screens/task-cards-screen";

const MOMENT_LABEL = /Здесь спросили/u;
const OLGA_SOURCE = /сказала Ольга/u;
const FIRST_CALL = /Приём звонков, Интеграция с CRM/u;

describe("CallSummaryScreen", () => {
  it("shows the steps while the summary is built", () => {
    render(<CallSummaryScreen state="processing" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Собираю итоги" })
    ).toBeTruthy();
    expect(screen.getByText("Собираю карточки задач")).toBeTruthy();
    // Task cards are not ready yet: no link
    expect(screen.queryByRole("link", { name: "Карточки задач" })).toBeNull();
  });

  it("shows the summary when ready", () => {
    render(<CallSummaryScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Итоги звонка" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Не успели спросить" })
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Разобрать предложения" })
    ).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("draws the saved toast", () => {
    render(<CallSummaryScreen toast />);

    expect(
      within(screen.getByRole("status")).getByText("Итоги сохранены")
    ).toBeTruthy();
  });
});

describe("TaskCardsScreen", () => {
  it("renders the card and the open source quote", () => {
    render(<TaskCardsScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Карточки задач" })
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { expanded: true, name: OLGA_SOURCE })
    ).toBeTruthy();
    expect(screen.getByText("Основной сценарий")).toBeTruthy();
  });
});

describe("ProposalsReviewScreen", () => {
  it("lists pending, edited and decided proposals", () => {
    render(<ProposalsReviewScreen />);

    expect(screen.getByText("разобрано 3 из 7")).toBeTruthy();
    const editor = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Новый текст",
    });
    expect(editor.value).toBe(
      "amoCRM, администрирует подрядчик «Интегратор Плюс». API-ключ выдаёт Игорь Савчук"
    );
    expect(screen.getAllByRole("button", { name: "Отменить" })).toHaveLength(2);
  });

  it("shows the done state", () => {
    render(<ProposalsReviewScreen state="done" />);

    expect(screen.getByRole("heading", { name: "Всё разобрано" })).toBeTruthy();
  });
});

describe("CallHistoryScreen", () => {
  it("lists the project calls by month", () => {
    render(<CallHistoryScreen />);

    expect(screen.getByRole("heading", { name: "Октябрь" })).toBeTruthy();
    expect(screen.getByRole("link", { name: FIRST_CALL })).toBeTruthy();
  });

  it("shows search results", () => {
    render(<CallHistoryScreen query="amoCRM" />);

    expect(screen.getByText("4 звонка, 9 совпадений")).toBeTruthy();
    const search = screen.getByRole<HTMLInputElement>("searchbox", {
      name: "Поиск по звонкам",
    });
    expect(search.value).toBe("amoCRM");
  });

  it("shows the empty state of a new project", () => {
    render(<CallHistoryScreen projectId="rhythm" />);

    expect(
      screen.getByRole("heading", { name: "Звонков пока не было" })
    ).toBeTruthy();
  });
});

describe("CallDetailsScreen", () => {
  it("renders the transcript and the player", () => {
    render(<CallDetailsScreen />);

    expect(screen.getByRole("region", { name: "Запись звонка" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Пауза" })).toBeTruthy();
    expect(screen.queryByLabelText(MOMENT_LABEL)).toBeNull();
  });

  it("highlights the moment of a question", () => {
    render(<CallDetailsScreen momentId="phone" />);

    expect(screen.getByLabelText(MOMENT_LABEL)).toBeTruthy();
    expect(screen.getByText("29:12")).toBeTruthy();
  });

  it("draws the delete dialog over a paused player", () => {
    render(<CallDetailsScreen dialog="delete-recording" />);

    expect(
      screen.getByRole("alertdialog", { name: "Удалить запись звонка?" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Слушать" })).toBeTruthy();
  });
});
