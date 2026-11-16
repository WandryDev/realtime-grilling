import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppearScope } from "@/components/ui/appear";
import { Badge } from "@/components/ui/badge";
import {
  Question,
  QuestionAction,
  QuestionActions,
  QuestionAside,
  QuestionContent,
  QuestionDescription,
  QuestionTitle,
} from "@/components/ui/question";
import {
  QuestionHistory,
  QuestionHistoryContent,
  QuestionHistoryHeader,
  QuestionHistoryItem,
  QuestionHistoryList,
  QuestionHistoryQuestion,
  QuestionHistoryRestore,
  QuestionHistoryTime,
} from "@/components/ui/question-history";

describe("Question", () => {
  it("is a group named by its title", () => {
    render(
      <Question>
        <QuestionContent>
          <QuestionTitle>
            Сколько операторов работает в одну смену?
          </QuestionTitle>
        </QuestionContent>
      </Question>
    );

    expect(
      screen.getByRole("group", {
        name: "Сколько операторов работает в одну смену?",
      })
    ).toBeDefined();
  });

  it("keeps hover actions reachable by keyboard", async () => {
    const user = userEvent.setup();
    const onHide = vi.fn();
    render(
      <Question>
        <QuestionContent>
          <QuestionTitle>
            Карточку открывать только по номеру телефона?
          </QuestionTitle>
        </QuestionContent>
        <QuestionActions>
          <QuestionAction>Уже спросил</QuestionAction>
          <QuestionAction>Закрепить</QuestionAction>
          <QuestionAction onClick={onHide}>Скрыть</QuestionAction>
        </QuestionActions>
      </Question>
    );

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Уже спросил" })
    );
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Скрыть" })
    );
    await user.keyboard("{Enter}");
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("marks the answered state and shows its status and quote", () => {
    render(
      <Question state="answered">
        <QuestionContent>
          <QuestionTitle>Сколько операторов будет на старте?</QuestionTitle>
          <QuestionDescription>«Пятеро»</QuestionDescription>
        </QuestionContent>
        <QuestionAside>
          <Badge variant="confirmed">отвечен</Badge>
        </QuestionAside>
      </Question>
    );

    const question = screen.getByRole("group", {
      name: "Сколько операторов будет на старте?",
    });
    expect(question.dataset.state).toBe("answered");
    expect(question.textContent).toContain("отвечен");
    expect(screen.getByText("«Пятеро»").className).toContain("text-foreground");
  });

  it("plays the exit out of reach and reports when it is over", () => {
    const onExited = vi.fn();
    render(
      <Question leaving onExited={onExited} state="answered">
        <QuestionContent>
          <QuestionTitle>Сколько операторов будет на старте?</QuestionTitle>
        </QuestionContent>
      </Question>
    );

    expect(screen.queryByRole("group")).toBeNull();
    const question = screen.getByRole("group", { hidden: true });
    expect(question.hasAttribute("data-leaving")).toBe(true);
    expect(question.hasAttribute("inert")).toBe(true);
    // Nothing animates in jsdom: the list may drop the row at once
    expect(onExited).toHaveBeenCalledOnce();
  });

  it("enters only when it arrives after the screen opened", () => {
    const row = (title: string) => (
      <Question key={title}>
        <QuestionContent>
          <QuestionTitle>{title}</QuestionTitle>
        </QuestionContent>
      </Question>
    );
    const { rerender } = render(
      <AppearScope>{[row("Сколько операторов?")]}</AppearScope>
    );
    rerender(
      <AppearScope>
        {[row("Сколько операторов?"), row("Есть ли очередь?")]}
      </AppearScope>
    );

    const [first, second] = screen.getAllByRole("group");
    expect(first.hasAttribute("data-entering")).toBe(false);
    expect(second.hasAttribute("data-entering")).toBe(true);
  });
});

describe("QuestionHistory", () => {
  it("labels the list with its header and exposes each status", () => {
    render(
      <QuestionHistory>
        <QuestionHistoryHeader count={2}>
          Обсудили в этой теме
        </QuestionHistoryHeader>
        <QuestionHistoryList>
          <QuestionHistoryItem status="answered">
            <QuestionHistoryContent>
              <QuestionHistoryQuestion>
                Какая CRM используется?
              </QuestionHistoryQuestion>
            </QuestionHistoryContent>
            <QuestionHistoryTime>12:21</QuestionHistoryTime>
          </QuestionHistoryItem>
          <QuestionHistoryItem status="hidden">
            <QuestionHistoryContent>
              <QuestionHistoryQuestion>
                Какой бюджет на телефонию в месяц?
              </QuestionHistoryQuestion>
            </QuestionHistoryContent>
            <QuestionHistoryRestore />
          </QuestionHistoryItem>
        </QuestionHistoryList>
      </QuestionHistory>
    );

    const list = screen.getByRole("list", { name: "Обсудили в этой теме" });
    const [answered, hidden] = screen.getAllByRole("listitem");

    expect(list).toBeDefined();
    expect(answered.textContent).toContain("Отвечен:");
    expect(hidden.textContent).toContain("Скрыт вами:");
  });

  it("calls the restore handler and describes the button by its question", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    render(
      <QuestionHistoryList>
        <QuestionHistoryItem status="unanswered">
          <QuestionHistoryContent>
            <QuestionHistoryQuestion>
              Что происходит, если все операторы заняты?
            </QuestionHistoryQuestion>
          </QuestionHistoryContent>
          <QuestionHistoryRestore onClick={onRestore} />
        </QuestionHistoryItem>
      </QuestionHistoryList>
    );

    const restore = screen.getByRole("button", { name: "Вернуть" });
    const question = screen.getByText(
      "Что происходит, если все операторы заняты?"
    );

    expect(question.id).not.toBe("");
    expect(restore.getAttribute("aria-describedby")).toBe(question.id);

    await user.click(restore);
    expect(onRestore).toHaveBeenCalledOnce();
  });
});
