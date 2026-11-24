import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelState, SpeechModel } from "@/bindings";

/*
 * Settings → «Звук и распознавание» in Tauri mode, over the fake IPC
 * (./helpers/fake-tauri.ts): both Whisper models come from
 * `speech_models_list` and follow `SpeechModelChanged`; a ready one can be
 * removed or selected, except the selected one during a call; the hardware
 * check's result is one line with «Проверить снова».
 */

const fake = await vi.hoisted(async () => {
  (globalThis as { isTauri?: boolean }).isTauri = true;
  const { createFakeTauri } = await import("./helpers/fake-tauri");
  return createFakeTauri();
});

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: fake.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: vi.fn(() => Promise.resolve()),
  listen: fake.listen,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", listen: fake.listen }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/audio",
  useRouter: () => ({
    back: vi.fn(),
    prefetch: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

const { AudioSection } = await import(
  "@/features/settings/pages/audio-section"
);
const { IDLE_SESSION, liveSession } = await import("./helpers/fake-tauri");
const { refreshSettings } = await import("@/data/settings");
const { toast } = await import("@grill/ui/toast");

function model(
  id: "turbo" | "small",
  state: ModelState,
  selected = id === "turbo"
): SpeechModel {
  return {
    id,
    name: id === "turbo" ? "Whisper large-v3-turbo" : "Whisper small",
    selected,
    sizeBytes: id === "turbo" ? 574_041_195 : 487_601_967,
    state,
  };
}

const READY: ModelState = { status: "ready" };
const GIGAAM = /GigaAM/u;
const UPDATE = /Обновить/u;
const TURBO_NAME = /Whisper large-v3-turbo/u;
const SMALL_NAME = /Whisper small/u;

function calls(command: string) {
  return fake.invoked
    .filter((call) => call.command === command)
    .map((call) => call.args);
}

async function modelChanged(changed: SpeechModel) {
  await act(async () => {
    fake.emit("speech-model-changed", changed);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** The row of a model, by its name. */
function row(name: string) {
  const title = screen.getByText(name);
  const found = title.closest<HTMLElement>('[data-slot="settings-radio-row"]');
  if (!found) {
    throw new Error(`Нет строки ${name}`);
  }
  return within(found);
}

beforeEach(async () => {
  fake.answers.clear();
  fake.failures.clear();
  fake.db.settings = { onboardingCompleted: true };
  fake.answers.set("speech_models_list", () => [
    model("turbo", READY),
    model("small", { status: "notDownloaded" }),
  ]);
  await act(() => refreshSettings());
  act(() => fake.setSession(IDLE_SESSION));
  fake.invoked.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Звук и распознавание in Tauri", () => {
  it("lists the two Whisper models, without GigaAM and «Обновить»", async () => {
    render(<AudioSection />);

    expect(await screen.findByText("Whisper small")).toBeTruthy();
    expect(screen.getByText("Whisper large-v3-turbo")).toBeTruthy();
    expect(screen.queryByText(GIGAAM)).toBeNull();
    expect(screen.queryByRole("button", { name: UPDATE })).toBeNull();
    expect(
      screen
        .getByRole("radio", { name: TURBO_NAME })
        .getAttribute("aria-checked")
    ).toBe("true");
  });

  it("downloads a model: its row shows the progress, then «Удалить»", async () => {
    fake.answers.set("speech_model_download", () =>
      model("small", { bytesPerSec: 0, percent: 0, status: "downloading" })
    );
    render(<AudioSection />);
    await screen.findByText("Whisper small");

    fireEvent.click(
      row("Whisper small").getByRole("button", { name: "Скачать" })
    );
    await waitFor(() =>
      expect(calls("speech_model_download")).toEqual([{ id: "small" }])
    );

    await modelChanged(
      model("small", {
        bytesPerSec: 9_000_000,
        percent: 30,
        status: "downloading",
      })
    );
    expect(
      screen.getByRole("progressbar", { name: "Загрузка Whisper small" })
    ).toHaveProperty("ariaValueNow", "30");
    expect(row("Whisper small").getByText("30%")).toBeTruthy();

    await modelChanged(model("small", READY));
    expect(
      row("Whisper small").getByRole("button", { name: "Удалить" })
    ).toBeTruthy();

    // A ready model can be picked to recognize with
    fake.answers.set("speech_model_select", () => model("small", READY, true));
    fireEvent.click(screen.getByRole("radio", { name: SMALL_NAME }));
    await waitFor(() =>
      expect(calls("speech_model_select")).toEqual([{ id: "small" }])
    );
  });

  it("keeps the selected model during a call", async () => {
    fake.answers.set("speech_models_list", () => [
      model("turbo", READY),
      model("small", READY),
    ]);
    act(() => fake.setSession(liveSession()));
    render(<AudioSection />);
    await screen.findByText("Whisper small");

    expect(
      row("Whisper large-v3-turbo").getByRole("button", { name: "Удалить" })
    ).toHaveProperty("disabled", true);
    expect(
      row("Whisper small").getByRole("button", { name: "Удалить" })
    ).toHaveProperty("disabled", false);
    // Never checked: «Проверить», not «снова».
    expect(screen.getByRole("button", { name: "Проверить" })).toHaveProperty(
      "disabled",
      true
    );
  });

  it("says why the backend refused to remove the model", async () => {
    // Another window records: this one doesn't know of a call.
    fake.failures.set("speech_model_remove", {
      kind: "Invalid",
      message: "Модель, которой идёт расшифровка, нельзя удалить",
    });
    const add = vi.spyOn(toast, "add");
    render(<AudioSection />);
    await screen.findByText("Whisper small");

    fireEvent.click(
      row("Whisper large-v3-turbo").getByRole("button", { name: "Удалить" })
    );
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          description: "Модель, которой идёт расшифровка, нельзя удалить",
          title: "Модель не удалилась",
          type: "error",
        })
      )
    );
    expect(
      row("Whisper large-v3-turbo").getByRole("button", { name: "Удалить" })
    ).toBeTruthy();
  });

  it("«Проверить» before the first check; without the model it says to download it", async () => {
    fake.answers.set("speech_models_list", () => [
      model("turbo", { status: "notDownloaded" }),
      model("small", { status: "notDownloaded" }),
    ]);
    render(<AudioSection />);
    await screen.findByText("Whisper small");

    const check = screen.getByRole("button", { name: "Проверить" });
    expect(check).toHaveProperty("disabled", true);
    expect(screen.getByText("Сначала скачайте модель")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Проверить снова" })
    ).toBeNull();
  });

  it("shows the hardware check in a line and runs it again", async () => {
    fake.db.settings = {
      onboardingCompleted: true,
      speechBenchmark: {
        turbo: {
          checkedAt: 1,
          p95Ms: 13_000,
          passed: false,
          reason: "slow",
          rtf: 2.4,
          wer: 0.04,
        },
      },
    };
    await act(() => refreshSettings());
    let finish: (value: unknown) => void = () => undefined;
    fake.answers.set(
      "speech_benchmark",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    render(<AudioSection />);

    expect(
      await screen.findByText(
        "Не успевает: фраза за 13,0 с, нужно до 3 с. Живая расшифровка будет отставать, полная появится после звонка"
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    expect(await screen.findByText("Проверяю…")).toBeTruthy();
    expect(calls("speech_benchmark")).toEqual([{ model: "turbo" }]);

    await act(async () => {
      finish({ p95Ms: 1473, passed: true, rtf: 0.18, wer: 0.032 });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(
      screen.getByText("Успевает: фраза расшифровывается за 1,5 с, ошибок 3%")
    ).toBeTruthy();
  });
});
