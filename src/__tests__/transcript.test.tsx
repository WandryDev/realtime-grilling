import { AvatarFallback } from "@grill/ui/avatar";
import { Bubble } from "@grill/ui/bubble";
import { Marker, MarkerAction, MarkerContent } from "@grill/ui/marker";
import {
  Message,
  MessageAvatar,
  MessageContent,
  MessageFooter,
  MessageHeader,
  MessageSpeaking,
  MessageTyping,
} from "@grill/ui/message";
import { TopicDivider } from "@grill/ui/topic-divider";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

describe("Message", () => {
  it("marks the speaker as talking with a ring and a visible label", () => {
    const { container } = render(
      <Message>
        <MessageAvatar speaking>
          <AvatarFallback>К</AvatarFallback>
        </MessageAvatar>
        <MessageContent>
          <MessageHeader>
            Клиент
            <MessageSpeaking />
          </MessageHeader>
          <Bubble variant="card">
            Подрядчик
            <MessageTyping />
          </Bubble>
        </MessageContent>
      </Message>
    );

    expect(
      container
        .querySelector("[data-slot=avatar]")
        ?.hasAttribute("data-speaking")
    ).toBe(true);
    expect(screen.getByText("говорит")).toBeDefined();
    expect(
      container
        .querySelector("[data-slot=message-typing]")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("keeps the footer status readable and its marker decorative", () => {
    const { container } = render(
      <MessageFooter status="answered">ответ на вопрос</MessageFooter>
    );

    expect(screen.getByText("ответ на вопрос")).toBeDefined();
    expect(
      container
        .querySelector("[data-slot=message-footer-icon]")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("renders a time link inside a contradiction footer as a button", async () => {
    const onJump = vi.fn();
    render(
      <MessageFooter status="contradiction">
        противоречит сказанному в{" "}
        <button onClick={onJump} type="button">
          12:06
        </button>
      </MessageFooter>
    );

    await userEvent.click(screen.getByRole("button", { name: "12:06" }));
    expect(onJump).toHaveBeenCalledOnce();
  });
});

describe("Marker", () => {
  it("exposes the system message action as a real button", async () => {
    const onRetry = vi.fn();
    render(
      <Marker>
        <MarkerContent>Агент не ответил за 20 с</MarkerContent>
        <MarkerAction onClick={onRetry}>Повторить</MarkerAction>
      </Marker>
    );

    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("TopicDivider", () => {
  it("announces the current topic and keeps the dot decorative", () => {
    const { container } = render(
      <TopicDivider current time="12:21">
        Интеграция с CRM
      </TopicDivider>
    );

    expect(screen.getByText(", текущая тема")).toBeDefined();
    expect(
      container
        .querySelector("[data-slot=topic-divider-dot]")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
    expect(container.querySelector("time")?.textContent).toBe("12:21");
  });

  it("has no dot for past topics", () => {
    const { container } = render(
      <TopicDivider time="12:01">Приём звонков</TopicDivider>
    );

    expect(container.querySelector("[data-slot=topic-divider-dot]")).toBeNull();
  });
});
