import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AgentScreen,
  type AgentState,
} from "@/features/onboarding/screens/agent-screen";
import {
  PermissionsScreen,
  type PermissionsState,
} from "@/features/onboarding/screens/permissions-screen";
import {
  SpeechModelScreen,
  type SpeechModelState,
} from "@/features/onboarding/screens/speech-model-screen";
import { WelcomeScreen } from "@/features/onboarding/screens/welcome-screen";

const NEXT_NAME = "Продолжить";

describe("WelcomeScreen", () => {
  it("greets and starts the setup", () => {
    render(<WelcomeScreen />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Здравствуйте, это Grill" })
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Начать" })).toHaveProperty(
      "disabled",
      false
    );
    expect(
      screen.getByRole("listitem", { current: "step" }).textContent
    ).toContain("Знакомство");
  });
});

const PERMISSION_CASES: [PermissionsState, string, boolean][] = [
  ["idle", "Разрешите Grill слышать звонок", false],
  ["prompt", "Разрешите Grill слышать звонок", false],
  ["granted", "Всё разрешено", true],
  ["denied", "Нужен доступ к звуку звонка", false],
  ["windows", "Микрофон и звук звонка", true],
];

describe("PermissionsScreen", () => {
  it.each(PERMISSION_CASES)(
    "renders the %s state",
    (state, title, canContinue) => {
      render(<PermissionsScreen state={state} />);

      expect(
        screen.getByRole("heading", { level: 1, name: title })
      ).toBeDefined();
      expect(screen.getByRole("button", { name: NEXT_NAME })).toHaveProperty(
        "disabled",
        !canContinue
      );
    }
  );

  it("shows the macOS dialog over the window while asking", () => {
    render(<PermissionsScreen state="prompt" />);

    expect(
      screen.getByRole("dialog", {
        name: "Программа «Grill» запрашивает доступ к микрофону.",
      })
    ).toBeDefined();
    expect(screen.getByText("Ждём ответа")).toBeDefined();
  });

  it("explains how to turn the access on after a refusal", () => {
    render(<PermissionsScreen state="denied" />);

    expect(screen.getByText("Запрещено")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Открыть настройки" })
    ).toBeDefined();
  });

  it("uses the Windows window controls on Windows", () => {
    render(<PermissionsScreen state="windows" />);

    expect(screen.getByRole("button", { name: "Закрыть" })).toBeDefined();
    expect(
      screen.getByRole("img", { name: "Уровень системного звука" })
    ).toBeDefined();
  });
});

const SPEECH_CASES: [SpeechModelState, string, boolean][] = [
  ["language", "Модель для русского языка", false],
  ["downloading", "Скачиваем модель для русского языка", true],
  ["checking", "Проверяем модель", true],
  ["ready", "Модель готова", true],
  ["no-space", "Не хватает места на диске", false],
  ["no-network", "Загрузка прервалась на 63%", false],
];

describe("SpeechModelScreen", () => {
  it.each(SPEECH_CASES)("renders the %s state", (state, text, canContinue) => {
    render(<SpeechModelScreen state={state} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Распознавание речи" })
    ).toBeDefined();
    expect(screen.getByText(text)).toBeDefined();
    expect(
      screen
        .getByRole("radio", { name: "Русский" })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(screen.getByRole("button", { name: NEXT_NAME })).toHaveProperty(
      "disabled",
      !canContinue
    );
  });
});

const AGENT_CASES: [AgentState, string][] = [
  ["checking", "Проверяем вход в аккаунт"],
  ["ready", "Подписка активна"],
  ["needs-login", "Вход не выполнен"],
  ["not-installed", "Скачаем Claude Code с сайта Anthropic"],
  ["installing", "Скачали Claude Code"],
  ["install-error", "Не получилось скачать Claude Code"],
];

describe("AgentScreen", () => {
  it.each(AGENT_CASES)("renders the %s state", (state, text) => {
    render(<AgentScreen state={state} />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Агент, который придумывает вопросы",
      })
    ).toBeDefined();
    expect(screen.getByText(text)).toBeDefined();
    expect(screen.getByRole("button", { name: NEXT_NAME })).toHaveProperty(
      "disabled",
      !(state === "ready")
    );
  });
});

describe("PermissionsScreen meters and hints", () => {
  it("shows why the microphone meter can't run instead of its bars", () => {
    render(
      <PermissionsScreen
        microphoneLevel={{ active: 0, levels: [], problem: "noDevice" }}
        state="granted"
      />
    );

    expect(screen.getByText("Нет микрофона")).toBeDefined();
    expect(
      screen.getByText("Подключите микрофон или наушники с микрофоном")
    ).toBeDefined();
    expect(screen.queryByRole("img", { name: "Уровень микрофона" })).toBeNull();
  });

  it("lets the step go on with an unknown system sound access", () => {
    render(<PermissionsScreen state="unknown" />);

    expect(screen.getByRole("button", { name: "Разрешить" })).toBeDefined();
    expect(screen.getByRole("button", { name: NEXT_NAME })).toHaveProperty(
      "disabled",
      false
    );
  });

  it("hints at the settings when the system sound stays silent", () => {
    render(<PermissionsScreen silentSystemAudio state="unknown" />);

    expect(screen.getByText("Не слышим звук других приложений")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Открыть настройки" })
    ).toBeDefined();
  });
});

describe("AgentScreen failures", () => {
  it("shows what failed during the install and its log", () => {
    render(
      <AgentScreen
        failure={{
          log: ["exit status 6"],
          summary: "Установщик завершился с ошибкой",
          title: "Не получилось установить Claude Code",
        }}
        state="install-error"
      />
    );

    expect(
      screen.getByText("Не получилось установить Claude Code")
    ).toBeDefined();
    expect(screen.getByText("Установщик завершился с ошибкой")).toBeDefined();
    expect(screen.getByText("exit status 6")).toBeDefined();
    expect(screen.getByRole("button", { name: "Повторить" })).toBeDefined();
  });

  it("offers a new check when Claude Code doesn't answer", () => {
    render(<AgentScreen state="error" />);

    expect(screen.getByText("Не отвечает")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Проверить снова" })
    ).toBeDefined();
  });
});
