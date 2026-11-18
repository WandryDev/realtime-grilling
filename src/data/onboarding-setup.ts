"use client";

import { Effect, Stream } from "effect";

import type { ErrorReason } from "@/bindings";
import { type AppServices, runCancelable } from "@/effect/runtime";
import {
  type AgentState as BackendAgentState,
  mockComputer,
  OnboardingBackend,
  type PermissionKind,
  type PermissionState,
  type PermissionStatus,
  type Permissions,
} from "@/features/onboarding/backend";
import {
  type BenchmarkResult,
  type ModelId,
  type ModelState,
  mockSpeechModels,
  SpeechBackend,
  type SpeechModel,
} from "@/features/speech/backend";
import { routes } from "@/lib/routes";

import { rememberOnboardingResume } from "./onboarding";
import { getSettings, updateSetting } from "./settings";
import { createStore } from "./store";

/*
 * Progress of the first-run setup, steps 02–04: system permissions, the
 * speech model download and the agent check. Held across the steps (the
 * model keeps downloading while the user moves on) and read later by the
 * "Готово" step and the settings.
 *
 * The work runs in `OnboardingBackend` (`src/features/onboarding/backend.ts`)
 * and, for the speech model, `SpeechBackend` (`src/features/speech`):
 * timers in the mock, Rust in the app. The actions below set what the user
 * sees right away, start the service and write its answers back through the
 * adapter section at the end of the file. The `force*` dev helpers and the
 * fake macOS dialog (`answer*`) work with the mock only.
 */

export type MicrophoneAccess = "idle" | "asking" | "granted" | "denied";
/** `unknown`: macOS doesn't tell, the level meter shows whether it works. */
export type ScreenAudioAccess =
  | "idle"
  | "asking"
  | "granted"
  | "denied"
  | "unknown";

/**
 * The model's file: `checking` is its sum after the download; `error` a
 * download or a load that failed (`SpeechSetup.error` says why).
 */
export type SpeechModelStatus =
  | "idle"
  | "downloading"
  | "paused"
  | "checking"
  | "ready"
  | "no-space"
  | "no-network"
  | "error";

/** The hardware check of the ready model ("проверяем" on the step). */
export type SpeechCheck =
  | { status: "idle" }
  | { status: "running" }
  | { result: BenchmarkResult; status: "done" }
  /** It could not run (a recording started meanwhile): nothing is known. */
  | { status: "skipped" };

/** The mic check of the ready model. */
export type MicCheckState =
  | { status: "idle" }
  | { status: "listening" }
  /** `text` is empty when nothing was said. */
  | { status: "heard"; text: string }
  | { message: string; status: "failed" };

export type AgentStatus =
  | "unknown"
  | "checking"
  | "ready"
  | "needs-login"
  | "awaiting-code"
  | "not-installed"
  | "installing"
  | "install-error"
  /** The check or the login start failed, see `error`. */
  | "error";

/** What failed with the agent; `message` goes to support as is. */
export interface AgentFailure {
  during: "check" | "install" | "login";
  message: string;
}

export interface PermissionsSetup {
  /** "Проверить" is re-reading the system state. */
  checking: boolean;
  microphone: MicrophoneAccess;
  /** Why the microphone can't be allowed here, from the OS side. */
  microphoneMessage: string | null;
  /** The user opened System Settings (and, in the mock, flipped the toggle). */
  privacySettingsOpened: boolean;
  screenAudio: ScreenAudioAccess;
  /** Why the system sound can't be allowed here (an old macOS). */
  screenAudioMessage: string | null;
  /**
   * The system sound prompt was answered but this process still reads "not
   * asked": macOS shows the access only after a restart.
   */
  screenAudioRestart: boolean;
}

export interface SpeechSetup {
  /** Download speed, bytes per second, while downloading. */
  bytesPerSec: number;
  check: SpeechCheck;
  /** Why the model is in `error`. */
  error: { message: string; reason: ErrorReason } | null;
  /** Id of the call language, `ru` or `uk` (the `callLanguage` setting). */
  language: string;
  micCheck: MicCheckState;
  /** The model the step downloads: turbo, or small once offered. */
  model: ModelId;
  /** Download progress, 0–100. */
  percent: number;
  /** `no-network`: the app tries again `inSec` after `at` (ms). */
  retry: { at: number; inSec: number } | null;
  /** Download size of `model`, bytes; 0 until the backend said. */
  sizeBytes: number;
  /** `no-space`: what the download needs and what the disk has, bytes. */
  space: { freeBytes: number; needBytes: number } | null;
  status: SpeechModelStatus;
}

export interface AgentSetup {
  /** The account Claude Code is logged in with, once logged in. */
  account: string | null;
  /** What failed last, for the screen and "Скопировать для поддержки". */
  error: AgentFailure | null;
  /** The agent that thinks up questions. Only Claude Code for now. */
  id: "claude-code";
  installPercent: number;
  /** The CLI didn't take the code from the browser. */
  loginError: string | null;
  /** "Войти" is starting the browser login. */
  loginPending: boolean;
  /** "Подтвердить" is passing the code to the CLI. */
  loginSubmitting: boolean;
  /** The login page of the running login, for "Открыть страницу ещё раз". */
  loginUrl: string | null;
  /** "Claude Max", once logged in. */
  plan: string | null;
  status: AgentStatus;
  /** Version of the found CLI. */
  version: string | null;
}

export interface OnboardingSetup {
  agent: AgentSetup;
  permissions: PermissionsSetup;
  speech: SpeechSetup;
}

const NO_LOGIN = {
  loginError: null,
  loginPending: false,
  loginSubmitting: false,
  loginUrl: null,
} as const satisfies Partial<AgentSetup>;

const INITIAL: OnboardingSetup = {
  agent: {
    ...NO_LOGIN,
    account: null,
    error: null,
    id: "claude-code",
    installPercent: 0,
    plan: null,
    status: "unknown",
    version: null,
  },
  permissions: {
    checking: false,
    microphone: "idle",
    microphoneMessage: null,
    privacySettingsOpened: false,
    screenAudio: "idle",
    screenAudioMessage: null,
    screenAudioRestart: false,
  },
  speech: {
    bytesPerSec: 0,
    check: { status: "idle" },
    error: null,
    language: "ru",
    micCheck: { status: "idle" },
    model: "turbo",
    percent: 0,
    retry: null,
    sizeBytes: 0,
    space: null,
    status: "idle",
  },
};

/** What the forced "error" state shows. */
const MOCK_AGENT_ERROR =
  "Claude Code не отвечает\n\nclaude --version: no answer in 10 s";

/** Next to "Войти" when the login session is gone (expired, cancelled). */
export const LOGIN_EXPIRED = "Вход истёк, начните заново";

/** Under the code field when the CLI didn't take the code. */
export const LOGIN_CODE_REJECTED = "Код не подошёл, попробуйте войти ещё раз";

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

/** The agent setup now, for handlers outside React. */
export function getAgentSetup() {
  return setupStore.get().agent;
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
/* Running jobs. One slot per job, a new run in a slot replaces the old one */
/* ---------------------------------------------------------------------- */

type Job =
  | "agent"
  | "microphone"
  | "micCheck"
  | "permissions"
  | "screenAudio"
  | "speech"
  | "speechCheck"
  | "speechModels";

interface Run {
  cancel: () => void;
}

const runs = new Map<Job, Run>();

function stop(job: Job) {
  const run = runs.get(job);
  if (run) {
    runs.delete(job);
    run.cancel();
  }
}

/**
 * Writes to the store only while the run still owns its slot: a stopped
 * run (paused, forced, reset) never writes late.
 */
type Write = (apply: () => void) => Effect.Effect<void>;

/** Runs `work` through the app runtime in the slot of `job`. */
function start(
  job: Job,
  work: (write: Write) => Effect.Effect<void, never, AppServices>
) {
  stop(job);
  const run: Run = { cancel: () => undefined };
  runs.set(job, run);
  const owns = () => runs.get(job) === run;
  const write: Write = (apply) =>
    Effect.sync(() => {
      if (owns()) {
        apply();
      }
    });
  run.cancel = runCancelable(
    work(write).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (owns()) {
            runs.delete(job);
          }
        })
      )
    )
  );
}

/* ----------------------------- Permissions ---------------------------- */

const PERMISSION_JOB = {
  microphone: "microphone",
  systemAudio: "screenAudio",
} as const satisfies Record<PermissionKind, Job>;

function setAccess(kind: PermissionKind, access: ScreenAudioAccess) {
  if (kind === "systemAudio") {
    setPermissions({ screenAudio: access });
  } else {
    setPermissions({ microphone: access === "unknown" ? "idle" : access });
  }
}

/** Writes a read of both accesses; a pending ask stays pending. */
function applyPermissions(read: Permissions) {
  const current = setupStore.get().permissions;
  const systemAudioKnown =
    read.systemAudio.state === "granted" || read.systemAudio.state === "denied";
  setPermissions({
    microphone: toMicrophoneAccess(read.microphone, current.microphone),
    microphoneMessage: read.microphone.message,
    screenAudio: toScreenAudioAccess(read.systemAudio, current.screenAudio),
    screenAudioMessage: read.systemAudio.message,
    screenAudioRestart: current.screenAudioRestart && !systemAudioKnown,
  });
}

/** Both accesses let a call be heard (`unknown` is checked by the meter). */
export function arePermissionsReady({
  microphone,
  screenAudio,
}: Pick<PermissionsSetup, "microphone" | "screenAudio">) {
  return (
    microphone === "granted" &&
    (screenAudio === "granted" || screenAudio === "unknown")
  );
}

/** Asks the OS; macOS shows its dialog (in the mock, a fake one). */
function request(kind: PermissionKind) {
  // A read started before the ask must not undo its answer
  stop("permissions");
  setAccess(kind, "asking");
  start(PERMISSION_JOB[kind], (write) =>
    OnboardingBackend.use((backend) => backend.requestPermission(kind)).pipe(
      Effect.flatMap((status) =>
        write(() => {
          setAccess(kind, toScreenAudioAccess(status, "idle"));
          setPermissions(
            kind === "microphone"
              ? { microphoneMessage: status.message }
              : {
                  screenAudioMessage: status.message,
                  // Asked, but macOS keeps answering "not asked" here
                  screenAudioRestart: status.state === "notDetermined",
                }
          );
        })
      ),
      Effect.catch(() => write(() => setAccess(kind, "idle")))
    )
  );
}

/** The user answered the fake macOS dialog of the mock. */
function answer(kind: PermissionKind, allowed: boolean) {
  setAccess(kind, allowed ? "granted" : "denied");
  mockComputer.answer(kind, allowed);
}

/** "Разрешить" next to the microphone: macOS shows its dialog. */
export function requestMicrophone() {
  request("microphone");
}

/** The user answered the macOS microphone dialog. */
export function answerMicrophone(allowed: boolean) {
  answer("microphone", allowed);
}

/** "Разрешить" next to screen recording: macOS asks for screen and audio. */
export function requestScreenAudio() {
  request("systemAudio");
}

export function answerScreenAudio(allowed: boolean) {
  answer("systemAudio", allowed);
}

/**
 * "Перезапустить": macOS applies the system sound access only to a new
 * process. The app restarts and onboarding opens on this step again.
 */
export function restartForPermissions() {
  rememberOnboardingResume(routes.onboarding("permissions"));
  runCancelable(
    OnboardingBackend.use((backend) => backend.restartApp).pipe(
      // The mock (browser) doesn't restart: read the accesses again instead.
      Effect.tap(() => Effect.sync(loadPermissions)),
      Effect.ignore
    )
  );
}

/*
 * "Открыть настройки": opens the System Settings pane of the refused
 * access. The mock assumes the user flips the toggle there, so the next
 * "Проверить" finds the access on.
 */
export function openPrivacySettings() {
  const { permissions } = setupStore.get();
  const kind: PermissionKind =
    permissions.microphone === "denied" ? "microphone" : "systemAudio";
  setPermissions({ privacySettingsOpened: true });
  runCancelable(
    OnboardingBackend.use((backend) =>
      backend.openPermissionSettings(kind)
    ).pipe(Effect.ignore)
  );
}

/**
 * Entering the step and the window getting the focus back (the user may
 * have changed a toggle in System Settings): reads both accesses quietly.
 */
export function loadPermissions() {
  start("permissions", (write) =>
    OnboardingBackend.use((backend) => backend.permissions).pipe(
      Effect.flatMap((read) => write(() => applyPermissions(read))),
      Effect.ignore
    )
  );
}

/**
 * "Проверить": re-reads both accesses without a restart. Resolves to whether
 * everything is allowed now.
 */
export function recheckPermissions(): Promise<boolean> {
  setPermissions({ checking: true });
  return new Promise((resolve) => {
    start("permissions", (write) =>
      OnboardingBackend.use((backend) => backend.permissions).pipe(
        Effect.flatMap((read) =>
          write(() => {
            applyPermissions(read);
            setPermissions({ checking: false });
            resolve(arePermissionsReady(setupStore.get().permissions));
          })
        ),
        Effect.catch(() =>
          write(() => {
            setPermissions({ checking: false });
            resolve(false);
          })
        )
      )
    );
  });
}

/** Dev only: open the step with the given answers. */
export function forcePermissions(
  next: Pick<PermissionsSetup, "microphone" | "screenAudio">
) {
  for (const job of ["permissions", "microphone", "screenAudio"] as const) {
    stop(job);
  }
  mockComputer.setPermissions({
    microphone: fromAccess(next.microphone),
    systemAudio: fromAccess(next.screenAudio),
  });
  setPermissions({
    ...next,
    checking: false,
    microphoneMessage: null,
    privacySettingsOpened: false,
    screenAudioMessage: null,
  });
}

/* ---------------------------- Speech model ---------------------------- */

/*
 * The step follows the models as the backend reports them
 * (`followSpeechModels`): the buttons send commands, the states come back
 * as changes. Once the model is ready the hardware check runs
 * ("проверяем"); a slow turbo offers the small model, which is selected
 * and checked in its turn.
 */

/** Whether the step has picked the model to follow from the first read. */
let modelChosen = false;

const CALL_LANGUAGES = ["ru", "uk"];

/**
 * Entering the step: follows both models (once per window, it keeps going
 * on the next steps) and takes the call language from the settings.
 */
export function followSpeechModels() {
  if (runs.has("speechModels")) {
    return;
  }
  const { callLanguage } = getSettings();
  if (CALL_LANGUAGES.includes(callLanguage)) {
    setSpeech({ language: callLanguage });
  }
  start("speechModels", (write) =>
    SpeechBackend.use((speech) =>
      Stream.runForEach(speech.watchModels, (models) =>
        write(() => applyModels(models))
      )
    ).pipe(Effect.ignore)
  );
}

/** The followed model's last state, so a change of the other one is no news. */
let lastModel: SpeechModel | null = null;

/**
 * Applies the backend's state of the followed model. The same state again
 * is no news only while the step shows it: an optimistic state the backend
 * did not take ("Повторить сейчас" while it waits to retry) is corrected.
 */
function applyModels(models: readonly SpeechModel[]) {
  if (!modelChosen) {
    modelChosen = true;
    const selected = models.find((model) => model.selected);
    if (selected) {
      setSpeech({ model: selected.id });
    }
  }
  const followed = models.find(
    (model) => model.id === setupStore.get().speech.model
  );
  if (!followed) {
    return;
  }
  const next = fromModelState(followed);
  const shown = setupStore.get().speech.status === next.status;
  if (isSameModel(followed, lastModel) && shown) {
    return;
  }
  lastModel = followed;
  setSpeech(next);
  const { check } = setupStore.get().speech;
  if (followed.state.status === "ready") {
    onModelReady(followed);
  } else if (check.status === "done" || check.status === "skipped") {
    // Removed or downloaded again: the old result is about another file.
    setSpeech({ check: { status: "idle" } });
  }
}

function isSameModel(model: SpeechModel, last: SpeechModel | null) {
  return (
    last !== null &&
    last.id === model.id &&
    last.selected === model.selected &&
    JSON.stringify(last.state) === JSON.stringify(model.state)
  );
}

/** A ready model: selected (the small one after the offer), then checked. */
function onModelReady(model: SpeechModel) {
  const { check } = setupStore.get().speech;
  if (check.status !== "idle" || runs.has("speechCheck")) {
    return;
  }
  // Rust forgets the result when the file is removed or downloaded again;
  // a check that did not run (no model, not loaded) is no result.
  const stored = getSettings().speechBenchmark[model.id];
  if (stored && checkRan(stored)) {
    setSpeech({ check: { result: stored, status: "done" } });
    return;
  }
  runSpeechCheck(model);
}

function checkRan({ reason }: BenchmarkResult) {
  return reason !== "noModel" && reason !== "modelFailed";
}

function runSpeechCheck(model: Pick<SpeechModel, "id" | "selected">) {
  setSpeech({ check: { status: "running" } });
  start("speechCheck", (write) =>
    SpeechBackend.use((speech) =>
      (model.selected
        ? Effect.void
        : Effect.asVoid(speech.select(model.id))
      ).pipe(Effect.andThen(speech.benchmark(model.id)))
    ).pipe(
      Effect.flatMap((result) =>
        write(() => setSpeech({ check: { result, status: "done" } }))
      ),
      Effect.catch(() =>
        write(() => setSpeech({ check: { status: "skipped" } }))
      )
    )
  );
}

/** Sends a model command; its answer is a change like any other. */
function command(
  run: (
    speech: SpeechBackend["Service"],
    id: ModelId
  ) => Effect.Effect<SpeechModel, unknown>
) {
  const { model: id } = setupStore.get().speech;
  start("speech", (write) =>
    SpeechBackend.use((backend) => run(backend, id)).pipe(
      Effect.flatMap((reply) =>
        write(() => {
          if (reply.id === setupStore.get().speech.model) {
            applyModels([reply]);
          }
        })
      ),
      Effect.ignore
    )
  );
}

const BUSY_MODEL: readonly SpeechModelStatus[] = [
  "downloading",
  "paused",
  "checking",
];

/** Picks the call language: stored in `callLanguage` at once. */
export function setSpeechLanguage(language: string) {
  if (setupStore.get().speech.language === language) {
    return;
  }
  setSpeech({ language });
  updateSetting("callLanguage", language);
}

/** "Скачать": checks the free space and starts. */
export function downloadSpeechModel() {
  setSpeech({ check: { status: "idle" }, status: "downloading" });
  command((speech, id) => speech.download(id));
}

export function pauseSpeechModel() {
  setSpeech({ status: "paused" });
  command((speech, id) => speech.pause(id));
}

export function resumeSpeechModel() {
  setSpeech({ status: "downloading" });
  command((speech, id) => speech.download(id));
}

/** "Отменить": deletes the partial file, back to the language choice. */
export function cancelSpeechModel() {
  setSpeech({ percent: 0, status: "idle" });
  command((speech, id) => speech.cancel(id));
}

/*
 * "Повторить": after "no space" the disk is checked again; after "no
 * network" the download goes on from where it stopped, without waiting
 * for the automatic retry.
 */
export function retrySpeechModel() {
  setSpeech({ status: "downloading" });
  command((speech, id) => speech.download(id));
}

/**
 * "Скачать заново": a model that failed (a broken file, or one whisper.cpp
 * did not load) is deleted and downloaded again.
 */
export function redownloadSpeechModel() {
  stop("speechCheck");
  setSpeech({ check: { status: "idle" }, percent: 0, status: "downloading" });
  command((speech, id) =>
    speech.remove(id).pipe(Effect.andThen(speech.download(id)))
  );
}

/**
 * "Скачать запасную модель": turbo is too slow here. The step follows the
 * small model from now on; once ready it is selected and checked.
 */
export function downloadFallbackModel() {
  stop("speechCheck");
  stop("micCheck");
  setSpeech({
    check: { status: "idle" },
    micCheck: { status: "idle" },
    model: "small",
    percent: 0,
    status: "downloading",
  });
  command((speech, id) => speech.download(id));
}

/** "Проверить снова": the hardware check of the ready model again. */
export function recheckSpeechModel() {
  const { model } = setupStore.get().speech;
  runSpeechCheck({ id: model, selected: true });
}

/**
 * The mic check: up to 8 s from the microphone, then what the model heard,
 * at once. Runs again on "Проверить ещё раз".
 */
export function startMicCheck() {
  setSpeech({ micCheck: { status: "listening" } });
  start("micCheck", (write) =>
    SpeechBackend.use((speech) => speech.micCheck).pipe(
      Effect.flatMap((text) =>
        write(() => setSpeech({ micCheck: { status: "heard", text } }))
      ),
      Effect.catch((error) =>
        write(() =>
          setSpeech({
            micCheck: { message: error.message, status: "failed" },
          })
        )
      )
    )
  );
}

/** Leaving the step: the answer of a running mic check is not shown. */
export function stopMicCheck() {
  stop("micCheck");
  setSpeech({ micCheck: { status: "idle" } });
}

export function isSpeechModelBusy(status: SpeechModelStatus) {
  return BUSY_MODEL.includes(status);
}

/** Dev only: open the step with the mock model in `state`, timers included. */
export function forceSpeechModel(state: ModelState, check?: BenchmarkResult) {
  for (const job of ["speech", "speechCheck", "micCheck"] as const) {
    stop(job);
  }
  setSpeech({
    check: check ? { result: check, status: "done" } : { status: "idle" },
    micCheck: { status: "idle" },
    model: "turbo",
  });
  mockSpeechModels.force("turbo", state);
}

/* -------------------------------- Agent ------------------------------- */

function failed(during: AgentFailure["during"], message: string) {
  return {
    ...NO_LOGIN,
    error: { during, message },
    status: during === "install" ? "install-error" : "error",
  } as const satisfies Partial<AgentSetup>;
}

/** Reads the agent's status; `quiet` keeps the screen as is meanwhile. */
function readAgent({ quiet }: { quiet: boolean }) {
  if (!quiet) {
    setAgent({ ...NO_LOGIN, status: "checking" });
  }
  start("agent", (write) =>
    OnboardingBackend.use((backend) => backend.agentStatus).pipe(
      Effect.flatMap((agent) => write(() => setAgent(fromAgentState(agent)))),
      Effect.catch((error) =>
        write(() => setAgent(failed("check", error.message)))
      )
    )
  );
}

function checkAgent() {
  readAgent({ quiet: false });
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

/** Running work a focus recheck must not replace. */
const AGENT_BUSY: readonly AgentStatus[] = [
  "unknown",
  "checking",
  "installing",
  "awaiting-code",
];

/**
 * The window got the focus back: the user may have installed Claude Code or
 * logged in in a terminal. Reads quietly, never over a running install,
 * login or check.
 */
export function refreshAgent() {
  const { agent } = setupStore.get();
  if (AGENT_BUSY.includes(agent.status) || agent.loginPending) {
    return;
  }
  readAgent({ quiet: true });
}

/** "Установить" / "Повторить": download, install, then ask for a login. */
export function installAgent() {
  setAgent({
    ...NO_LOGIN,
    error: null,
    installPercent: 0,
    status: "installing",
  });
  start("agent", (write) =>
    OnboardingBackend.use((backend) =>
      Stream.runForEach(backend.installAgent, (event) =>
        write(() =>
          setAgent(
            event.type === "progress"
              ? { installPercent: event.percent }
              : { ...fromAgentState(event.agent), installPercent: 100 }
          )
        )
      )
    ).pipe(
      Effect.catch((error) =>
        write(() => setAgent(failed("install", error.message)))
      )
    )
  );
}

/** "Отменить" under the install progress: stops the installer. */
export function cancelAgentInstall() {
  stop("agent");
  setAgent({ ...NO_LOGIN, installPercent: 0, status: "not-installed" });
}

/*
 * "Войти" (and "Войти ещё раз" after a wrong code): starts the Claude login,
 * which opens the browser, and waits for the code from the page.
 */
export function loginAgent() {
  setAgent({ loginError: null, loginPending: true });
  start("agent", (write) =>
    OnboardingBackend.use((backend) => backend.loginStart).pipe(
      Effect.flatMap((url) =>
        write(() =>
          setAgent({
            ...NO_LOGIN,
            loginUrl: url,
            status: "awaiting-code",
          })
        )
      ),
      Effect.catch((error) =>
        write(() => setAgent(failed("login", error.message)))
      )
    )
  );
}

/**
 * "Подтвердить": passes the code from the browser to the agent. Only into a
 * running login: after a refused code the session is over, "Войти ещё раз"
 * starts a new one.
 */
export function submitAgentLoginCode(code: string) {
  const { loginSubmitting, loginUrl } = setupStore.get().agent;
  if (!loginUrl || loginSubmitting) {
    return;
  }
  setAgent({ loginError: null, loginSubmitting: true });
  start("agent", (write) =>
    OnboardingBackend.use((backend) => backend.loginSubmit(code.trim())).pipe(
      Effect.flatMap((agent) =>
        write(() => setAgent({ ...NO_LOGIN, ...fromAgentState(agent) }))
      ),
      Effect.catchTag("AgentLoginCodeError", () =>
        write(() =>
          setAgent({
            ...NO_LOGIN,
            loginError: LOGIN_CODE_REJECTED,
            status: "awaiting-code",
          })
        )
      ),
      Effect.catch((error) =>
        write(() =>
          setAgent({
            ...NO_LOGIN,
            loginError:
              error.kind === "NotFound" ? LOGIN_EXPIRED : error.message,
            status: "needs-login",
          })
        )
      )
    )
  );
}

/** "Отменить": stops the login, back to "Войти". */
export function cancelAgentLogin() {
  stop("agent");
  setAgent({ ...NO_LOGIN, status: "needs-login" });
  runCancelable(
    OnboardingBackend.use((backend) => backend.loginCancel).pipe(Effect.ignore)
  );
}

const FORCED_AGENT = {
  "awaiting-code": "needsLogin",
  checking: "needsLogin",
  error: "error",
  "install-error": "notInstalled",
  installing: "notInstalled",
  "needs-login": "needsLogin",
  "not-installed": "notInstalled",
  ready: "ready",
} as const satisfies Record<
  Exclude<AgentStatus, "unknown">,
  BackendAgentState["status"]
>;

/** Dev only: open the step in the given state, timers included. */
export function forceAgent(status: Exclude<AgentStatus, "unknown">) {
  stop("agent");
  mockComputer.setAgent(FORCED_AGENT[status]);
  if (status === "installing") {
    installAgent();
    return;
  }
  if (status === "checking") {
    checkAgent();
    return;
  }
  if (status === "error") {
    setAgent(failed("check", MOCK_AGENT_ERROR));
    return;
  }
  setAgent({
    ...NO_LOGIN,
    error: null,
    loginUrl: status === "awaiting-code" ? mockComputer.openLogin() : null,
    status,
  });
}

/* -------------------------------------------------------------------- */

/** Back to a fresh setup (tests, "Пройти настройку заново"). */
export function resetOnboardingSetup() {
  for (const job of [...runs.keys()]) {
    stop(job);
  }
  mockComputer.reset();
  mockSpeechModels.reset();
  modelChosen = false;
  lastModel = null;
  setupStore.set(INITIAL);
}

/* ---------------------------------------------------------------------- */
/* Adapter: backend states → the screens' states                          */
/* ---------------------------------------------------------------------- */

/** A model as the step shows it. */
function fromModelState({
  sizeBytes,
  state,
}: Pick<SpeechModel, "sizeBytes" | "state">): Partial<SpeechSetup> {
  const base = { error: null, retry: null, sizeBytes, space: null };
  switch (state.status) {
    case "notDownloaded":
      return { ...base, bytesPerSec: 0, percent: 0, status: "idle" };
    case "downloading":
      return {
        ...base,
        bytesPerSec: state.bytesPerSec,
        percent: state.percent,
        status: "downloading",
      };
    case "paused":
      return { ...base, percent: state.percent, status: "paused" };
    case "checking":
      return { ...base, percent: 100, status: "checking" };
    case "ready":
      return { ...base, percent: 100, status: "ready" };
    case "noSpace":
      return {
        ...base,
        space: { freeBytes: state.freeBytes, needBytes: state.needBytes },
        status: "no-space",
      };
    case "noNetwork":
      return {
        ...base,
        percent: state.percent,
        retry: { at: Date.now(), inSec: state.retryInSec },
        status: "no-network",
      };
    default:
      return {
        ...base,
        error: { message: state.message, reason: state.reason },
        status: "error",
      };
  }
}

/** Not asked yet keeps a pending ask; `unknown` stays for the meter. */
function toScreenAudioAccess(
  { state }: PermissionStatus,
  current: ScreenAudioAccess
): ScreenAudioAccess {
  if (state === "granted" || state === "denied" || state === "unknown") {
    return state;
  }
  return current === "asking" ? "asking" : "idle";
}

/** The microphone is always known on macOS and Windows. */
function toMicrophoneAccess(
  status: PermissionStatus,
  current: MicrophoneAccess
): MicrophoneAccess {
  const access = toScreenAudioAccess(status, current);
  return access === "unknown" ? "idle" : access;
}

function fromAccess(access: ScreenAudioAccess): PermissionState {
  if (access === "granted" || access === "denied" || access === "unknown") {
    return access;
  }
  return "notDetermined";
}

/** No account or plan of an earlier login stays on the screen. */
const LOGGED_OUT = {
  account: null,
  error: null,
  plan: null,
} as const satisfies Partial<AgentSetup>;

/** `subscriptionType` → "Claude Max". */
function planName(subscription: string | null): string | null {
  if (!subscription) {
    return null;
  }
  return `Claude ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}`;
}

function fromAgentState(agent: BackendAgentState): Partial<AgentSetup> {
  switch (agent.status) {
    case "notInstalled":
      return { ...LOGGED_OUT, status: "not-installed", version: null };
    case "needsLogin":
      return { ...LOGGED_OUT, status: "needs-login", version: agent.version };
    case "ready":
      return {
        account: agent.email,
        error: null,
        plan: planName(agent.subscription),
        status: "ready",
        version: agent.version,
      };
    default:
      return failed("check", agent.message);
  }
}
