import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CallWidgetAddPerson } from "@/components/ui/call-widget";
import {
  NavItem,
  NavItemError,
  NavItemLabel,
  NavItemRecording,
  NavMenu,
} from "@/components/ui/nav-item";
import {
  WindowControls,
  WindowTitle,
  WindowTitlebar,
  WindowTitlebarEnd,
  WindowTitlebarStart,
  WindowTrafficLights,
} from "@/components/ui/window-titlebar";

const RECORDING_NAME = /идёт запись/u;
const INTEGRATIONS_ERROR_NAME = /Интеграции.*ошибка подключения/u;

describe("WindowControls", () => {
  it("calls the callback of each button, found by its accessible name", async () => {
    const user = userEvent.setup();
    const onMinimize = vi.fn();
    const onMaximize = vi.fn();
    const onClose = vi.fn();

    render(
      <WindowControls
        onClose={onClose}
        onMaximize={onMaximize}
        onMinimize={onMinimize}
      />
    );

    await user.click(screen.getByRole("button", { name: "Свернуть" }));
    await user.click(screen.getByRole("button", { name: "Развернуть" }));
    await user.click(screen.getByRole("button", { name: "Закрыть" }));

    expect(onMinimize).toHaveBeenCalledOnce();
    expect(onMaximize).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("WindowTitlebar", () => {
  it("is a deep Tauri drag region and its buttons are not", () => {
    render(
      <WindowTitlebar data-testid="titlebar">
        <WindowTitlebarStart>
          <WindowTrafficLights />
          <WindowTitle>Телемедиа</WindowTitle>
        </WindowTitlebarStart>
        <WindowTitlebarEnd>
          <WindowControls />
        </WindowTitlebarEnd>
      </WindowTitlebar>
    );

    const titlebar = screen.getByTestId("titlebar");
    expect(titlebar.getAttribute("data-tauri-drag-region")).toBe("deep");

    for (const button of screen.getAllByRole("button")) {
      expect(button.hasAttribute("data-tauri-drag-region")).toBe(false);
    }
  });

  it("hides the decorative traffic lights", () => {
    const { container } = render(<WindowTrafficLights />);

    const lights = container.querySelector("[data-slot=window-traffic-lights]");
    expect(lights?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("NavItem", () => {
  it("marks only the active item as the current page", () => {
    render(
      <NavMenu aria-label="Разделы">
        <NavItem active href="/calls">
          <NavItemLabel>Звонки</NavItemLabel>
        </NavItem>
        <NavItem href="/projects">
          <NavItemLabel>Проекты</NavItemLabel>
        </NavItem>
      </NavMenu>
    );

    expect(screen.getByRole("navigation", { name: "Разделы" })).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Звонки" }).getAttribute("aria-current")
    ).toBe("page");
    expect(
      screen.getByRole("link", { name: "Проекты" }).hasAttribute("aria-current")
    ).toBe(false);
  });

  it("names the recording dot and the error icon", () => {
    render(
      <>
        <NavItem href="/calls">
          <NavItemLabel>Звонки</NavItemLabel>
          <NavItemRecording />
        </NavItem>
        <NavItem href="/integrations">
          <NavItemLabel>Интеграции</NavItemLabel>
          <NavItemError aria-label="ошибка подключения" />
        </NavItem>
      </>
    );

    expect(screen.getByRole("link", { name: RECORDING_NAME })).toBeDefined();
    expect(
      screen.getByRole("img", { name: "ошибка подключения" })
    ).toBeDefined();
    expect(
      screen.getByRole("link", { name: INTEGRATIONS_ERROR_NAME })
    ).toBeDefined();
  });
});

describe("CallWidgetAddPerson", () => {
  it("has an accessible name", () => {
    render(<CallWidgetAddPerson />);

    expect(
      screen.getByRole("button", { name: "Добавить участника" })
    ).toBeDefined();
  });
});
