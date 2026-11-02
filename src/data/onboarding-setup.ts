"use client";

import { Effect, Stream } from "effect";

import { type AppServices, runCancelable } from "@/effect/runtime";
import {
  type AgentState as BackendAgentState,
  mockComputer,
  OnboardingBackend,
  type PermissionKind,
  type PermissionState,
  type PermissionStatus,
  type Permissions,
  type SpeechModelEvent,
} from "@/features/onboarding/backend";

import { createStore } from "./store";

/*
 * Progress of the first-run setup, steps 02–04: system permissions, the
 * speech model download and the agent check. Held across the steps (the
 * model keeps downloading while the user moves on) and read later by the
 * "Готово" step and the settings.
 *
 * The work runs in `OnboardingBackend` (`src/features/onboarding/backend.ts`):
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
}

export interface SpeechSetup {
  /** Id of the call language, e.g. "ru". */
  language: string;
  /** Download progress, 0–100. */
  percent: number;
  status: SpeechModelStatus;
}

export interface AgentSetup {
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
  },
  speech: { language: "ru", percent: 0, status: "idle" },
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

type Job = "agent" | "microphone" | "permissions" | "screenAudio" | "speech";

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
  setPermissions({
    microphone: toMicrophoneAccess(read.microphone, current.microphone),
    microphoneMessage: read.microphone.message,
    screenAudio: toScreenAudioAccess(read.systemAudio, current.screenAudio),
    screenAudioMessage: read.systemAudio.message,
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
              : { screenAudioMessage: status.message }
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

function applySpeechEvent(event: SpeechModelEvent) {
  if (event.type === "checking") {
    setSpeech({ percent: 100, status: "checking" });
  } else {
    setSpeech({ percent: event.percent });
  }
}

/** Downloads from the current percent, checks and marks the model ready. */
function followModel() {
  const { language, percent } = setupStore.get().speech;
  start("speech", (write) =>
    OnboardingBackend.use((backend) =>
      Stream.runForEach(
        backend.downloadSpeechModel(language, percent),
        (event) => write(() => applySpeechEvent(event))
      )
    ).pipe(
      Effect.flatMap(() => write(() => setSpeech({ status: "ready" }))),
      Effect.catchTag("SpeechModelError", (error) =>
        write(() =>
          setSpeech({
            status: error.reason === "noSpace" ? "no-space" : "no-network",
          })
        )
      ),
      Effect.catch(() => write(() => setSpeech({ status: "no-network" })))
    )
  );
}

function verifyModel() {
  setSpeech({ percent: 100, status: "checking" });
  followModel();
}

function runDownload() {
  setSpeech({ status: "downloading" });
  followModel();
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
  setupStore.set(INITIAL);
}

/* ---------------------------------------------------------------------- */
/* Adapter: backend states → the screens' states                          */
/* ---------------------------------------------------------------------- */

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
      return { error: null, status: "not-installed", version: null };
    case "needsLogin":
      return { error: null, status: "needs-login", version: agent.version };
    case "ready":
      return {
        error: null,
        plan: planName(agent.subscription),
        status: "ready",
        version: agent.version,
      };
    default:
      return failed("check", agent.message);
  }
}
