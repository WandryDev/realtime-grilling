import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LOGIN_CODE_REJECTED,
  LOGIN_EXPIRED,
  resetOnboardingSetup,
} from "@/data/onboarding-setup";
import { getSettings, resetSettings } from "@/data/settings";
import { MOCK_DELAY_MS, mockComputer } from "@/features/onboarding/backend";
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
// A loading button reads its spinner too
const CONFIRM_BUSY = /Подтвердить/u;

function nextLink() {
  return screen.getByRole("link", { name: NEXT });
}

/** Types a code into "Код из браузера" and presses "Подтвердить". */
function enterLoginCode(code: string) {
  fireEvent.change(screen.getByLabelText("Код из браузера"), {
    target: { value: code },
  });
  fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
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
  resetSettings();
});

afterEach(() => {
  resetOnboardingSetup();
  vi.restoreAllMocks();
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

    fireEvent.click(screen.getByRole("radio", { name: "Украинский" }));
    expect(screen.getByText("Модель для украинского языка")).toBeDefined();
    // The call language is a setting
    expect(getSettings().callLanguage).toBe("uk");
  });

  it("retries after the network dropped", () => {
    navigation.params = new URLSearchParams("demo=no-network");
    render(<SpeechPage />);
    advance(0);

    expect(screen.getByText("Загрузка прервалась на 63%")).toBeDefined();
    expect(screen.getByText("сами попробуем снова через 0:24")).toBeDefined();
    advance(4000);
    expect(screen.getByText("сами попробуем снова через 0:20")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Повторить сейчас" }));
    advance(0);
    expect(
      screen.getByText("Скачиваем модель для русского языка")
    ).toBeDefined();
  });

  it("offers the small model when turbo is too slow", () => {
    navigation.params = new URLSearchParams("demo=check-failed");
    render(<SpeechPage />);
    advance(0);

    expect(
      screen.getByText("Компьютер не успевает за разговором")
    ).toBeDefined();
    // A failed check doesn't forbid the model
    expect(nextLink().getAttribute("href")).toBe("/onboarding/agent");

    fireEvent.click(
      screen.getByRole("button", { name: "Скачать запасную модель" })
    );
    advance(0);
    expect(
      screen.getByText("Скачиваем модель для русского языка")
    ).toBeDefined();
    // 0 → 100% at 2,5% per 100 ms, the sum, then the check
    advance(4000);
    advance(1500);
    expect(screen.getByText("Модель готова")).toBeDefined();
  });
});

describe("AgentPage", () => {
  it("finds the agent, logs in and lets the user continue", () => {
    render(<AgentPage />);

    expect(screen.getByText("Проверяем вход в аккаунт")).toBeDefined();
    advance(1500);

    expect(screen.getByText("Вход не выполнен")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    advance(MOCK_DELAY_MS.loginStart);
    enterLoginCode("aB3dE5gH");
    advance(MOCK_DELAY_MS.loginSubmit);

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

  it("passes the code from the browser to the agent", () => {
    const submit = vi.spyOn(mockComputer, "submitLogin");
    navigation.params = new URLSearchParams("demo=awaiting-code");
    render(<AgentPage />);

    expect(screen.getByText("Ждём код")).toBeDefined();
    enterLoginCode("  aB3dE5gH ");
    expect(
      screen.getByRole("button", { busy: true, name: CONFIRM_BUSY })
    ).toBeDefined();
    advance(MOCK_DELAY_MS.loginSubmit);

    expect(submit).toHaveBeenCalledWith("aB3dE5gH");
    expect(screen.getByText("Подписка активна")).toBeDefined();
  });

  it("shows a wrong code under the field", () => {
    navigation.params = new URLSearchParams("demo=awaiting-code");
    render(<AgentPage />);

    enterLoginCode("abc");
    advance(MOCK_DELAY_MS.loginSubmit);

    const field = screen.getByLabelText("Код из браузера");
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe(LOGIN_CODE_REJECTED);
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")).toContain(error.id);
    expect(screen.queryByRole("link", { name: NEXT })).toBeNull();

    // The session is over: a new login, then the right code
    fireEvent.click(screen.getByRole("button", { name: "Войти ещё раз" }));
    advance(MOCK_DELAY_MS.loginStart);
    expect(screen.queryByRole("alert")).toBeNull();
    enterLoginCode("aB3dE5gH");
    advance(MOCK_DELAY_MS.loginSubmit);
    expect(screen.getByText("Подписка активна")).toBeDefined();
  });

  it("cancels the login back to «Войти»", () => {
    const cancel = vi.spyOn(mockComputer, "closeLogin");
    render(<AgentPage />);
    advance(MOCK_DELAY_MS.agentCheck);

    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    advance(MOCK_DELAY_MS.loginStart);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));

    expect(screen.getByText("Вход не выполнен")).toBeDefined();
    expect(screen.queryByLabelText("Код из браузера")).toBeNull();
    expect(cancel).toHaveBeenCalled();
  });

  it("never sends a second code into a closed login", () => {
    const submit = vi.spyOn(mockComputer, "submitLogin");
    navigation.params = new URLSearchParams("demo=awaiting-code");
    render(<AgentPage />);

    enterLoginCode("abc");
    advance(MOCK_DELAY_MS.loginSubmit);
    fireEvent.submit(screen.getByRole("form", { name: "Вход в Claude" }));
    advance(MOCK_DELAY_MS.loginSubmit);

    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("asks to start over when the login expired", () => {
    navigation.params = new URLSearchParams("demo=awaiting-code");
    render(<AgentPage />);

    // Ten minutes passed, the CLI closed the session
    mockComputer.closeLogin();
    enterLoginCode("aB3dE5gH");
    advance(MOCK_DELAY_MS.loginSubmit);

    expect(screen.getByRole("alert").textContent).toBe(LOGIN_EXPIRED);
    expect(screen.getByRole("button", { name: "Войти" })).toBeDefined();
  });

  it("cancels a running install", () => {
    navigation.params = new URLSearchParams("demo=not-installed");
    render(<AgentPage />);

    fireEvent.click(screen.getByRole("button", { name: "Установить" }));
    advance(1000);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    advance(3000);

    expect(screen.getByRole("button", { name: "Установить" })).toBeDefined();
    expect(screen.queryByText("Вход не выполнен")).toBeNull();
  });
});
