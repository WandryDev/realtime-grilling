import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

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
});
