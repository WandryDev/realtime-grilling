import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AgentState,
  BenchmarkResult,
  CommandError,
  ModelState,
  PermissionStatus,
  Permissions,
  SpeechModel,
} from "@/bindings";

/*
 * Onboarding steps 02 and 04 in Tauri mode, over a fake IPC
 * (./helpers/fake-tauri.ts): the states come from the Rust commands, the
 * window focus re-reads them, the level meters subscribe and unsubscribe.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const FOCUS = "tauri://focus";

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "onboarding",
    listen: fake.listen,
    onFocusChanged: (handler: (event: { payload: boolean }) => void) =>
      fake.listen(FOCUS, () => handler({ payload: true })),
  }),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/onboarding",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: navigation.replace,
  }),
  useSearchParams: () => navigation.params,
}));

const { inTauri } = await import("@/effect/runtime");
const { LOGIN_CODE_REJECTED, LOGIN_EXPIRED, resetOnboardingSetup } =
  await import("@/data/onboarding-setup");
const { PermissionsPage } = await import(
  "@/features/onboarding/pages/permissions-page"
);
const { AgentPage } = await import("@/features/onboarding/pages/agent-page");
const { WelcomePage } = await import(
  "@/features/onboarding/pages/welcome-page"
);
const { SpeechPage } = await import("@/features/onboarding/pages/speech-page");

const LOGIN_URL = "https://claude.ai/oauth/authorize?code=true";
const INSTALL_LOG_LINE = /Could not resolve host/u;
const RESTART_HINT = /перезапустите Grill/u;

function status(state: PermissionStatus["state"]): PermissionStatus {
  return { message: null, state };
}

function answer(command: string, value: unknown) {
  fake.answers.set(command, () => value);
}

function fail(command: string, error: CommandError) {
  fake.failures.set(command, error);
}

function calls(command: string) {
  return fake.invoked.filter((call) => call.command === command);
}

/** A command that keeps running until the test settles it. */
function running(command: string) {
  let settle: (value: unknown) => void = () => undefined;
  fake.answers.set(
    command,
    () =>
      new Promise((resolve) => {
        settle = resolve;
      })
  );
  return (value: unknown) => settle(value);
}

function focusWindow() {
  act(() => {
    fake.emit(FOCUS, true);
  });
}

/** Plays a Rust event and lets the stream fibers apply it. */
async function emit(event: string, payload: unknown) {
  await act(async () => {
    fake.emit(event, payload);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function setPermissions(microphone: string, systemAudio: string) {
  answer("permissions_get", {
    microphone: status(microphone as PermissionStatus["state"]),
    systemAudio: status(systemAudio as PermissionStatus["state"]),
  } satisfies Permissions);
}

const NEEDS_LOGIN: AgentState = { status: "needsLogin", version: "2.1.316" };
const READY: AgentState = {
  status: "ready",
  subscriptionType: "pro",
  version: "2.1.316",
};

beforeEach(() => {
  navigation.params = new URLSearchParams();
  fake.answers.clear();
  fake.failures.clear();
  fake.invoked.length = 0;
  for (const command of [
    "audio_level_start",
    "audio_level_stop",
    "agent_install_cancel",
    "agent_login_cancel",
    "permission_open_settings",
    "app_restart",
  ]) {
    answer(command, null);
  }
});

afterEach(() => {
  window.localStorage.clear();
  navigation.replace.mockReset();
  resetOnboardingSetup();
  vi.restoreAllMocks();
});

describe("onboarding in Tauri", () => {
  it("runs on the Tauri layers", () => {
    expect(inTauri).toBe(true);
  });
});

describe("PermissionsPage in Tauri", () => {
  it("reads the accesses on entering the step", async () => {
    setPermissions("granted", "denied");
    render(<PermissionsPage />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Нужен доступ к звуку звонка",
      })
    ).toBeTruthy();
    // macOS shows its own dialog, the drawn one stays off
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reads them again when the window gets the focus back", async () => {
    setPermissions("granted", "denied");
    render(<PermissionsPage />);
    await screen.findByText("Запрещено");

    // The user turned the toggle on in System Settings
    setPermissions("granted", "granted");
    focusWindow();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Всё разрешено" })
    ).toBeTruthy();
    expect(calls("permissions_get").length).toBeGreaterThanOrEqual(2);
  });

  it("asks the OS and shows its answer", async () => {
    setPermissions("notDetermined", "notDetermined");
    const settle = running("permission_request");
    render(<PermissionsPage />);
    await waitFor(() => expect(calls("permissions_get")).toHaveLength(1));

    const [microphone] = screen.getAllByRole("button", { name: "Разрешить" });
    fireEvent.click(microphone as HTMLElement);
    expect(screen.getByText("Ждём ответа")).toBeTruthy();
    expect(calls("permission_request")[0]?.args).toEqual({
      kind: "microphone",
    });

    act(() => settle(status("granted")));
    expect(await screen.findByText("Разрешено")).toBeTruthy();
  });

  it("offers a restart when macOS still says the system sound wasn't asked", async () => {
    setPermissions("granted", "notDetermined");
    answer("permission_request", status("notDetermined"));
    render(<PermissionsPage />);
    await waitFor(() => expect(calls("permissions_get")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    const restart = await screen.findByRole("button", {
      name: "Перезапустить",
    });
    expect(screen.getByText(RESTART_HINT)).toBeTruthy();

    fireEvent.click(restart);
    await waitFor(() => expect(calls("app_restart")).toHaveLength(1));
    expect(window.localStorage.getItem("grill.onboarding-resume")).toBe(
      "/onboarding/permissions"
    );
  });

  it("drops the restart hint once the access is known", async () => {
    setPermissions("granted", "notDetermined");
    answer("permission_request", status("notDetermined"));
    render(<PermissionsPage />);
    await waitFor(() => expect(calls("permissions_get")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Разрешить" }));
    await screen.findByRole("button", { name: "Перезапустить" });

    setPermissions("granted", "granted");
    focusWindow();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Перезапустить" })).toBeNull()
    );
  });

  it("stops the microphone level when the user leaves the step", async () => {
    setPermissions("granted", "granted");
    const { unmount } = render(<PermissionsPage />);

    await waitFor(() =>
      expect(calls("audio_level_start")[0]?.args).toEqual({
        source: "microphone",
      })
    );
    await emit("audio-level", {
      level: 0.6,
      playing: null,
      source: "microphone",
    });
    expect(screen.getByRole("img", { name: "Уровень микрофона" })).toBeTruthy();

    unmount();
    await waitFor(() =>
      expect(calls("audio_level_stop")[0]?.args).toEqual({
        source: "microphone",
      })
    );
  });

  it("shows why the microphone meter can't run", async () => {
    setPermissions("granted", "granted");
    fail("audio_level_start", {
      kind: "External",
      message: "No input device",
      reason: "noDevice",
    });
    render(<PermissionsPage />);

    expect(await screen.findByText("Нет микрофона")).toBeTruthy();
    expect(
      screen.getByText("Подключите микрофон или наушники с микрофоном")
    ).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Уровень микрофона" })).toBeNull();
  });

  it("subscribes again on focus after Rust stopped the level", async () => {
    setPermissions("granted", "granted");
    render(<PermissionsPage />);
    await waitFor(() => expect(calls("audio_level_start")).toHaveLength(1));
    await waitFor(() =>
      expect(fake.handlers.get("audio-level-stopped")?.size).toBe(1)
    );

    // The window was hidden: the subscription is gone, no error
    await emit("audio-level-stopped", { source: "microphone" });
    focusWindow();

    await waitFor(() => expect(calls("audio_level_start")).toHaveLength(2));
  });

  it("shows the reason when the capture stopped with an error", async () => {
    setPermissions("granted", "granted");
    render(<PermissionsPage />);
    await waitFor(() =>
      expect(fake.handlers.get("audio-level-stopped")?.size).toBe(1)
    );

    await emit("audio-level-stopped", {
      message: "Device is busy",
      reason: "busy",
      source: "microphone",
    });

    expect(await screen.findByText("Микрофон занят")).toBeTruthy();
  });

  it("hints at the settings when the system sound stays silent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      setPermissions("granted", "unknown");
      render(<PermissionsPage />);
      await waitFor(() =>
        expect(calls("audio_level_start")[0]?.args).toEqual({
          source: "system",
        })
      );
      await waitFor(() =>
        expect(fake.handlers.get("audio-level")?.size).toBe(1)
      );
      expect(screen.getByText("Проверим звук")).toBeTruthy();
      // Unknown access: "Разрешить" stays, and the step can go on
      expect(screen.getByRole("button", { name: "Разрешить" })).toBeTruthy();

      const silentWhilePlaying = {
        level: 0,
        playing: true,
        source: "system",
      };
      await emit("audio-level", silentWhilePlaying);
      vi.setSystemTime(Date.now() + 2000);
      await emit("audio-level", silentWhilePlaying);
      expect(screen.queryByText("Не слышим звук других приложений")).toBeNull();

      vi.setSystemTime(Date.now() + 2500);
      await emit("audio-level", silentWhilePlaying);
      expect(screen.getByText("Не слышим звук других приложений")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WelcomePage after a restart", () => {
  it("goes on from the step that asked for the restart", () => {
    window.localStorage.setItem(
      "grill.onboarding-resume",
      "/onboarding/permissions"
    );
    render(<WelcomePage />);
    expect(navigation.replace).toHaveBeenCalledWith("/onboarding/permissions");
    expect(window.localStorage.getItem("grill.onboarding-resume")).toBeNull();
  });

  it("ignores a stored route outside onboarding", () => {
    window.localStorage.setItem(
      "grill.onboarding-resume",
      "https://example.com"
    );
    render(<WelcomePage />);
    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("AgentPage in Tauri", () => {
  it("shows the status from the CLI", async () => {
    answer("agent_status", READY);
    render(<AgentPage />);

    expect(await screen.findByText("Подписка активна")).toBeTruthy();
    expect(screen.getByText("версия 2.1.316")).toBeTruthy();
    expect(screen.getByText("Claude Pro")).toBeTruthy();
  });

  it("re-reads the status on focus, but not over a running login", async () => {
    answer("agent_status", NEEDS_LOGIN);
    answer("agent_login_start", LOGIN_URL);
    render(<AgentPage />);
    await screen.findByText("Вход не выполнен");

    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await screen.findByLabelText("Код из браузера");
    focusWindow();
    expect(calls("agent_status")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(calls("agent_login_cancel")).toHaveLength(1));
    // Logged in in a terminal meanwhile
    answer("agent_status", READY);
    focusWindow();
    expect(await screen.findByText("Подписка активна")).toBeTruthy();
  });

  it("installs with progress and cancels the installer", async () => {
    answer("agent_status", { status: "notInstalled" } satisfies AgentState);
    running("agent_install");
    render(<AgentPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Установить" }));
    await waitFor(() =>
      expect(fake.handlers.get("agent-install-progress")?.size).toBe(1)
    );
    await emit("agent-install-progress", {
      progress: 0.5,
      stage: "installing",
    });
    expect(screen.getByText("50%")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    await waitFor(() => expect(calls("agent_install_cancel")).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Установить" })).toBeTruthy();
  });

  it("shows a failed install and copies its log for support", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    answer("agent_status", { status: "notInstalled" } satisfies AgentState);
    fail("agent_install", {
      kind: "External",
      message:
        "Установщик завершился с ошибкой\n\ncurl: (6) Could not resolve host: claude.ai\nexit status 6",
    });
    render(<AgentPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Установить" }));
    expect(
      await screen.findByText("Не получилось установить Claude Code")
    ).toBeTruthy();
    expect(screen.getByText("Установщик завершился с ошибкой")).toBeTruthy();
    expect(screen.getByText(INSTALL_LOG_LINE)).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Скопировать для поддержки" })
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]).toEqual([
      expect.stringContaining("curl: (6) Could not resolve host: claude.ai"),
    ]);
  });

  it("logs in with the code, a refused code shows under the field", async () => {
    answer("agent_status", NEEDS_LOGIN);
    answer("agent_login_start", LOGIN_URL);
    fail("agent_login_submit", { kind: "Invalid", message: "Код не подошёл" });
    render(<AgentPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    fireEvent.change(await screen.findByLabelText("Код из браузера"), {
      target: { value: "wrong-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      LOGIN_CODE_REJECTED
    );
    expect(calls("agent_login_submit")[0]?.args).toEqual({
      code: "wrong-code",
    });
    // The session is over: no second submit into it
    fireEvent.submit(screen.getByRole("form", { name: "Вход в Claude" }));
    expect(calls("agent_login_submit")).toHaveLength(1);

    fake.failures.delete("agent_login_submit");
    answer("agent_login_submit", READY);
    fireEvent.click(screen.getByRole("button", { name: "Войти ещё раз" }));
    await waitFor(() => expect(calls("agent_login_start")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.change(screen.getByLabelText("Код из браузера"), {
      target: { value: "right-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));
    expect(await screen.findByText("Подписка активна")).toBeTruthy();
  });

  it("asks to start over when the login session is gone", async () => {
    answer("agent_status", NEEDS_LOGIN);
    answer("agent_login_start", LOGIN_URL);
    fail("agent_login_submit", {
      kind: "NotFound",
      message: "Вход не начат",
    });
    render(<AgentPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Войти" }));
    fireEvent.change(await screen.findByLabelText("Код из браузера"), {
      target: { value: "late-code" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подтвердить" }));

    expect((await screen.findByRole("alert")).textContent).toBe(LOGIN_EXPIRED);
    expect(screen.getByText("Вход не выполнен")).toBeTruthy();
    expect(screen.queryByLabelText("Код из браузера")).toBeNull();
  });
});

/* ------------------------------------------------------- 03 Speech model */

const TURBO_BYTES = 574_041_195;

function model(
  id: "turbo" | "small",
  state: ModelState,
  selected = id === "turbo"
): SpeechModel {
  return {
    id,
    name: id === "turbo" ? "Whisper large-v3-turbo" : "Whisper small",
    selected,
    sizeBytes: id === "turbo" ? TURBO_BYTES : 487_601_967,
    state,
  };
}

const NOT_DOWNLOADED: ModelState = { status: "notDownloaded" };
const MODEL_READY: ModelState = { status: "ready" };

const PASSED: BenchmarkResult = {
  p95Ms: 1473,
  passed: true,
  rtf: 0.18,
  wer: 0.03,
};
const SLOW: BenchmarkResult = {
  p95Ms: 13_000,
  passed: false,
  reason: "slow",
  rtf: 2.4,
  wer: 0.04,
};

/** Rust reports a model's new state, as `SpeechModelChanged`. */
function modelChanged(changed: SpeechModel) {
  return emit("speech-model-changed", changed);
}

function showsModels(turbo: ModelState, small: ModelState = NOT_DOWNLOADED) {
  answer("speech_models_list", [model("turbo", turbo), model("small", small)]);
}

describe("SpeechPage in Tauri", () => {
  beforeEach(() => {
    answer("speech_mic_check", "");
  });

  it("follows the download through its states to a checked, ready model", async () => {
    showsModels(NOT_DOWNLOADED);
    answer(
      "speech_model_download",
      model("turbo", { bytesPerSec: 0, percent: 0, status: "downloading" })
    );
    answer(
      "speech_model_pause",
      model("turbo", { percent: 40, status: "paused" })
    );
    const benchmark = running("speech_benchmark");
    const micCheck = running("speech_mic_check");
    render(<SpeechPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Скачать" }));
    await modelChanged(
      model("turbo", {
        bytesPerSec: 20_000_000,
        percent: 40,
        status: "downloading",
      })
    );
    expect(
      screen.getByText("Скачиваем модель для русского языка")
    ).toBeTruthy();
    expect(screen.getByText("230 МБ из 574 МБ, 20,0 МБ/с")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Пауза" }));
    await waitFor(() => expect(calls("speech_model_pause")).toHaveLength(1));
    expect(screen.getByText("Модель для русского языка на паузе")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await waitFor(() =>
      expect(calls("speech_model_download")).toEqual([
        { args: { id: "turbo" }, command: "speech_model_download" },
        { args: { id: "turbo" }, command: "speech_model_download" },
      ])
    );

    await modelChanged(model("turbo", { status: "checking" }));
    expect(screen.getByText("Проверяем модель")).toBeTruthy();

    // Ready: "проверяем" is now the hardware check
    await modelChanged(model("turbo", MODEL_READY));
    expect(
      screen.getByText("Проверяем, как компьютер справляется")
    ).toBeTruthy();
    expect(calls("speech_benchmark")).toEqual([
      { args: { model: "turbo" }, command: "speech_benchmark" },
    ]);

    await act(async () => {
      benchmark(PASSED);
      await Promise.resolve();
    });
    expect(await screen.findByText("Модель готова")).toBeTruthy();

    // The mic check: what the model heard, at once
    await waitFor(() => expect(calls("speech_mic_check")).toHaveLength(1));
    await act(async () => {
      micCheck("Привет, это проверка");
      await Promise.resolve();
    });
    expect(await screen.findByText("Привет, это проверка")).toBeTruthy();
  });

  it("says how much space is missing", async () => {
    showsModels({
      freeBytes: 300_000_000,
      needBytes: 631_445_315,
      status: "noSpace",
    });
    render(<SpeechPage />);

    expect(await screen.findByText("Не хватает места на диске")).toBeTruthy();
    expect(
      screen.getByText(
        "Для модели нужно 631 МБ, а свободно только 300 МБ. Очистите корзину или удалите старые загрузки, потом нажмите «Повторить»."
      )
    ).toBeTruthy();
    expect(screen.getByText("не хватает 331 МБ")).toBeTruthy();
  });

  it("counts down to the next try when the network drops", async () => {
    showsModels({ percent: 60, retryInSec: 20, status: "noNetwork" });
    answer(
      "speech_model_download",
      model("turbo", { bytesPerSec: 0, percent: 60, status: "downloading" })
    );
    render(<SpeechPage />);

    expect(await screen.findByText("Загрузка прервалась на 60%")).toBeTruthy();
    expect(screen.getByText("сами попробуем снова через 0:20")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Повторить сейчас" }));
    await waitFor(() => expect(calls("speech_model_download")).toHaveLength(1));
  });

  it("offers the small model when turbo is too slow, then checks it", async () => {
    showsModels(MODEL_READY);
    answer("speech_benchmark", SLOW);
    answer(
      "speech_model_download",
      model("small", { bytesPerSec: 0, percent: 0, status: "downloading" })
    );
    answer("speech_model_select", model("small", MODEL_READY, true));
    render(<SpeechPage />);

    expect(
      await screen.findByText("Компьютер не успевает за разговором")
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Фраза расшифровывается за 13,0 с, а для живой ленты нужно до 3 с. Запасная модель быстрее, около 490 МБ, чуть менее точная."
      )
    ).toBeTruthy();
    // The model can still be used
    expect(screen.getByRole("link", { name: "Продолжить" })).toBeTruthy();

    answer("speech_benchmark", PASSED);
    fireEvent.click(
      screen.getByRole("button", { name: "Скачать запасную модель" })
    );
    await waitFor(() =>
      expect(calls("speech_model_download")).toEqual([
        { args: { id: "small" }, command: "speech_model_download" },
      ])
    );

    // Small is ready: it is selected and checked in turn
    await modelChanged(model("small", MODEL_READY, false));
    await waitFor(() =>
      expect(calls("speech_model_select")).toEqual([
        { args: { id: "small" }, command: "speech_model_select" },
      ])
    );
    await waitFor(() =>
      expect(calls("speech_benchmark").at(-1)).toEqual({
        args: { model: "small" },
        command: "speech_benchmark",
      })
    );
    expect(await screen.findByText("Модель готова")).toBeTruthy();
  });

  it("says recognition works wrong when the check finds errors", async () => {
    showsModels(MODEL_READY);
    answer("speech_benchmark", {
      p95Ms: 900,
      passed: false,
      reason: "inaccurate",
      rtf: 0.1,
      wer: 0.6,
    } satisfies BenchmarkResult);
    render(<SpeechPage />);

    expect(
      await screen.findByText("Распознавание работает неправильно")
    ).toBeTruthy();
    expect(
      screen.getByText(
        "На проверочных фразах модель ошиблась в 60% слов. Скачайте её заново; если не поможет, напишите нам."
      )
    ).toBeTruthy();
  });

  it("stores the call language in the settings", async () => {
    showsModels(NOT_DOWNLOADED);
    render(<SpeechPage />);
    await screen.findByRole("button", { name: "Скачать" });

    fireEvent.click(screen.getByRole("radio", { name: "Українська" }));
    await waitFor(() =>
      expect(calls("settings_update")).toEqual([
        {
          args: { patch: { callLanguage: "uk" } },
          command: "settings_update",
        },
      ])
    );
    expect(screen.getByText("Модель для украинского языка")).toBeTruthy();
  });
});
