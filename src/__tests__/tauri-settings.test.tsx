import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, Fiber, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentState, AudioInputs, CommandError, Value } from "@/bindings";
import type { SettingsBackend as SettingsTag } from "@/features/settings/backend";

type SettingsService = SettingsTag["Service"];

/*
 * Settings in Tauri mode, over the fake IPC (./helpers/fake-tauri.ts): the
 * sections read the system through `SettingsBackend.layerTauri` (the
 * microphones, the level meters, the mic check, the recordings' folder,
 * the data summary, Claude Code and its limit), and every write goes
 * through `settings_update`, which the fake checks as Rust does.
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const opener = vi.hoisted(() => ({
  revealItemInDir: vi.fn((_path: string) => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
const FOCUS = "tauri://focus";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    listen: fake.listen,
    onFocusChanged: (handler: (event: { payload: boolean }) => void) =>
      fake.listen(FOCUS, () => handler({ payload: true })),
  }),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: opener.revealItemInDir,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/audio",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: nav.push,
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const { AudioSection } = await import(
  "@/features/settings/pages/audio-section"
);
const { GeneralSection } = await import(
  "@/features/settings/pages/general-section"
);
const { PrivacySection } = await import(
  "@/features/settings/pages/privacy-section"
);
const { AgentSection } = await import(
  "@/features/settings/pages/agent-section"
);
const { IntegrationsSection } = await import(
  "@/features/settings/pages/integrations-section"
);
const { WidgetSection } = await import(
  "@/features/settings/pages/widget-section"
);
const { DefaultSidebarStatus } = await import("@/features/shell/app-sidebar");
const { publishAgentState } = await import("@/features/settings/agent-status");
const { IDLE_SESSION } = await import("./helpers/fake-tauri");
const { settingProblem } = await import("@/data/services/setting-checks");
const { getSettings, refreshSettings, resetSettings } = await import(
  "@/data/settings"
);
const { toast } = await import("@/components/ui/toast");
const { SettingsBackend } = await import("@/features/settings/backend");

/** Runs an operation of `SettingsBackend.layerTauri`. */
function runBackend<A, E>(
  use: (backend: SettingsService) => Effect.Effect<A, E>
) {
  return Effect.runPromise(
    SettingsBackend.use(use).pipe(Effect.provide(SettingsBackend.layerTauri))
  );
}
const MACBOOK = {
  id: "Микрофон MacBook Pro",
  isDefault: true,
  name: "Микрофон MacBook Pro",
};
const AIRPODS = { id: "AirPods Pro", isDefault: false, name: "AirPods Pro" };
const USB = {
  id: "USB Audio Device",
  isDefault: false,
  name: "USB Audio Device",
};

/** 12:41 today. */
const AT_12_41 = new Date().setHours(12, 41, 0, 0);

/** Keys the screens wrote before Rust checked them (decision 6). */
const REMOVED_KEYS = [
  "systemAudio",
  "recordingsFolder",
  "interfaceLanguage",
  "finalCheck",
  "agentSignedIn",
];

function invokedWith(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

/** Every patch `settings_update` got. */
function settingPatches() {
  return invokedWith("settings_update").map(
    (args) => (args?.patch ?? {}) as { [key: string]: Value }
  );
}

function inputs(next: Partial<AudioInputs>): AudioInputs {
  return {
    devices: [MACBOOK],
    missingSince: null,
    selected: "system",
    ...next,
  };
}

/** Plays an event as Rust sends it, and lets the screen take it. */
async function emit(event: string, payload: unknown) {
  await act(async () => {
    fake.emit(event, payload);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** Opens the microphone select and picks `name`. */
async function pickMicrophone(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: MICROPHONE }));
  await user.click(await screen.findByRole("option", { name }));
}

async function microphoneOptions() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: MICROPHONE }));
  const listbox = await screen.findByRole("listbox");
  const names = within(listbox)
    .getAllByRole("option")
    .map((option) => option.textContent);
  await user.keyboard("{Escape}");
  return names;
}

const MICROPHONE = /Микрофон, канал «Вы»/u;
const CLAUDE_NOT_INSTALLED = /Claude Code\s*не установлен/u;
const CLAUDE_NEEDS_LOGIN = /Claude Code\s*нужен вход/u;
const CLAUDE_READY = /Claude Code\s*готов к звонку/u;
const MIC_LEVEL = "Уровень микрофона";

/** The caption next to a level meter. */
function meterCaption(label: string) {
  const meter = screen.getByRole("progressbar", { name: label });
  return meter.parentElement?.textContent ?? "";
}

beforeEach(async () => {
  fake.answers.clear();
  fake.failures.clear();
  fake.audioInputs = inputs({});
  fake.db.settings = { onboardingCompleted: true };
  await act(() => refreshSettings());
  act(() => fake.setSession(IDLE_SESSION));
  fake.invoked.length = 0;
  nav.push.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsBackend.layerTauri", () => {
  it("reads the microphones, then their changes, while subscribed", async () => {
    const fiber = Effect.runFork(
      SettingsBackend.use((backend) =>
        Stream.runCollect(Stream.take(backend.audioInputs, 2))
      ).pipe(Effect.provide(SettingsBackend.layerTauri))
    );
    await waitFor(() =>
      expect(invokedWith("audio_inputs_get")).toHaveLength(1)
    );
    fake.emit("audio-inputs-changed", inputs({ devices: [MACBOOK, USB] }));
    const [now, changed] = Array.from(
      await Effect.runPromise(Fiber.join(fiber))
    );
    expect(now?.devices).toEqual([MACBOOK]);
    expect(changed?.devices).toEqual([MACBOOK, USB]);
    expect(invokedWith("audio_inputs_start")).toHaveLength(1);
    expect(invokedWith("audio_inputs_stop")).toHaveLength(1);
  });

  it("turns the level into percent and fails with the capture's reason", async () => {
    const fiber = Effect.runFork(
      SettingsBackend.use((backend) =>
        Stream.runCollect(backend.inputLevel("system"))
      ).pipe(Effect.provide(SettingsBackend.layerTauri))
    );
    await waitFor(() =>
      expect(invokedWith("audio_level_start")).toEqual([{ source: "system" }])
    );
    fake.emit("audio-level", { level: 0.42, source: "system" });
    fake.emit("audio-level-stopped", { reason: "busy", source: "system" });
    const exit = await Effect.runPromise(Effect.exit(Fiber.join(fiber)));
    expect(JSON.stringify(exit)).toContain("busy");
    expect(invokedWith("audio_level_stop")).toEqual([{ source: "system" }]);
  });

  it("runs each command of the section", async () => {
    fake.answers.set("speech_mic_check", () => "раз, два");
    fake.answers.set("agent_check_path", () => ({ status: "notInstalled" }));
    fake.answers.set("data_delete_all", () => null);

    expect(await runBackend((backend) => backend.soundCheck)).toBe("раз, два");
    expect(
      await runBackend((backend) => backend.checkAgent("/bin/claude"))
    ).toEqual({ status: "notInstalled" });
    expect(invokedWith("agent_check_path")).toEqual([{ path: "/bin/claude" }]);
    expect((await runBackend((backend) => backend.checkAgent())).status).toBe(
      "ready"
    );
    expect(await runBackend((backend) => backend.agentUsage)).toBeNull();
    expect((await runBackend((backend) => backend.recordingsInfo)).path).toBe(
      "/tmp/grill/recordings"
    );
    expect(
      (await runBackend((backend) => backend.dataSummary)).projects
    ).toBeTypeOf("number");
    await runBackend((backend) => backend.deleteAllData);
    expect(invokedWith("data_delete_all")).toHaveLength(1);
    await runBackend((backend) => backend.revealInFinder("/tmp/grill"));
    expect(opener.revealItemInDir).toHaveBeenCalledWith("/tmp/grill");
  });
});

describe("«Звук» in Tauri", () => {
  it("Выбрать AirPods: the list is the computer's, the choice is saved and heard", async () => {
    fake.audioInputs = inputs({ devices: [MACBOOK, AIRPODS] });
    render(<AudioSection />);

    await waitFor(() =>
      expect(invokedWith("audio_inputs_start")).toHaveLength(1)
    );
    expect(await microphoneOptions()).toEqual([
      "Как в системе",
      "Микрофон MacBook Pro",
      "AirPods Pro",
    ]);

    await pickMicrophone("AirPods Pro");
    await waitFor(() =>
      expect(settingPatches()).toContainEqual({ microphone: "AirPods Pro" })
    );
    expect(getSettings().microphone).toBe("AirPods Pro");

    // Rust restarts the capture on the new device; its level shows.
    await emit("audio-level", { level: 0.6, source: "microphone" });
    expect(
      screen
        .getByRole("progressbar", { name: MIC_LEVEL })
        .getAttribute("aria-valuenow")
    ).toBe("60");
    expect(meterCaption(MIC_LEVEL)).toContain("слышу вас");
  });

  it("Подключили устройство: it appears in the list", async () => {
    render(<AudioSection />);
    await waitFor(() =>
      expect(invokedWith("audio_inputs_get")).toHaveLength(1)
    );

    await emit("audio-inputs-changed", inputs({ devices: [MACBOOK, USB] }));
    expect(await microphoneOptions()).toContain("USB Audio Device");
  });

  it("Отключили AirPods: the banner with the time, the meter follows the default input", async () => {
    fake.db.settings = { microphone: "AirPods Pro", onboardingCompleted: true };
    await act(() => refreshSettings());
    fake.audioInputs = inputs({
      missingSince: AT_12_41,
      selected: "AirPods Pro",
    });
    fake.invoked.length = 0;
    render(<AudioSection />);

    const banner = await screen.findByRole("alert");
    expect(
      within(banner).getByText("Микрофон «AirPods Pro» отключён")
    ).toBeTruthy();
    expect(banner.textContent).toContain("Отключён с 12:41");
    await waitFor(() =>
      expect(invokedWith("audio_level_start")).toContainEqual({
        source: "microphone",
      })
    );

    // The capture lost its device, then the list changed: listen again.
    await emit("audio-level-stopped", {
      message: "Устройство отключено",
      reason: "noDevice",
      source: "microphone",
    });
    expect(meterCaption(MIC_LEVEL)).toContain("нет устройства");
    const starts = invokedWith("audio_level_start").length;
    await emit(
      "audio-inputs-changed",
      inputs({ missingSince: AT_12_41, selected: "AirPods Pro" })
    );
    await waitFor(() =>
      expect(invokedWith("audio_level_start").length).toBeGreaterThan(starts)
    );
    await emit("audio-level", { level: 0.3, source: "microphone" });
    expect(meterCaption(MIC_LEVEL)).toContain("слышу вас");

    fireEvent.click(
      within(banner).getByRole("button", {
        name: "Взять микрофон по умолчанию",
      })
    );
    await waitFor(() =>
      expect(settingPatches()).toContainEqual({ microphone: "system" })
    );
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("Микрофон выключен: the meter says «нет доступа» instead of a level", async () => {
    fake.answers.set("audio_level_start", (args) => {
      if (args.source !== "microphone") {
        return null;
      }
      const denied: CommandError = {
        kind: "External",
        message: "Нет доступа к микрофону",
        reason: "noAccess",
      };
      return Promise.reject(denied);
    });
    render(<AudioSection />);

    await waitFor(() =>
      expect(meterCaption(MIC_LEVEL)).toContain("нет доступа")
    );
    expect(meterCaption("Уровень системного звука")).toContain("тишина");
  });

  it("Проверка звука: the recognized text, or why it can't check", async () => {
    fake.answers.set("speech_mic_check", () => "Раз, два, три.");
    render(<AudioSection />);

    fireEvent.click(screen.getByRole("button", { name: "Проверить звук" }));
    expect(await screen.findByText("«Раз, два, три.»")).toBeTruthy();
    expect(invokedWith("speech_mic_check")).toHaveLength(1);

    fake.failures.set("speech_mic_check", {
      kind: "Invalid",
      message: "Модель распознавания не скачана",
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить звук" }));
    expect(
      await screen.findByText("Модель распознавания не скачана")
    ).toBeTruthy();
  });

  it("Скрыли и показали окно: listens to the devices again and reads them anew", async () => {
    render(<AudioSection />);
    await waitFor(() =>
      expect(invokedWith("audio_inputs_start")).toHaveLength(1)
    );
    // The focus while subscribed changes nothing.
    await emit(FOCUS, true);
    expect(invokedWith("audio_inputs_start")).toHaveLength(1);

    // The window hides: Rust dropped the subscription.
    await emit("audio-inputs-stopped", null);
    fake.audioInputs = inputs({ devices: [MACBOOK, USB] });
    await emit(FOCUS, true);
    await waitFor(() =>
      expect(invokedWith("audio_inputs_start")).toHaveLength(2)
    );
    expect(invokedWith("audio_inputs_get")).toHaveLength(2);
    expect(await microphoneOptions()).toContain("USB Audio Device");

    // A second focus doesn't subscribe twice.
    await emit(FOCUS, true);
    expect(invokedWith("audio_inputs_start")).toHaveLength(2);
  });

  it("stops listening to the devices when the section closes", async () => {
    const { unmount } = render(<AudioSection />);
    await waitFor(() =>
      expect(invokedWith("audio_inputs_start")).toHaveLength(1)
    );
    unmount();
    await waitFor(() =>
      expect(invokedWith("audio_inputs_stop")).toHaveLength(1)
    );
    expect(invokedWith("audio_level_stop")).toEqual(
      expect.arrayContaining([{ source: "microphone" }, { source: "system" }])
    );
  });
});

describe("Убранные контролы", () => {
  it("shows none of the controls that changed nothing", async () => {
    const audio = render(<AudioSection />);
    expect(screen.queryByText("Только Zoom")).toBeNull();
    expect(screen.queryByText("Весь системный звук")).toBeNull();
    expect(screen.getByText(SYSTEM_AUDIO)).toBeTruthy();
    expect(
      await screen.findByText("Доступ к системному звуку есть")
    ).toBeTruthy();
    audio.unmount();

    const general = render(<GeneralSection />);
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(screen.queryByText("Язык интерфейса")).toBeNull();
    general.unmount();

    const privacy = render(<PrivacySection />);
    expect(screen.queryByText("Экспорт данных")).toBeNull();
    expect(screen.queryByRole("button", { name: "Экспортировать" })).toBeNull();
    privacy.unmount();

    render(<AgentSection />);
    await screen.findByText("Выполнен, подписка Max");
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull();
    expect(screen.queryByText("Финальная проверка")).toBeNull();
  });
});

const SYSTEM_AUDIO = /Звук других приложений, без звука Grill/u;

describe("«Общие» and «Приватность» in Tauri", () => {
  const FOLDER = "/Users/dima/Library/Application Support/app.grill/recordings";

  it("Показать в Finder: the real folder, its size and calls; Finder opens it", async () => {
    fake.answers.set("recordings_info", () => ({
      bytes: 13_000_000,
      calls: 2,
      path: FOLDER,
    }));
    render(<GeneralSection />);

    expect(await screen.findByText(FOLDER)).toBeTruthy();
    expect(
      screen.getByText("Аудио звонков. Занято 13 МБ, 2 звонка")
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Показать в Finder" }));
    await waitFor(() =>
      expect(opener.revealItemInDir).toHaveBeenCalledWith(FOLDER)
    );
  });

  it("names the data «Удалить всё» deletes from data_summary", async () => {
    fake.answers.set("data_summary", () => ({
      bytes: 2_500_000_000,
      calls: 5,
      projects: 2,
    }));
    render(<PrivacySection />);

    expect(
      await screen.findByText(
        "2 проекта, 5 звонков, 2,5 ГБ аудио и профили людей. Подключения сервисов тоже сбросятся"
      )
    ).toBeTruthy();
  });

  it("Удалить всё: data_delete_all does it all, the stores delete nothing", async () => {
    fake.answers.set("data_delete_all", () => null);
    const add = vi.spyOn(toast, "add");
    const user = userEvent.setup();
    render(<PrivacySection />);

    await user.click(screen.getByRole("button", { name: "Очистить всё" }));
    const dialog = await screen.findByRole("alertdialog", {
      name: "Удалить всё из Grill?",
    });
    await user.type(within(dialog).getByRole("textbox"), "удалить");
    await user.click(
      within(dialog).getByRole("button", { name: "Удалить всё" })
    );

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith("/"));
    expect(invokedWith("data_delete_all")).toHaveLength(1);
    expect(invokedWith("projects_delete")).toEqual([]);
    expect(invokedWith("call_discard")).toEqual([]);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Всё удалено" })
    );
  });

  it("Удалить всё: a part Rust could not do is said, the rest is done", async () => {
    fake.failures.set("data_delete_all", {
      kind: "External",
      message: "Секрет Outline остался в Keychain",
    });
    const add = vi.spyOn(toast, "add");
    const user = userEvent.setup();
    render(<PrivacySection />);

    await user.click(screen.getByRole("button", { name: "Очистить всё" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.type(within(dialog).getByRole("textbox"), "удалить");
    await user.click(
      within(dialog).getByRole("button", { name: "Удалить всё" })
    );

    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Секрет Outline остался в Keychain",
          type: "warning",
        })
      )
    );
    expect(nav.push).toHaveBeenCalledWith("/");
  });
});

describe("«Агент» in Tauri", () => {
  it("Вход не выполнен: the version, «нужен вход», and «Войти» through the onboarding login", async () => {
    let agent: AgentState = { status: "needsLogin", version: "2.1.20" };
    fake.answers.set("agent_status", () => agent);
    fake.answers.set("agent_login_start", () => "https://claude.ai/oauth");
    fake.answers.set("agent_login_submit", () => {
      agent = { status: "ready", subscriptionType: "pro", version: "2.1.20" };
      return agent;
    });
    const user = userEvent.setup();
    render(<AgentSection />);

    expect(await screen.findByText("нужен вход")).toBeTruthy();
    expect(screen.getByText("2.1.20")).toBeTruthy();
    expect(screen.getByText("найден автоматически")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Войти" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Вход в Claude Code",
    });
    const form = await within(dialog).findByRole("form", {
      name: "Вход в Claude",
    });
    await user.type(within(form).getByRole("textbox"), "code-12345678");
    await user.click(within(form).getByRole("button", { name: "Подтвердить" }));

    expect(await screen.findByText("Выполнен, подписка Pro")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(invokedWith("agent_login_submit")).toEqual([
      { code: "code-12345678" },
    ]);
  });

  it("Claude Code in the sidebar: what agent_status says, a link to «Агент»", async () => {
    let agent: AgentState = { status: "notInstalled" };
    fake.answers.set("agent_status", () => agent);
    // Forget what the earlier tests read: a state that is not ready is
    // read again by the next row.
    act(() => publishAgentState({ message: "", status: "error" }));
    const sidebar = render(<DefaultSidebarStatus />);

    const row = await screen.findByRole("link", {
      name: CLAUDE_NOT_INSTALLED,
    });
    expect(row.getAttribute("href")).toBe("/settings/agent");
    expect(screen.queryByText("Запись не идёт")).toBeNull();
    sidebar.unmount();

    agent = { status: "needsLogin", version: "2.1.20" };
    render(<DefaultSidebarStatus />);
    expect(
      await screen.findByRole("link", { name: CLAUDE_NEEDS_LOGIN })
    ).toBeTruthy();

    // «Проверить снова» of the section updates the row.
    agent = { status: "ready", subscriptionType: "max", version: "2.1.20" };
    render(<AgentSection />);
    expect(
      await screen.findByRole("link", { name: CLAUDE_READY })
    ).toBeTruthy();
  });

  it("Лимит: the last share with its time, or «нет данных»", async () => {
    fake.answers.set("agent_usage", () => ({
      measuredAt: AT_12_41,
      utilization: 0.82,
    }));
    const { unmount } = render(<AgentSection />);

    expect(await screen.findByText("Использовано 82 %")).toBeTruthy();
    expect(screen.getByText("12:41")).toBeTruthy();
    unmount();

    fake.answers.set("agent_usage", () => null);
    render(<AgentSection />);
    expect(await screen.findByText("нет данных")).toBeTruthy();
  });

  it("checks another path and saves only a CLI that answers", async () => {
    fake.answers.set("agent_check_path", (args) =>
      String(args.path).endsWith("/claude")
        ? { status: "ready", subscriptionType: "max", version: "2.2.0" }
        : { status: "notInstalled" }
    );
    const user = userEvent.setup();
    render(<AgentSection />);
    await screen.findByText("Выполнен, подписка Max");

    await user.click(screen.getByRole("button", { name: "Указать другой" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Где лежит Claude Code",
    });
    const field = within(dialog).getByRole("textbox");
    await user.type(field, "/usr/local/bin/node");
    await user.click(
      within(dialog).getByRole("button", { name: "Проверить и сохранить" })
    );
    expect(
      await within(dialog).findByText(
        "По пути /usr/local/bin/node нет Claude Code"
      )
    ).toBeTruthy();
    expect(settingPatches()).toEqual([]);

    await user.clear(field);
    await user.type(field, "/opt/homebrew/bin/claude");
    await user.click(
      within(dialog).getByRole("button", { name: "Проверить и сохранить" })
    );
    await waitFor(() =>
      expect(settingPatches()).toEqual([
        { agentPath: "/opt/homebrew/bin/claude" },
      ])
    );
    expect(await screen.findByText("2.2.0")).toBeTruthy();
  });

  it("shows the version Claude Code reports in «Интеграции»", async () => {
    fake.answers.set("agent_status", () => ({
      status: "needsLogin",
      version: "2.1.33",
    }));
    fake.answers.set("connectors_list", () => []);
    render(<IntegrationsSection />);

    expect(await screen.findByText("2.1.33")).toBeTruthy();
  });
});

describe("settings writes", () => {
  it("send only the keys and values Rust takes", async () => {
    const user = userEvent.setup();
    // Values the demo stored before the check read as the present ones.
    fake.db.settings = {
      audioRetention: "30d",
      microphone: "airpods",
      onboardingCompleted: true,
      transcriptRetention: "6m",
    };
    await act(() => refreshSettings());
    expect(getSettings()).toMatchObject({
      audioRetention: "30",
      microphone: "system",
      transcriptRetention: "180",
    });

    await act(() => resetSettings());
    render(
      <>
        <GeneralSection />
        <PrivacySection />
        <AgentSection />
        <WidgetSection />
      </>
    );
    await user.click(screen.getByRole("combobox", { name: AUDIO_RETENTION }));
    await user.click(await screen.findByRole("option", { name: "7 дней" }));
    await user.click(
      screen.getByRole("combobox", { name: TRANSCRIPT_RETENTION })
    );
    await user.click(await screen.findByRole("option", { name: "Через год" }));
    await user.click(screen.getByRole("button", { name: "Украинский" }));
    await user.click(screen.getByRole("button", { name: "Реже" }));
    await user.click(screen.getByRole("button", { name: "5" }));
    await user.click(screen.getByRole("button", { name: "Никогда" }));

    await waitFor(() =>
      expect(settingPatches()).toContainEqual({ transcriptRetention: "365" })
    );
    const patches = settingPatches();
    expect(patches).toContainEqual({ audioRetention: "7" });
    for (const patch of patches) {
      for (const [key, value] of Object.entries(patch)) {
        expect(REMOVED_KEYS).not.toContain(key);
        expect(settingProblem(key, value)).toBeNull();
      }
    }
  });
});

const AUDIO_RETENTION = /Аудиозаписи звонков/u;
const TRANSCRIPT_RETENTION = /Расшифровки/u;
