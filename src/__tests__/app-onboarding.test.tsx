import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetOnboardingSetup } from "@/data/onboarding-setup";
import { AgentPage } from "@/features/onboarding/pages/agent-page";
import { PermissionsPage } from "@/features/onboarding/pages/permissions-page";
import { SpeechPage } from "@/features/onboarding/pages/speech-page";
import { WelcomePage } from "@/features/onboarding/pages/welcome-page";

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/onboarding",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: navigation.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => navigation.params,
}));

const NEXT = "Продолжить";

function nextLink() {
  return screen.getByRole("link", { name: NEXT });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  navigation.params = new URLSearchParams();
  resetOnboardingSetup();
});

afterEach(() => {
  resetOnboardingSetup();
  vi.useRealTimers();
});

describe("WelcomePage", () => {
  it("starts the setup with a link to the permissions", () => {
    render(<WelcomePage />);

    expect(
      screen.getByRole("link", { name: "Начать" }).getAttribute("href")
    ).toBe("/onboarding/permissions");
  });
});

describe("PermissionsPage", () => {
  it("asks for both accesses through the macOS dialogs", () => {
    render(<PermissionsPage />);

    expect(screen.getByRole("button", { name: NEXT })).toHaveProperty(
      "disabled",
      true
    );
    expect(
      screen.getByRole("link", { name: "Назад" }).getAttribute("href")
    ).toBe("/onboarding");

    const [microphone] = screen.getAllByRole("button", { name: "Разрешить" });
    fireEvent.click(microphone);
    const micDialog = screen.getByRole("dialog", {
      name: "Программа «Grill» запрашивает доступ к микрофону.",
    });
    expect(screen.getByText("Ждём ответа")).toBeDefined();
    fireEvent.click(
      within(micDialog).getByRole("button", { name: "Разрешить" })
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("Разрешено")).toBeDefined();
    expect(
      screen.getByRole("img", { name: "Уровень микрофона" })
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    const screenDialog = screen.getByRole("dialog");
    fireEvent.click(
      within(screenDialog).getByRole("button", { name: "Разрешить" })
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Всё разрешено" })
    ).toBeDefined();
    expect(nextLink().getAttribute("href")).toBe("/onboarding/speech");
  });

  it("guides through System Settings after a refusal", () => {
    navigation.params = new URLSearchParams("demo=denied");
    render(<PermissionsPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Нужен доступ к звуку звонка",
      })
    ).toBeDefined();

    // Checking before fixing anything keeps the refusal
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    advance(1000);
    expect(screen.getByText("Запрещено")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Открыть настройки" }));
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    advance(1000);

    expect(
      screen.getByRole("heading", { level: 1, name: "Всё разрешено" })
    ).toBeDefined();
    expect(nextLink()).toBeDefined();
  });

  it("refusing the microphone explains how to turn it on", () => {
    render(<PermissionsPage />);

    const [microphone] = screen.getAllByRole("button", { name: "Разрешить" });
    fireEvent.click(microphone);
    fireEvent.click(screen.getByRole("button", { name: "Не разрешать" }));

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Нужен доступ к микрофону",
      })
    ).toBeDefined();
  });

  it("shows the live system sound meter on Windows", () => {
    navigation.params = new URLSearchParams("demo=windows");
    render(<PermissionsPage />);

    expect(
      screen.getByRole("img", { name: "Уровень системного звука" })
    ).toBeDefined();
    expect(nextLink()).toBeDefined();
  });
});

describe("SpeechPage", () => {
  it("downloads, pauses, verifies and checks the microphone", () => {
    render(<SpeechPage />);

    expect(screen.getByRole("button", { name: NEXT })).toHaveProperty(
      "disabled",
      true
    );

    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
    expect(
      screen.getByText("Скачиваем модель для русского языка")
    ).toBeDefined();
    // The model downloads in the background, the step can be left
    expect(nextLink().getAttribute("href")).toBe("/onboarding/agent");

    advance(500);
    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    expect(
      screen.getByText("Модель для русского языка на паузе")
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: NEXT }));

    // 12,5% → 100% at 2,5% per 100 ms
    advance(3600);
    expect(screen.getByText("Проверяем модель")).toBeDefined();
    advance(1500);
    expect(screen.getByText("Модель готова")).toBeDefined();

    advance(5000);
    expect(
      screen.getByText("Привет, это Дима, проверяю, как Grill меня слышит")
    ).toBeDefined();
  });

  it("cancels back to the language choice and switches the language", () => {
    render(<SpeechPage />);

    fireEvent.click(screen.getByRole("button", { name: "Скачать" }));
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(screen.getByRole("button", { name: "Скачать" })).toBeDefined();

    fireEvent.click(screen.getByRole("radio", { name: "Українська" }));
    expect(screen.getByText("Модель для украинского языка")).toBeDefined();
  });

  it("retries after the network dropped", () => {
    navigation.params = new URLSearchParams("demo=no-network");
    render(<SpeechPage />);

    expect(screen.getByText("Загрузка прервалась на 63%")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Повторить сейчас" }));
    expect(
      screen.getByText("Скачиваем модель для русского языка")
    ).toBeDefined();
  });
});

describe("AgentPage", () => {
  it("finds the agent, logs in and lets the user continue", () => {
    render(<AgentPage />);

    expect(screen.getByText("Проверяем вход в аккаунт")).toBeDefined();
    advance(1500);

    expect(screen.getByText("Вход не выполнен")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    advance(2000);
    advance(1000);

    expect(screen.getByText("Подписка активна")).toBeDefined();
    expect(nextLink().getAttribute("href")).toBe("/onboarding/integrations");
    expect(
      screen.getByRole("link", { name: "Назад" }).getAttribute("href")
    ).toBe("/onboarding/speech");
  });

  it("installs the agent when it is missing", () => {
    navigation.params = new URLSearchParams("demo=not-installed");
    render(<AgentPage />);

    fireEvent.click(screen.getByRole("button", { name: "Установить" }));
    expect(screen.getByText("Скачали Claude Code")).toBeDefined();

    advance(3000);
    expect(screen.getByText("Вход не выполнен")).toBeDefined();
  });

  it("retries a failed install", () => {
    navigation.params = new URLSearchParams("demo=install-error");
    render(<AgentPage />);

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(screen.getByText("Скачали Claude Code")).toBeDefined();
  });
});
