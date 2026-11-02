import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";
import { ActionButton } from "@/features/call-widget/components/action-button";
import { StepBackButton } from "@/features/onboarding/components/step-links";
import { linkButtonProps } from "@/lib/link-button";

function TestLink({ children, href }: { children?: ReactNode; href: string }) {
  return (
    <a data-testid="custom-link" href={href}>
      {children}
    </a>
  );
}

describe("linkButtonProps", () => {
  it("renders a Button with an href as a link, not a button", () => {
    render(<Button {...linkButtonProps("/project/new")}>Новый проект</Button>);
    const link = screen.getByRole("link", { name: "Новый проект" });
    expect(link.getAttribute("href")).toBe("/project/new");
    expect(link.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps a plain button without an href (the /dev previews)", () => {
    render(<Button {...linkButtonProps()}>Новый проект</Button>);
    expect(screen.getByRole("button", { name: "Новый проект" })).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders through another link component when given one", () => {
    render(
      <Button {...linkButtonProps("/widget", TestLink)}>Начать звонок</Button>
    );
    const link = screen.getByRole("link", { name: "Начать звонок" });
    expect(link.dataset.testid).toBe("custom-link");
    expect(link.getAttribute("href")).toBe("/widget");
  });

  it("is what the widget and onboarding link buttons use", () => {
    render(
      <>
        <ActionButton href="/call">Открыть звонок</ActionButton>
        <StepBackButton href="/onboarding" />
      </>
    );
    expect(
      screen.getByRole("link", { name: "Открыть звонок" }).getAttribute("href")
    ).toBe("/call");
    expect(screen.getAllByRole("link")).toHaveLength(2);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
