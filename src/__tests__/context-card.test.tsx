import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  ContextCard,
  ContextCardHeader,
  ContextCardOpen,
  ContextCardQuestionLink,
  ContextCardSearching,
  ContextCardSource,
  ContextCardStatus,
} from "@/components/ui/context-card";

describe("ContextCard", () => {
  it("is an article with a labelled open-in-source link", () => {
    render(
      <ContextCard aria-label="Outline">
        <ContextCardHeader>
          <ContextCardSource source="outline" />
          <ContextCardOpen href="https://outline.example/doc" />
        </ContextCardHeader>
      </ContextCard>
    );

    expect(screen.getByRole("article", { name: "Outline" })).toBeDefined();
    const link = screen.getByRole("link", { name: "Открыть в источнике" });
    expect(link.getAttribute("href")).toBe("https://outline.example/doc");
  });

  it("hides the source logo tile from assistive tech", () => {
    const { container } = render(<ContextCardSource source="github" />);

    expect(
      container
        .querySelector("[data-slot=context-card-source]")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("renders the question link as a button by default", async () => {
    const onOpen = vi.fn();
    render(
      <ContextCardQuestionLink onClick={onOpen}>
        к вопросу про запись звонка в CRM
      </ContextCardQuestionLink>
    );

    const button = screen.getByRole("button", {
      name: "к вопросу про запись звонка в CRM",
    });
    expect(button.getAttribute("type")).toBe("button");
    await userEvent.click(button);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("can render the question link as an anchor", () => {
    render(
      <ContextCardQuestionLink render={<a href="#q-12" />}>
        к вопросу про старшего смены
      </ContextCardQuestionLink>
    );

    const link = screen.getByRole("link", {
      name: "к вопросу про старшего смены",
    });
    expect(link.hasAttribute("type")).toBe(false);
  });
});

describe("ContextCardStatus", () => {
  it("names the error dot for screen readers", () => {
    render(<ContextCardStatus status="error" />);

    expect(screen.getByText("ошибка").className).toContain("sr-only");
  });

  it("fades “новое” out unless told to stay", () => {
    const { rerender } = render(<ContextCardStatus status="new" />);
    expect(screen.getByText("новое").parentElement?.className).toContain(
      "animate-out"
    );

    rerender(<ContextCardStatus fade={false} status="new" />);
    expect(screen.getByText("новое").parentElement?.className).not.toContain(
      "animate-out"
    );
  });
});

describe("ContextCardSearching", () => {
  it("is a status region whose name is what the agent searches for", () => {
    render(
      <ContextCardSearching>Ищу в Outline «старший смены»</ContextCardSearching>
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Ищу в Outline «старший смены»");
  });
});
