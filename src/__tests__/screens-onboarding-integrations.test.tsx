import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ClickUpConnectScreen } from "@/features/onboarding/screens/clickup-connect-screen";
import { DoneScreen } from "@/features/onboarding/screens/done-screen";
import { GitHubConnectScreen } from "@/features/onboarding/screens/github-connect-screen";
import { IntegrationsScreen } from "@/features/onboarding/screens/integrations-screen";
import { OutlineConnectScreen } from "@/features/onboarding/screens/outline-connect-screen";

const CHECKING_KEY = /Проверяем ключ/u;

const heading = (name: string) =>
  screen.getByRole("heading", { level: 1, name });

const MASKED_KEY = /^ol_api_•+7Xk2$/u;
const MASKED_TOKEN = /^pk_4815162_•+YC1P$/u;
const TOKEN_REFUSED = /Токен не подошёл/u;

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
    // Masked: the start and the last 4 characters.
    const key = screen.getByLabelText("API-ключ") as HTMLInputElement;
    expect(key.value).toMatch(MASKED_KEY);
    fireEvent.click(screen.getByRole("button", { name: "Показать ключ" }));
    expect(key.value).toBe("ol_api_x9Pq4Lm2Vb7Nd3Wf8Ht7Xk2");
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
  it("asks for a personal token and leads to ClickUp's token page", () => {
    render(<ClickUpConnectScreen state="form" />);

    expect(heading("Подключение ClickUp")).toBeDefined();
    expect(
      screen
        .getByRole("link", { name: "Открыть страницу токена" })
        .getAttribute("href")
    ).toBe("https://app.clickup.com/settings/apps");
    const token = screen.getByLabelText("Токен ClickUp") as HTMLInputElement;
    expect(token.value).toMatch(MASKED_TOKEN);
    // No sign-in in the browser any more.
    expect(screen.queryByText("Что сможет Grill")).toBeNull();
  });

  it("says the token was refused at its field", () => {
    render(<ClickUpConnectScreen state="rejected" />);

    expect(screen.getByText(TOKEN_REFUSED)).toBeDefined();
  });

  it("offers the workspaces when the token opens several", () => {
    render(<ClickUpConnectScreen state="choose" />);

    const group = screen.getByRole("radiogroup");
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(within(group).getByText("Личное")).toBeDefined();
    expect(screen.getByRole("button", { name: "Подключить" })).toBeDefined();
  });

  it("shows the workspace, the user and the spaces when connected", () => {
    render(<ClickUpConnectScreen state="connected" />);

    expect(heading("ClickUp подключён")).toBeDefined();
    expect(screen.getByText("Pixel Agency")).toBeDefined();
    expect(screen.getByText("Дима Капиш")).toBeDefined();
    expect(screen.getByText("Клиенты")).toBeDefined();
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
