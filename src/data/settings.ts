"use client";

import { toast } from "@grill/ui/toast";
import { Effect } from "effect";
import type { BenchmarkResult } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";
import { SHORTCUTS } from "@/features/settings/mock";

import {
  ONBOARDING_COMPLETED,
  SettingsData,
  type SettingsMap,
} from "./services/settings";
import { createStore } from "./store";
import { createSyncedStore } from "./synced-store";

/*
 * App preferences from Settings. Every control writes here at once, there
 * is no "Save" button. In Tauri they go to the local database through
 * `settings_update`, which also applies autostart, hiding from screen
 * sharing and the global shortcuts; in the browser the mock keeps them in
 * localStorage.
 */

export interface SettingsValues {
  /**
   * The thresholds of Grill on the subscription limit: "90" | "80" | "70" |
   * "50" percents, or "off" («Без ограничения»).
   */
  agentLimitSession: string;
  agentLimitWeek: string;
  /** The agent CLI; `null`: Rust finds it by itself. */
  agentPath: string | null;
  /** Days, "7" | "30" | "90", or "never". */
  audioRetention: string;
  autoEnd: string;
  callLanguage: string;
  compactOverlay: boolean;
  hideOnShare: boolean;
  launchAtLogin: boolean;
  micBusyBehavior: string;
  /** "system" («Как в системе») or the chosen device's name. */
  microphone: string;
  questionCount: string;
  questionFrequency: string;
  /** Global shortcuts by action id; an empty list means "not set". */
  shortcuts: Record<string, string[]>;
  /**
   * The hardware check by model id, as the check stored it. Read only:
   * Rust writes it (`speech_benchmark`).
   */
  speechBenchmark: Partial<Record<string, StoredBenchmark>>;
  theme: string;
  /** Days, "90" | "180" | "365", or "never". */
  transcriptRetention: string;
}

/** A hardware check result and when it ran (ms since the epoch). */
export type StoredBenchmark = BenchmarkResult & { checkedAt?: number };

type KeysOfType<T> = {
  [K in keyof SettingsValues]: SettingsValues[K] extends T ? K : never;
}[keyof SettingsValues];

export type StringSettingKey = KeysOfType<string>;
export type BooleanSettingKey = KeysOfType<boolean>;

/** Writes one preference. Screens get it as a prop, the app passes updateSetting. */
export type SettingChange = <K extends keyof SettingsValues>(
  key: K,
  value: SettingsValues[K]
) => void;

export const DEFAULT_SHORTCUTS: Record<string, string[]> = Object.fromEntries(
  SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys])
);

/** The defaults of `settings::defaults` in Rust. */
export const DEFAULT_SETTINGS: SettingsValues = {
  agentLimitSession: "90",
  agentLimitWeek: "80",
  agentPath: null,
  audioRetention: "never",
  autoEnd: "10",
  callLanguage: "ru",
  compactOverlay: true,
  hideOnShare: true,
  launchAtLogin: true,
  micBusyBehavior: "widget",
  microphone: "system",
  questionCount: "3",
  questionFrequency: "normal",
  shortcuts: DEFAULT_SHORTCUTS,
  speechBenchmark: {},
  theme: "light",
  transcriptRetention: "180",
};

/* ------------------------------------------------------------- Adapter */

export interface StoredSettings {
  /** Rust shows onboarding or the main window by it. */
  onboardingCompleted: boolean;
  values: SettingsValues;
}

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof SettingsValues)[];

/*
 * Values the screens wrote before the settings were checked (settings-real,
 * decision 6), as the present ones: retention periods in days, the demo
 * microphones as «Как в системе». The browser demo may still keep them in
 * localStorage; Rust's migration 0011 moved its own.
 */
const LEGACY_VALUES: Partial<
  Record<keyof SettingsValues, Record<string, string>>
> = {
  audioRetention: { "7d": "7", "30d": "30", "90d": "90" },
  microphone: { airpods: "system", macbook: "system" },
  transcriptRetention: { "1y": "365", "3m": "90", "6m": "180" },
};

function presentValue(key: keyof SettingsValues, value: unknown): unknown {
  const legacy =
    typeof value === "string" ? LEGACY_VALUES[key]?.[value] : undefined;
  return legacy ?? value;
}

/**
 * The stored preferences over the frontend defaults. Values are taken as
 * stored (Rust checks every write), old ones moved to the present values.
 */
export function toStoredSettings(stored: SettingsMap): StoredSettings {
  const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of SETTING_KEYS) {
    if (stored[key] !== undefined && stored[key] !== null) {
      values[key] = presentValue(key, stored[key]);
    }
  }
  return {
    onboardingCompleted: stored[ONBOARDING_COMPLETED] === true,
    values: values as unknown as SettingsValues,
  };
}

/**
 * Keys only the backend writes: the hardware check results. The selected
 * speech model (`speechModel`) is not a preference here at all: it goes
 * through `speech_model_select` (`src/features/speech`).
 */
const BACKEND_KEYS: readonly (keyof SettingsValues)[] = ["speechBenchmark"];

/** One preference as the backend stores it. */
function toSettingsPatch(patch: Partial<SettingsValues>): SettingsMap {
  const writable = Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => !BACKEND_KEYS.includes(key as keyof SettingsValues)
    )
  );
  return JSON.parse(JSON.stringify(writable)) as SettingsMap;
}

/* --------------------------------------------------------------- Store */

const readSettings = SettingsData.use((settings) => settings.get).pipe(
  Effect.map(toStoredSettings)
);

/*
 * The server snapshot is always DEFAULT_SETTINGS, so the prerendered HTML
 * and the hydration render match; the stored values show right after.
 */
const settingsStore = createSyncedStore({
  empty: { onboardingCompleted: false, values: DEFAULT_SETTINGS },
  live: inTauri,
  onChange: (change) =>
    change.entity === "settings"
      ? { update: Effect.map(readSettings, (stored) => () => stored) }
      : undefined,
  read: readSettings,
  runtime: appRuntime,
  seed: () => ({ onboardingCompleted: false, values: DEFAULT_SETTINGS }),
});

/** Why the OS refused a shortcut, by action id; from the last save. */
const shortcutErrorsStore = createStore<Record<string, string>>({});

function selectValues(stored: StoredSettings) {
  return stored.values;
}

/**
 * The "Завершать звонок сам" setting in seconds: how long after the meeting
 * app let the microphone go; null for "Никогда".
 */
export function autoEndSeconds(setting: string): number | null {
  const minutes = Number(setting);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}

export function useSettings() {
  return selectValues(settingsStore.use());
}

export function useSettingsState() {
  return settingsStore.useState();
}

export function getSettings() {
  return settingsStore.get().values;
}

/** `null` until a live store has read the settings. */
export function useOnboardingCompleted(): boolean | null {
  const { data, status } = settingsStore.useState();
  return status === "ready" ? data.onboardingCompleted : null;
}

/**
 * Shortcuts the OS didn't register after the last change: action id → why.
 * Those keep their previous keys.
 */
export function useShortcutErrors() {
  return shortcutErrorsStore.use();
}

/**
 * Writes preferences. Rust applies their effects at once (autostart,
 * hiding from screen sharing, global shortcuts) and reports what it
 * could not apply.
 */
export function updateSettings(patch: Partial<SettingsValues>) {
  const shortcutsChanged = patch.shortcuts !== undefined;
  return settingsStore
    .mutate(
      SettingsData.use((settings) => settings.update(toSettingsPatch(patch))),
      { error: "Не удалось сохранить настройку" }
    )
    .then((result) => {
      if (!result) {
        return;
      }
      if (shortcutsChanged) {
        shortcutErrorsStore.set(
          Object.fromEntries(
            result.shortcutErrors.map((error) => [error.action, error.message])
          )
        );
      }
      if (result.launchAtLoginError) {
        toast.add({
          description: result.launchAtLoginError,
          title: "Не удалось изменить автозапуск",
          type: "error",
        });
      }
    });
}

export const updateSetting: SettingChange = (key, value) => {
  updateSettings({ [key]: value });
};

/**
 * Changes one shortcut. Only that action is sent: the backend merges it
 * over the stored shortcuts, so a change made meanwhile (another window,
 * a quick second edit) is not undone by a stale copy.
 */
export function setShortcut(id: string, keys: string[]) {
  updateSettings({ shortcuts: { [id]: keys } });
}

/** Back to the default shortcuts; returns the previous ones for "Вернуть". */
export function resetShortcuts() {
  const previous = getSettings().shortcuts;
  updateSettings({ shortcuts: DEFAULT_SHORTCUTS });
  return previous;
}

/**
 * Marks the first-run setup done or not. Done goes through
 * `onboarding_complete`, which in Tauri also hides onboarding and shows
 * the main window.
 */
export function setOnboardingCompleted(completed: boolean) {
  return settingsStore.mutate(
    SettingsData.use((settings) =>
      Effect.as(
        completed
          ? settings.completeOnboarding
          : settings.update({ [ONBOARDING_COMPLETED]: completed }),
        completed
      )
    ),
    { error: "Не удалось сохранить настройку" }
  );
}

/**
 * Every preference back to its default (tests). «Удалить всё» resets them
 * in Rust (`data_delete_all`).
 */
export function resetSettings() {
  shortcutErrorsStore.set({});
  updateSettings(DEFAULT_SETTINGS);
}

/*
 * Whether the chosen microphone is gone from the system (headphones
 * disconnected). Device state, not a preference: not persisted. The backend
 * reports it through an event; Settings shows the banner, the red dot on
 * "Звук и распознавание" and "Нет микрофона" in the sidebar status.
 */
const microphoneMissingStore = createStore<boolean>(false);

export function useMicrophoneMissing(): boolean {
  return microphoneMissingStore.use();
}

export function setMicrophoneMissing(missing: boolean) {
  microphoneMissingStore.set(missing);
}

/** Reads the settings again (the storage error screen's "Повторить"). */
export function refreshSettings() {
  return settingsStore.refresh();
}
