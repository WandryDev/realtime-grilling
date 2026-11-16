import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentSettingsScreen } from "@/features/settings/screens/agent-settings";
import { AudioSettingsScreen } from "@/features/settings/screens/audio-settings";
import { GeneralSettingsScreen } from "@/features/settings/screens/general-settings";
import { IntegrationsSettingsScreen } from "@/features/settings/screens/integrations-settings";
import { PrivacySettingsScreen } from "@/features/settings/screens/privacy-settings";
import { WidgetSettingsScreen } from "@/features/settings/screens/widget-settings";

const SETTINGS_NAV = "Разделы настроек";
const NEEDS_ATTENTION = /требует внимания/u;
const OVERLAY_SHORTCUT = /Показать или скрыть оверлей/u;
const CLAUDE_READY = /Claude Code\s*готов к звонку/u;
const INTEGRATIONS = /Интеграции/u;

describe("settings screens", () => {
  it("renders the general section with the settings sidebar", () => {
    render(<GeneralSettingsScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Общие" })
    ).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: SETTINGS_NAV });
    expect(
      within(nav)
        .getByRole("link", { name: "Общие" })
        .getAttribute("aria-current")
    ).toBe("page");
    expect(screen.getByRole("switch")).toBeTruthy();
    expect(
      screen.getByText("~/Library/Application Support/Grill/recordings")
    ).toBeTruthy();
    expect(
      screen.getByText("Аудио звонков. Занято 1,2 ГБ, 38 звонков")
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Показать в Finder" })
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByText("Язык интерфейса")).toBeNull();
  });

  it("renders the audio section with the speech models", () => {
    render(<AudioSettingsScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Звук и распознавание" })
    ).toBeTruthy();
    expect(screen.getByText("Whisper large-v3-turbo")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns about the disconnected microphone", () => {
    render(<AudioSettingsScreen microphone="disabled" />);

    expect(
      within(screen.getByRole("alert")).getByText(
        "Микрофон «AirPods Pro Димы» отключён"
      )
    ).toBeTruthy();
    expect(screen.getByText("Нет микрофона")).toBeTruthy();
    expect(screen.getByText(NEEDS_ATTENTION)).toBeTruthy();
  });

  it("renders the agent section", () => {
    render(<AgentSettingsScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Агент" })
    ).toBeTruthy();
    expect(screen.getByText("найден автоматически")).toBeTruthy();
    expect(screen.getByText("2.1.14")).toBeTruthy();
    expect(screen.getByText("Выполнен, подписка Max")).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(screen.getByText("Использовано 38 %")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull();
    expect(screen.queryByText("Финальная проверка")).toBeNull();
    expect(
      screen.getByText(
        "Обычно агент смотрит разговор, как только клиент договорил. Реже — не чаще раза в полминуты, лимит подписки расходуется медленнее"
      )
    ).toBeTruthy();
  });

  it("shows the shortcut being recorded", () => {
    render(<WidgetSettingsScreen recording="toggle-overlay" />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Виджет и клавиши" })
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: OVERLAY_SHORTCUT })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(screen.getByText("Нажмите сочетание, Esc отменит")).toBeTruthy();
  });

  it("renders the privacy section", () => {
    render(<PrivacySettingsScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Приватность и хранение" })
    ).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Что уходит с компьютера" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Очистить всё" })).toBeTruthy();
  });

  it("renders the integrations in every state", () => {
    const { unmount } = render(<IntegrationsSettingsScreen />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Интеграции" })
    ).toBeTruthy();
    expect(screen.getByText("2 из 3 работают")).toBeTruthy();
    expect(screen.getByText("Не работает")).toBeTruthy();
    unmount();

    const dialog = render(
      <IntegrationsSettingsScreen state="confirm-disconnect" />
    );
    expect(
      screen.getByRole("alertdialog", { name: "Отключить GitHub?" })
    ).toBeTruthy();
    dialog.unmount();

    const disconnected = render(
      <IntegrationsSettingsScreen state="github-disconnected" />
    );
    expect(screen.getByText("1 из 3 работает")).toBeTruthy();
    expect(
      within(screen.getByRole("status")).getByText("GitHub отключён")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Подключить" })).toBeTruthy();
    disconnected.unmount();
  });

  it("puts the integrations into the settings sidebar like the other sections", () => {
    render(<IntegrationsSettingsScreen />);

    const navs = screen.getAllByRole("navigation", { name: SETTINGS_NAV });
    expect(navs).toHaveLength(1);
    expect(
      within(navs[0] as HTMLElement)
        .getByRole("link", { name: INTEGRATIONS })
        .getAttribute("aria-current")
    ).toBe("page");
    expect(screen.queryByRole("link", { name: "К проектам" })).toBeTruthy();
  });

  it("shows Claude Code's state in the sidebar, as a link to «Агент»", async () => {
    render(<GeneralSettingsScreen />);

    const row = await screen.findByRole("link", { name: CLAUDE_READY });
    expect(row.getAttribute("href")).toBe("/settings/agent");
    expect(screen.queryByText("Запись не идёт")).toBeNull();
  });

  it("keeps the agent row next to «Нет микрофона»", async () => {
    render(<AudioSettingsScreen microphone="disabled" />);

    expect(screen.getByText("Нет микрофона")).toBeTruthy();
    expect(
      await screen.findByRole("link", { name: CLAUDE_READY })
    ).toBeTruthy();
  });
});
