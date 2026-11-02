import type { IntegrationState } from "@/data/integrations";
import type { IntegrationService } from "@/lib/routes";

/*
 * Every operation of Settings that needs the system or the network, faked
 * with timers. This file is what the backend replaces: each function becomes
 * a Tauri command (or an event subscription) with the same signature.
 *
 * Long operations take an AbortSignal (the screen aborts them when it
 * unmounts) and report progress from 0 to 100.
 */

type Progress = (percent: number) => void;

const PROGRESS_STEP_MS = 100;

function abortError() {
  return new DOMException("Отменено", "AbortError");
}

/** Resolves after `ms`, rejects with AbortError when the signal fires. */
function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Ticks `onProgress` up to 100 over `durationMs`. */
function simulateProgress(
  durationMs: number,
  onProgress?: Progress,
  signal?: AbortSignal
) {
  const steps = Math.max(1, Math.round(durationMs / PROGRESS_STEP_MS));
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      onProgress?.(Math.round((step / steps) * 100));
      if (step >= steps) {
        clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }
    }, PROGRESS_STEP_MS);
    function onAbort() {
      clearInterval(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

/* ---------------------------------------------------------------- Общие */

/** Opens the folder in Finder. Native only: nothing to fake but the toast. */
export async function revealInFinder(_path: string) {
  await delay(0);
}

/** Moves the saved calls to `path`, with progress. */
export async function moveRecordings(
  _path: string,
  onProgress?: Progress,
  signal?: AbortSignal
) {
  await simulateProgress(2000, onProgress, signal);
}

/* ------------------------------------------------- Звук и распознавание */

export type AudioChannel = "microphone" | "system";

const LEVEL_TICK_MS = 160;

/**
 * Live input level of a channel, 0–100, while subscribed. Returns the
 * unsubscribe function. The fake: speech-like noise on the microphone,
 * near silence on the system audio.
 */
export function subscribeInputLevel(
  channel: AudioChannel,
  onLevel: (level: number) => void
) {
  const timer = setInterval(() => {
    const level =
      channel === "microphone" ? 35 + Math.random() * 45 : Math.random() * 6;
    onLevel(Math.round(level));
  }, LEVEL_TICK_MS);
  return () => clearInterval(timer);
}

export interface SoundCheckResult {
  client: string;
  you: string;
}

/** Records both channels for a moment and returns what was recognized. */
export async function runSoundCheck(signal?: AbortSignal) {
  await delay(2500, signal);
  const result: SoundCheckResult = {
    client: "тишина, системный звук не слышно",
    you: "«Раз, два, проверка. Меня хорошо слышно?»",
  };
  return result;
}

/** Downloads or updates a speech model, with progress. */
export async function downloadSpeechModel(
  _modelId: string,
  onProgress?: Progress,
  signal?: AbortSignal
) {
  await simulateProgress(2500, onProgress, signal);
}

/* ---------------------------------------------------------------- Агент */

/** Looks for the CLI at `path` and checks that it is signed in. */
export async function checkAgent(path: string, signal?: AbortSignal) {
  await delay(1200, signal);
  if (!path.trim().endsWith("claude")) {
    throw new Error(`По пути ${path} нет Claude Code`);
  }
}

/** Signs the CLI in (in the real app the browser opens). */
export async function signInAgent(signal?: AbortSignal) {
  await delay(1500, signal);
}

/* ------------------------------------------------- Приватность и хранение */

/** Writes all projects to Markdown in `folder`, audio when asked. */
export async function exportData(
  _options: { folder: string; includeAudio: boolean },
  onProgress?: Progress,
  signal?: AbortSignal
) {
  await simulateProgress(2000, onProgress, signal);
}

/** Deletes calls, audio, projects and people from the computer. */
export async function deleteAllData(signal?: AbortSignal) {
  await delay(1500, signal);
}

/* ----------------------------------------------------------- Интеграции */

export interface ConnectInput {
  /** Outline: workspace address. */
  host?: string;
  /** Outline: API key. */
  key?: string;
}

const MIN_OUTLINE_KEY_LENGTH = 8;

const CONNECTED_ACCOUNTS: Record<IntegrationService, string> = {
  clickup: "Workspace «Wandry»",
  github: "dima-kapish, доступ к 12 репозиториям",
  outline: "wandry.getoutline.com",
};

/**
 * Connects a service: OAuth in the browser for GitHub and ClickUp, an API
 * key for Outline. Resolves with the connected state, rejects with a reason
 * the user can act on.
 */
export async function connectService(
  service: IntegrationService,
  input: ConnectInput = {},
  signal?: AbortSignal
): Promise<IntegrationState> {
  await delay(1500, signal);
  if (service === "outline") {
    const key = input.key?.trim() ?? "";
    if (key.length < MIN_OUTLINE_KEY_LENGTH) {
      throw new Error(
        "Ключ не подошёл: проверьте, что скопировали его целиком"
      );
    }
    return {
      account: input.host?.trim() || CONNECTED_ACCOUNTS.outline,
      status: "connected",
    };
  }
  return { account: CONNECTED_ACCOUNTS[service], status: "connected" };
}

/** Opens a page in the browser. Native only: nothing to fake but the toast. */
export async function openExternal(_url: string) {
  await delay(0);
}
