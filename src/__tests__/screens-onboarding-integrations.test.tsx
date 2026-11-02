import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ClickUpConnectScreen } from "@/features/onboarding/screens/clickup-connect-screen";
import { DoneScreen } from "@/features/onboarding/screens/done-screen";
import { GitHubConnectScreen } from "@/features/onboarding/screens/github-connect-screen";
import { IntegrationsScreen } from "@/features/onboarding/screens/integrations-screen";
import { OutlineConnectScreen } from "@/features/onboarding/screens/outline-connect-screen";

const CHECKING_KEY = /Проверяем ключ/u;

const heading = (name: string) =>
  screen.getByRole("heading", { level: 1, name });

describe("IntegrationsScreen", () => {
  it("offers to connect every service and to skip the step", () => {
    render(<IntegrationsScreen state="empty" />);

    expect(heading("Подключите рабочие сервисы")).toBeDefined();
    for (const name of ["GitHub", "Outline", "ClickUp"]) {
      expect(
        screen.getByRole("button", { name: `Подключить ${name}` })
      ).toBeDefined();
    }
    expect(screen.getByRole("button", { name: "Пропустить" })).toBeDefined();
  });

  it("shows each service status once some are touched", () => {
    render(<IntegrationsScreen state="partial" />);

    expect(screen.getByText("Подключено")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Исправить Outline" })
    ).toBeDefined();
    expect(screen.getByText("Ждём браузер")).toBeDefined();
    expect(screen.getByRole("button", { name: "Продолжить" })).toBeDefined();
  });
});

describe("GitHubConnectScreen", () => {
  it("reads the device code as one word and lists the steps", () => {
    render(<GitHubConnectScreen state="code" />);

    expect(heading("Подключение GitHub")).toBeDefined();
    const code = screen.getByRole("region", { name: "Код устройства" });
    expect(within(code).getByText("WDJB-MJHT")).toBeDefined();
    expect(
      within(code).getByRole("button", { name: "Скопировано" })
    ).toBeDefined();
    expect(
      within(screen.getByRole("list", { name: "Как подключить" })).getAllByRole(
        "listitem"
      )
    ).toHaveLength(3);
  });

  it("waits for the confirmation on github.com", () => {
    render(<GitHubConnectScreen state="waiting" />);

    expect(screen.getByRole("status").textContent).toContain(
      "Ждём подтверждения на github.com"
    );
  });

  it("shows the account and its repositories when connected", () => {
    render(<GitHubConnectScreen state="connected" />);

    expect(heading("GitHub подключён")).toBeDefined();
    expect(screen.getByText("dima-kapish")).toBeDefined();
    expect(screen.getByText("telemedia/backend")).toBeDefined();
    expect(screen.getByText("и ещё 9")).toBeDefined();
  });

  it("drops the copy button once the code expired", () => {
    render(<GitHubConnectScreen state="expired" />);

    expect(screen.getByText("Код истёк")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Скопировать" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Получить новый код" })
    ).toBeDefined();
  });
});

describe("OutlineConnectScreen", () => {
  it("labels the address and key fields", () => {
    render(<OutlineConnectScreen state="form" />);

    expect(heading("Подключение Outline")).toBeDefined();
    expect(screen.getByLabelText("Адрес Outline")).toHaveProperty(
      "value",
      "https://docs.pixel.agency"
    );
    expect(screen.getByLabelText("API-ключ")).toHaveProperty(
      "type",
      "password"
    );
  });

  it("locks the form while the key is checked", () => {
    render(<OutlineConnectScreen state="checking" />);

    const button = screen.getByRole("button", { name: CHECKING_KEY });
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("marks the key invalid and explains why", () => {
    render(<OutlineConnectScreen state="rejected" />);

    expect(screen.getByLabelText("API-ключ").getAttribute("aria-invalid")).toBe(
      "true"
    );
    expect(screen.getByRole("alert").textContent).toContain("Ключ не подошёл");
  });

  it("shows the team and its collections when connected", () => {
    render(<OutlineConnectScreen state="connected" />);

    expect(heading("Outline подключён")).toBeDefined();
    expect(screen.getByText("14 коллекций")).toBeDefined();
    expect(screen.getByText("Ветклиника Лапа")).toBeDefined();
  });
});

describe("ClickUpConnectScreen", () => {
  it("says what Grill may do before the browser opens", () => {
    render(<ClickUpConnectScreen state="intro" />);

    expect(heading("Подключение ClickUp")).toBeDefined();
    expect(
      screen.getByRole("region", { name: "Что сможет Grill" })
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Продолжить в браузере" })
    ).toBeDefined();
  });

  it("waits for the browser and can be cancelled", () => {
    render(<ClickUpConnectScreen state="waiting" />);

    expect(screen.getByText("Ждём ответа от ClickUp")).toBeDefined();
    expect(screen.getByRole("button", { name: "Отменить" })).toBeDefined();
  });

  it("shows the workspace and people when connected", () => {
    render(<ClickUpConnectScreen state="connected" />);

    expect(heading("ClickUp подключён")).toBeDefined();
    expect(screen.getByText("Андрей, разработчик")).toBeDefined();
  });

  it("announces the error with its code", () => {
    render(<ClickUpConnectScreen state="error" />);

    expect(heading("ClickUp не подключился")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain(
      "access_denied, 12:04"
    );
  });
});

describe("DoneScreen", () => {
  it("sums up the setup and offers to connect what was skipped", () => {
    render(<DoneScreen />);

    expect(heading("Grill готов к первому звонку")).toBeDefined();
    expect(screen.getByText("Агент Claude Code")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Подключить Outline" })
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Добавить первый проект" })
    ).toBeDefined();
  });
});
