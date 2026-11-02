"use client";

import { createStore } from "./store";

/*
 * Progress of the first-run setup, steps 02–04: system permissions, the
 * speech model download and the agent check. Held across the steps (the
 * model keeps downloading while the user moves on) and read later by the
 * "Готово" step and the settings.
 *
 * MOCK: every action below fakes the native side with timers. When the
 * backend arrives each action becomes a Tauri command (ask for a permission,
 * start/pause a download, run `claude --version`, …) and the timers turn
 * into the events those commands emit. The hooks keep their signatures.
 */

export type MicrophoneAccess = "idle" | "asking" | "granted" | "denied";
export type ScreenAudioAccess = "idle" | "asking" | "granted" | "denied";

export type SpeechModelStatus =
  | "idle"
  | "downloading"
  | "paused"
  | "checking"
  | "ready"
  | "no-space"
  | "no-network";

export type AgentStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "needs-login"
  | "not-installed"
  | "installing"
  | "install-error";

export interface PermissionsSetup {
  /** "Проверить" is re-reading the system state. */
  checking: boolean;
  microphone: MicrophoneAccess;
  /** The user opened System Settings (and, in the mock, flipped the toggle). */
  privacySettingsOpened: boolean;
  screenAudio: ScreenAudioAccess;
}

export interface SpeechSetup {
  /** Id of the call language, e.g. "ru". */
  language: string;
  /** Download progress, 0–100. */
  percent: number;
  status: SpeechModelStatus;
}

export interface AgentSetup {
  /** The agent that thinks up questions. Only Claude Code for now. */
  id: "claude-code";
  installPercent: number;
  /** "Войти" opened the browser, waiting for the user to come back. */
  loginPending: boolean;
  status: AgentStatus;
}

export interface OnboardingSetup {
  agent: AgentSetup;
  permissions: PermissionsSetup;
  speech: SpeechSetup;
}

const INITIAL: OnboardingSetup = {
  agent: {
    id: "claude-code",
    installPercent: 0,
    loginPending: false,
    status: "unknown",
  },
  permissions: {
    checking: false,
    microphone: "idle",
    privacySettingsOpened: false,
    screenAudio: "idle",
  },
  speech: { language: "ru", percent: 0, status: "idle" },
};

const setupStore = createStore<OnboardingSetup>(INITIAL);

export function useOnboardingSetup() {
  return setupStore.use();
}

export function usePermissionsSetup() {
  return setupStore.use().permissions;
}

export function useSpeechSetup() {
  return setupStore.use().speech;
}

export function useAgentSetup() {
  return setupStore.use().agent;
}

function setPermissions(next: Partial<PermissionsSetup>) {
  setupStore.set((current) => ({
    ...current,
    permissions: { ...current.permissions, ...next },
  }));
}

function setSpeech(next: Partial<SpeechSetup>) {
  setupStore.set((current) => ({
    ...current,
    speech: { ...current.speech, ...next },
  }));
}

function setAgent(next: Partial<AgentSetup>) {
  setupStore.set((current) => ({
    ...current,
    agent: { ...current.agent, ...next },
  }));
}

/* ---------------------------------------------------------------------- */
/* Fake timers. One slot per job, a new job in a slot replaces the old one */
/* ---------------------------------------------------------------------- */

type Job = "agent" | "permissions" | "speech";

const timers = new Map<Job, ReturnType<typeof setTimeout>>();

function stop(job: Job) {
  const timer = timers.get(job);
  if (timer !== undefined) {
    clearTimeout(timer);
    clearInterval(timer);
    timers.delete(job);
  }
}

function later(job: Job, ms: number, run: () => void) {
  stop(job);
  timers.set(
    job,
    setTimeout(() => {
      timers.delete(job);
      run();
    }, ms)
  );
}

function every(job: Job, ms: number, tick: () => void) {
  stop(job);
  timers.set(job, setInterval(tick, ms));
}

/** Durations of the simulated work, ms. */
const DELAY = {
  agentCheck: 1500,
  agentLogin: 2000,
  agentSubscription: 1000,
  installTick: 100,
  modelCheck: 1200,
  modelTick: 100,
  permissionsCheck: 900,
} as const;

/** Progress per tick: the model takes ~4 s, the agent install ~2.5 s. */
const MODEL_STEP = 2.5;
const INSTALL_STEP = 4;

/** What the mock finds on this computer: Claude Code without a login. */
const DETECTED_AGENT: AgentStatus = "needs-login";

/* ----------------------------- Permissions ---------------------------- */

/** "Разрешить" next to the microphone: macOS shows its dialog. */
export function requestMicrophone() {
  setPermissions({ microphone: "asking" });
}

/** The user answered the macOS microphone dialog. */
export function answerMicrophone(allowed: boolean) {
  setPermissions({ microphone: allowed ? "granted" : "denied" });
}

/** "Разрешить" next to screen recording: macOS asks for screen and audio. */
export function requestScreenAudio() {
  setPermissions({ screenAudio: "asking" });
}

export function answerScreenAudio(allowed: boolean) {
  setPermissions({ screenAudio: allowed ? "granted" : "denied" });
}

/*
 * "Открыть настройки": opens Privacy & Security. The mock assumes the user
 * flips the toggle there, so the next "Проверить" finds the access on.
 */
export function openPrivacySettings() {
  setPermissions({ privacySettingsOpened: true });
}

/**
 * "Проверить": re-reads both accesses without a restart. Resolves to whether
 * everything is granted now.
 */
export function recheckPermissions(): Promise<boolean> {
  setPermissions({ checking: true });
  return new Promise((resolve) => {
    later("permissions", DELAY.permissionsCheck, () => {
      const { permissions } = setupStore.get();
      const fixed = permissions.privacySettingsOpened;
      const microphone =
        permissions.microphone === "denied" && fixed
          ? "granted"
          : permissions.microphone;
      const screenAudio =
        permissions.screenAudio === "denied" && fixed
          ? "granted"
          : permissions.screenAudio;
      setPermissions({ checking: false, microphone, screenAudio });
      resolve(microphone === "granted" && screenAudio === "granted");
    });
  });
}

/** Dev only: open the step with the given answers. */
export function forcePermissions(
  next: Pick<PermissionsSetup, "microphone" | "screenAudio">
) {
  stop("permissions");
  setPermissions({ ...next, checking: false, privacySettingsOpened: false });
}

/* ---------------------------- Speech model ---------------------------- */

function verifyModel() {
  setSpeech({ percent: 100, status: "checking" });
  later("speech", DELAY.modelCheck, () => setSpeech({ status: "ready" }));
}

function runDownload() {
  setSpeech({ status: "downloading" });
  every("speech", DELAY.modelTick, () => {
    const percent = Math.min(100, setupStore.get().speech.percent + MODEL_STEP);
    if (percent >= 100) {
      verifyModel();
      return;
    }
    setSpeech({ percent });
  });
}

const BUSY_MODEL: readonly SpeechModelStatus[] = [
  "downloading",
  "paused",
  "checking",
];

/**
 * Picks the call language. A model for another language has to be
 * downloaded again, so a started download is dropped.
 */
export function setSpeechLanguage(language: string) {
  const { speech } = setupStore.get();
  if (speech.language === language) {
    return;
  }
  stop("speech");
  setSpeech({ language, percent: 0, status: "idle" });
}

/** "Скачать": checks the free space (enough in the mock) and starts. */
export function downloadSpeechModel() {
  setSpeech({ percent: 0 });
  runDownload();
}

export function pauseSpeechModel() {
  stop("speech");
  setSpeech({ status: "paused" });
}

export function resumeSpeechModel() {
  runDownload();
}

/** "Отменить": deletes the partial file, back to the language choice. */
export function cancelSpeechModel() {
  stop("speech");
  setSpeech({ percent: 0, status: "idle" });
}

/*
 * "Повторить": after "no space" the disk is checked again (freed in the
 * mock) and the download starts over; after "no network" it continues from
 * where it stopped.
 */
export function retrySpeechModel() {
  const { speech } = setupStore.get();
  if (speech.status === "no-space") {
    setSpeech({ percent: 0 });
  }
  runDownload();
}

export function isSpeechModelBusy(status: SpeechModelStatus) {
  return BUSY_MODEL.includes(status);
}

/** Dev only: open the step in the given state, timers included. */
export function forceSpeechModel(status: SpeechModelStatus, percent: number) {
  stop("speech");
  setSpeech({ percent, status });
  if (status === "downloading") {
    runDownload();
  } else if (status === "checking") {
    verifyModel();
  }
}

/* -------------------------------- Agent ------------------------------- */

function checkAgent() {
  setAgent({ loginPending: false, status: "checking" });
  later("agent", DELAY.agentCheck, () => setAgent({ status: DETECTED_AGENT }));
}

/** Entering the step: looks for the agent once, keeps the answer after. */
export function detectAgent() {
  if (setupStore.get().agent.status === "unknown") {
    checkAgent();
  }
}

/** "Проверить снова": the user installed or logged in on their own. */
export function recheckAgent() {
  checkAgent();
}

/** "Установить" / "Повторить": download, install, then ask for a login. */
export function installAgent() {
  setAgent({ installPercent: 0, status: "installing" });
  every("agent", DELAY.installTick, () => {
    const installPercent = Math.min(
      100,
      setupStore.get().agent.installPercent + INSTALL_STEP
    );
    if (installPercent >= 100) {
      stop("agent");
      setAgent({ installPercent, status: "needs-login" });
      return;
    }
    setAgent({ installPercent });
  });
}

/*
 * "Войти": opens the browser for the Claude login and polls until it is
 * done, then checks the subscription.
 */
export function loginAgent() {
  setAgent({ loginPending: true });
  later("agent", DELAY.agentLogin, () => {
    setAgent({ loginPending: false, status: "checking" });
    later("agent", DELAY.agentSubscription, () =>
      setAgent({ status: "ready" })
    );
  });
}

/** Dev only: open the step in the given state, timers included. */
export function forceAgent(status: Exclude<AgentStatus, "unknown">) {
  stop("agent");
  if (status === "installing") {
    installAgent();
    return;
  }
  if (status === "checking") {
    checkAgent();
    return;
  }
  setAgent({ loginPending: false, status });
}

/* -------------------------------------------------------------------- */

/** Back to a fresh setup (tests, "Пройти настройку заново"). */
export function resetOnboardingSetup() {
  for (const job of [...timers.keys()]) {
    stop(job);
  }
  setupStore.set(INITIAL);
}
