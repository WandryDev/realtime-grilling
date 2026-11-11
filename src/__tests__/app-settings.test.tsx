import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getIntegrations, setIntegration } from "@/data/integrations";
import {
  getSettings,
  resetSettings,
  setMicrophoneMissing,
} from "@/data/settings";
import { SettingsPage } from "@/features/settings/pages/settings-page";

const push = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/general",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push,
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => searchParams,
}));

const SETTINGS_NAV = "Разделы настроек";
const OVERLAY_SHORTCUT = /Показать или скрыть оверлей/u;
const CALL_SHORTCUT = /Начать или завершить звонок/u;
const SHORTCUT_TAKEN = /его занимает другое приложение/u;
const INTEGRATIONS_ALERT = /Интеграции, требует внимания/u;
const ASYNC_TIMEOUT = { timeout: 4000 };

function connectAll() {
  setIntegration("github", { account: "dima-kapish", status: "connected" });
  setIntegration("outline", {
    account: "wandry.getoutline.com",
    status: "connected",
  });
  setIntegration("clickup", { account: "Wandry", status: "connected" });
}

beforeEach(() => {
  push.mockReset();
  searchParams = new URLSearchParams();
  window.localStorage.clear();
  resetSettings();
  setMicrophoneMissing(false);
  connectAll();
});

describe("settings app", () => {
  it("links the sections and back to the projects", () => {
    render(<SettingsPage section="general" />);

    const nav = screen.getByRole("navigation", { name: SETTINGS_NAV });
    expect(
      within(nav).getByRole("link", { name: "Общие" }).getAttribute("href")
    ).toBe("/settings/general");
    expect(
      within(nav)
        .getByRole("link", { name: "Виджет и клавиши" })
        .getAttribute("href")
    ).toBe("/settings/shortcuts");
    expect(
      screen.getByRole("link", { name: "К проектам" }).getAttribute("href")
    ).toBe("/");
  });

  it("saves a switch at once and persists it", async () => {
    const user = userEvent.setup();
    render(<SettingsPage section="general" />);

    const autostart = screen.getByRole("switch");
    expect(autostart.getAttribute("aria-checked")).toBe("true");
    await user.click(autostart);

    expect(getSettings().launchAtLogin).toBe(false);
    expect(autostart.getAttribute("aria-checked")).toBe("false");
    expect(window.localStorage.getItem("grill.settings")).toContain(
      '"launchAtLogin":false'
    );
  });

  it("records a new global shortcut and cancels with Esc", async () => {
    const user = userEvent.setup();
    render(<SettingsPage section="shortcuts" />);

    const field = screen.getByRole("button", { name: OVERLAY_SHORTCUT });
    await user.click(field);
    expect(field.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Нажмите сочетание, Esc отменит")).toBeTruthy();

    fireEvent.keyDown(window, { altKey: true, key: "Alt" });
    fireEvent.keyDown(window, {
      altKey: true,
      code: "KeyK",
      key: "˚",
      metaKey: true,
    });

    expect(getSettings().shortcuts["toggle-overlay"]).toEqual(["⌥", "⌘", "K"]);
    expect(field.getAttribute("aria-pressed")).toBe("false");

    await user.click(field);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(field.getAttribute("aria-pressed")).toBe("false");
    expect(getSettings().shortcuts["toggle-overlay"]).toEqual(["⌥", "⌘", "K"]);
  });

  it("shows the refusal of the OS on that shortcut and keeps its keys", async () => {
    const user = userEvent.setup();
    render(<SettingsPage section="shortcuts" />);

    // The mock refuses ⌘ Space like a shortcut Spotlight holds.
    const field = screen.getByRole("button", { name: CALL_SHORTCUT });
    await user.click(field);
    fireEvent.keyDown(window, { code: "Space", key: " ", metaKey: true });

    expect(await screen.findByText(SHORTCUT_TAKEN)).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(getSettings().shortcuts["toggle-call"]).toEqual(["⌥", "⌘", "G"]);
    expect(
      screen
        .getByRole("button", { name: OVERLAY_SHORTCUT })
        .getAttribute("aria-invalid")
    ).toBeNull();
  });

  it("disconnects a service after the confirmation", async () => {
    const user = userEvent.setup();
    render(<SettingsPage section="integrations" />);

    expect(screen.getByText("3 из 3 работают")).toBeTruthy();
    const github = screen.getByRole("article", { name: "GitHub" });
    await user.click(within(github).getByRole("button", { name: "Отключить" }));

    const dialog = await screen.findByRole("alertdialog", {
      name: "Отключить GitHub?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Отключить" }));

    expect(getIntegrations().github.status).toBe("disconnected");
    expect(await screen.findByText("2 из 3 работают")).toBeTruthy();
  });

  it("connects a service through the dialog", async () => {
    setIntegration("github", { status: "disconnected" });
    const user = userEvent.setup();
    render(<SettingsPage section="integrations" />);

    const github = screen.getByRole("article", { name: "GitHub" });
    await user.click(
      within(github).getByRole("button", { name: "Подключить" })
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Подключить GitHub",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Продолжить в браузере" })
    );

    expect(within(github).getByText("Подключаем…")).toBeTruthy();
    expect(
      await within(github).findByText("Подключено", {}, ASYNC_TIMEOUT)
    ).toBeTruthy();
    expect(getIntegrations().github.status).toBe("connected");
  });

  it("opens the forced states from ?demo", async () => {
    searchParams = new URLSearchParams("demo=mic-disabled");
    const user = userEvent.setup();
    render(<SettingsPage section="audio" />);

    const banner = await screen.findByRole("alert");
    expect(
      within(banner).getByText("Микрофон «AirPods Pro Димы» отключён")
    ).toBeTruthy();
    await user.click(
      within(banner).getByRole("button", { name: "Взять микрофон MacBook" })
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(getSettings().microphone).toBe("macbook");
  });

  it("signs the agent out after the confirmation", async () => {
    const user = userEvent.setup();
    render(<SettingsPage section="agent" />);

    await user.click(screen.getByRole("button", { name: "Выйти" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Выйти из Claude Code?",
    });
    await user.click(within(dialog).getByRole("button", { name: "Выйти" }));

    expect(getSettings().agentSignedIn).toBe(false);
    expect(screen.getByText("Не выполнен")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Войти" })).toBeTruthy();
  });

  it("deletes everything only after typing the word", async () => {
    const user = userEvent.setup();
    render(<SettingsPage section="privacy" />);

    await user.click(screen.getByRole("button", { name: "Очистить всё" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить всё из Grill?",
    });
    const confirm = within(dialog).getByRole("button", { name: "Удалить всё" });
    expect(confirm.hasAttribute("disabled")).toBe(true);

    await user.type(within(dialog).getByRole("textbox"), "удалить");
    expect(confirm.hasAttribute("disabled")).toBe(false);
    await user.click(confirm);

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/onboarding");
    }, ASYNC_TIMEOUT);
    expect(getIntegrations().github.status).toBe("disconnected");
  });

  it("lights the integrations dot while a service is broken", () => {
    render(<SettingsPage section="general" />);
    expect(screen.queryByText(", требует внимания")).toBeNull();

    act(() => {
      setIntegration("outline", { error: "Ключ истёк", status: "error" });
    });
    const nav = screen.getByRole("navigation", { name: SETTINGS_NAV });
    expect(
      within(nav).getByRole("link", { name: INTEGRATIONS_ALERT })
    ).toBeTruthy();
  });
});
