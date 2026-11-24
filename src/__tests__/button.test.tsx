import { Button } from "@grill/ui/button";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const LOADING_NAME = /Запускаю/u;

describe("Button", () => {
  it("renders its label as an accessible button", () => {
    render(<Button>Start call</Button>);

    expect(screen.getByRole("button", { name: "Start call" })).toBeDefined();
  });

  it("calls onClick when pressed", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Start call</Button>);

    await userEvent.click(screen.getByRole("button", { name: "Start call" }));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it("does not call onClick when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Start call
      </Button>
    );

    await userEvent.click(screen.getByRole("button", { name: "Start call" }));

    expect(onClick).not.toHaveBeenCalled();
  });

  it("is disabled and shows a status while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Запускаю
      </Button>
    );

    const button = screen.getByRole("button", { name: LOADING_NAME });
    await userEvent.click(button);

    expect(onClick).not.toHaveBeenCalled();
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status", { name: "Загрузка" })).toBeDefined();
  });

  it("swaps the icon for the spinner on a loading icon button", () => {
    render(
      <Button aria-label="Ещё" loading size="icon">
        <svg data-testid="icon" />
      </Button>
    );

    expect(screen.queryByTestId("icon")).toBeNull();
    expect(screen.getByRole("status")).toBeDefined();
  });
});
