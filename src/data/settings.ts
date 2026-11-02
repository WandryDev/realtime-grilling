"use client";

import { AGENT, RECORDINGS, SHORTCUTS } from "@/features/settings/mock";

import { createStore } from "./store";

/*
 * App preferences from Settings. Persisted (localStorage now, the app config
 * file later): every control in Settings writes here at once, there is no
 * "Save" button. When the backend arrives `updateSetting` becomes a Tauri
 * command and `useSettings` keeps its signature.
 *
 * The server snapshot is always DEFAULT_SETTINGS (see createStore), so the
 * prerendered HTML and the hydration render match; the stored values show
 * right after hydration.
 */

export interface SettingsValues {
  agentPath: string;
  agentSignedIn: boolean;
  audioRetention: string;
  autoEnd: string;
  callLanguage: string;
  compactOverlay: boolean;
  finalCheck: string;
  hideOnShare: boolean;
  /** Speech models present on disk, by id. */
  installedModels: string[];
  interfaceLanguage: string;
  launchAtLogin: boolean;
  micBusyBehavior: string;
  microphone: string;
  /** Installed models with a newer version available. */
  modelUpdates: string[];
  questionCount: string;
  questionFrequency: string;
  recordingsFolder: string;
  /** Global shortcuts by action id; an empty list means "not set". */
  shortcuts: Record<string, string[]>;
  speechModel: string;
  systemAudio: string;
  theme: string;
  transcriptRetention: string;
}

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

export const DEFAULT_SETTINGS: SettingsValues = {
  agentPath: AGENT.path,
  agentSignedIn: true,
  audioRetention: "30d",
  autoEnd: "10",
  callLanguage: "ru",
  compactOverlay: true,
  finalCheck: "10",
  hideOnShare: true,
  installedModels: ["whisper"],
  interfaceLanguage: "ru",
  launchAtLogin: true,
  micBusyBehavior: "widget",
  microphone: "airpods",
  modelUpdates: ["whisper"],
  questionCount: "3",
  questionFrequency: "normal",
  recordingsFolder: RECORDINGS.folder,
  shortcuts: DEFAULT_SHORTCUTS,
  speechModel: "whisper",
  systemAudio: "system",
  theme: "light",
  transcriptRetention: "6m",
};

const STORAGE_KEY = "grill.settings";

function load(): SettingsValues {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_SETTINGS;
    }
    // Merge over the defaults: preferences added later get their default.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as object) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function save(values: SettingsValues) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
  } catch {
    // Storage is unavailable (private mode): values live until reload.
  }
}

const settingsStore = createStore<SettingsValues>(DEFAULT_SETTINGS);

if (typeof window !== "undefined") {
  settingsStore.set(load());
  settingsStore.subscribe(() => save(settingsStore.get()));
}

export function useSettings() {
  return settingsStore.use();
}

export function getSettings() {
  return settingsStore.get();
}

export const updateSetting: SettingChange = (key, value) => {
  settingsStore.set((state) => ({ ...state, [key]: value }));
};

export function updateSettings(patch: Partial<SettingsValues>) {
  settingsStore.set((state) => ({ ...state, ...patch }));
}

export function setShortcut(id: string, keys: string[]) {
  settingsStore.set((state) => ({
    ...state,
    shortcuts: { ...state.shortcuts, [id]: keys },
  }));
}

/** Back to the default shortcuts; returns the previous ones for "Вернуть". */
export function resetShortcuts() {
  const previous = settingsStore.get().shortcuts;
  settingsStore.set((state) => ({ ...state, shortcuts: DEFAULT_SHORTCUTS }));
  return previous;
}

/** Every preference back to its default (tests, "delete everything"). */
export function resetSettings() {
  settingsStore.set(DEFAULT_SETTINGS);
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
