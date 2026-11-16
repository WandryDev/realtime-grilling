import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Cause,
  Context,
  Effect,
  Layer,
  Queue,
  Random,
  Schema,
  Stream,
} from "effect";

import {
  type AgentState as BindingsAgentState,
  type PermissionStatus as BindingsPermissionStatus,
  commands,
  events,
} from "@/bindings";
import { BackendError, call, listen } from "@/effect/tauri";

/*
 * Backend contract of the onboarding steps 02–04:
 * - the system accesses: read both, ask for one, open its System Settings;
 * - the agent (Claude Code): its status, the install, the browser login
 *   with a code pasted back into the step;
 * - the live input level, the clipboard, the browser, and the focus of
 *   this window.
 *
 * The speech model, its checks and the mic check are `SpeechBackend`
 * (`src/features/speech/backend.ts`).
 *
 * The types here are the frontend's own; the Tauri layer maps the Rust ones
 * (`src/bindings.ts`) onto them. The store `src/data/onboarding-setup.ts`
 * turns them into the screens' states.
 *
 * `layerMock` plays a computer (`mockComputer` below) with timers: Claude
 * Code is installed without a login, the accesses are not asked yet.
 * `layerTauri` runs the Rust commands.
 */

export type AudioSource = "microphone" | "system";

/** The two accesses a call needs: "Я" and "Остальные". */
export type PermissionKind = "microphone" | "systemAudio";

/**
 * - notDetermined: not asked yet
 * - granted / denied (denied also covers a policy or a switched-off toggle)
 * - unknown: the OS can't tell without trying to record
 */
export type PermissionState =
  | "notDetermined"
  | "granted"
  | "denied"
  | "unknown";

export interface PermissionStatus {
  /** Why the access can't be given here (an old macOS). Shown as is. */
  readonly message: string | null;
  readonly state: PermissionState;
}

export type Permissions = Readonly<Record<PermissionKind, PermissionStatus>>;

/** One reading of the input level. */
export interface AudioLevelFrame {
  /** 0–1, 0 is silence. */
  readonly level: number;
  /**
   * System sound on macOS: some app plays to the output. Silence while
   * something plays means the access is missing. `null` when unknown.
   */
  readonly playing: boolean | null;
}

/** What Claude Code is on this computer. */
export type AgentState =
  | { readonly status: "notInstalled" }
  | { readonly status: "needsLogin"; readonly version: string }
  | {
      readonly status: "ready";
      readonly version: string;
      /** `subscriptionType` of `claude auth status`, e.g. "max". */
      readonly subscription: string | null;
    }
  /** The CLI failed or hung; `message` is for the support log. */
  | { readonly status: "error"; readonly message: string };

export type AgentInstallStage = "downloading" | "installing" | "verifying";

/**
 * The install reports its stage, then ends with the agent's status. The
 * percent is approximate: the installer only tells the stages apart.
 */
export type AgentInstallEvent =
  | {
      readonly type: "progress";
      readonly stage: AgentInstallStage;
      readonly percent: number;
    }
  | { readonly type: "installed"; readonly agent: AgentState };

export class ClipboardError extends Schema.TaggedError<ClipboardError>()(
  "ClipboardError",
  { message: Schema.String }
) {}

/**
 * The CLI didn't take the login code (wrong or expired). The login session
 * is closed: a new one starts with `loginStart`.
 */
export class AgentLoginCodeError extends Schema.TaggedError<AgentLoginCodeError>()(
  "AgentLoginCodeError",
  { message: Schema.String }
) {}

export const LEVEL_INTERVAL_MS = 120;
const START_LEVEL = 0.4;
const MIN_LEVEL = 0.05;
/** How far the fake level can move between two frames, 0–1. */
const LEVEL_JITTER = 0.35;

export class OnboardingBackend extends Context.Service<
  OnboardingBackend,
  {
    /* Accesses ------------------------------------------------------- */

    /** Both accesses as they are now. Never shows a system dialog. */
    readonly permissions: Effect.Effect<Permissions, BackendError>;
    /**
     * Asks for one access (the system dialog, where the OS has one) and
     * resolves to the state after the user's answer.
     */
    readonly requestPermission: (
      kind: PermissionKind
    ) => Effect.Effect<PermissionStatus, BackendError>;
    /** Opens the System Settings pane where the access is turned on. */
    readonly openPermissionSettings: (
      kind: PermissionKind
    ) => Effect.Effect<void, BackendError>;

    /* Agent ---------------------------------------------------------- */

    /** Looks for Claude Code and checks its login. Never calls the model. */
    readonly agentStatus: Effect.Effect<AgentState, BackendError>;
    /** Installs Claude Code. Interrupting cancels the install. */
    readonly installAgent: Stream.Stream<AgentInstallEvent, BackendError>;
    /**
     * Starts the browser login and resolves to the login page URL, for
     * "Открыть страницу ещё раз". The CLI opens the browser itself.
     */
    readonly loginStart: Effect.Effect<string, BackendError>;
    /**
     * Passes the code from the browser to the CLI; the status after it. A
     * refused code is `AgentLoginCodeError`; no login in progress (expired,
     * cancelled, after a refused code) is a `NotFound` `BackendError`.
     */
    readonly loginSubmit: (
      code: string
    ) => Effect.Effect<AgentState, AgentLoginCodeError | BackendError>;
    /** Stops the login session. */
    readonly loginCancel: Effect.Effect<void, BackendError>;
    /** Opens the login page again in the default browser. */
    readonly openLoginPage: (url: string) => Effect.Effect<void, BackendError>;
    /**
     * Starts the app again. macOS shows a system audio access granted in
     * the prompt only to a new process. In Tauri this never resolves.
     */
    readonly restartApp: Effect.Effect<void, BackendError>;

    /* Audio, clipboard, window --------------------------------------- */

    /**
     * The input level of the microphone or the system sound while the stream
     * runs. Fails with an `External` `BackendError` whose `reason` says why
     * the source can't be opened (`noAccess`, `noDevice`, `busy`).
     */
    readonly audioLevel: (
      source: AudioSource
    ) => Stream.Stream<AudioLevelFrame, BackendError>;
    /** Copies text for the support chat. */
    readonly copyText: (text: string) => Effect.Effect<void, ClipboardError>;
    /** Emits when this window gets the focus back. */
    readonly windowFocus: Stream.Stream<void, BackendError>;
  }
>()("grill/features/onboarding/OnboardingBackend") {
  static readonly layerTauri = Layer.sync(OnboardingBackend, () =>
    OnboardingBackend.of({
      agentStatus: call(() => commands.agentStatus()).pipe(
        Effect.map(fromBindingsAgent)
      ),
      audioLevel: tauriAudioLevel,
      copyText,
      // The progress events until `agent_install` answers with the status
      installAgent: listen(events.agentInstallProgress).pipe(
        Stream.map(
          (progress): AgentInstallEvent => ({
            percent: Math.round(progress.progress * FULL),
            stage: progress.stage,
            type: "progress",
          })
        ),
        Stream.merge(
          Stream.fromEffect(
            call(() => commands.agentInstall()).pipe(
              Effect.map(
                (agent): AgentInstallEvent => ({
                  agent: fromBindingsAgent(agent),
                  type: "installed",
                })
              ),
              Effect.onInterrupt(() =>
                Effect.ignore(call(() => commands.agentInstallCancel()))
              )
            )
          ),
          { haltStrategy: "right" }
        )
      ),
      loginCancel: Effect.asVoid(call(() => commands.agentLoginCancel())),
      loginStart: call(() => commands.agentLoginStart()),
      loginSubmit: (code: string) =>
        call(() => commands.agentLoginSubmit(code)).pipe(
          Effect.map(fromBindingsAgent),
          Effect.mapError((error) =>
            error.kind === "Invalid"
              ? new AgentLoginCodeError({ message: error.message })
              : error
          )
        ),
      openLoginPage: (url: string) =>
        Effect.tryPromise({ catch: transportError, try: () => openUrl(url) }),
      openPermissionSettings: (kind: PermissionKind) =>
        Effect.asVoid(call(() => commands.permissionOpenSettings(kind))),
      permissions: call(() => commands.permissionsGet()).pipe(
        Effect.map(
          (read): Permissions => ({
            microphone: fromBindingsStatus(read.microphone),
            systemAudio: fromBindingsStatus(read.systemAudio),
          })
        )
      ),
      requestPermission: (kind: PermissionKind) =>
        call(() => commands.permissionRequest(kind)).pipe(
          Effect.map(fromBindingsStatus)
        ),
      restartApp: Effect.asVoid(call(() => commands.appRestart())),
      windowFocus: Stream.callback<void, BackendError>((queue) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            catch: transportError,
            try: () =>
              getCurrentWindow().onFocusChanged(({ payload: focused }) => {
                if (focused) {
                  Queue.offerUnsafe(queue, undefined);
                }
              }),
          }),
          (unlisten) => Effect.sync(unlisten)
        )
      ),
    })
  );

  static readonly layerMock = Layer.sync(OnboardingBackend, () =>
    OnboardingBackend.of({
      agentStatus: Effect.sleep(MOCK_DELAY_MS.agentCheck).pipe(
        Effect.map(() => mockComputer.findAgent())
      ),
      audioLevel: (_source: AudioSource) =>
        Stream.unfold(START_LEVEL, (level) =>
          Effect.gen(function* () {
            yield* Effect.sleep(LEVEL_INTERVAL_MS);
            const jitter = ((yield* Random.next) - 0.5) * LEVEL_JITTER * 2;
            const next = Math.min(1, Math.max(MIN_LEVEL, level + jitter));
            return [{ level: next, playing: null }, next] as const;
          })
        ),
      copyText,
      installAgent: mockDownload(
        0,
        MOCK_DELAY_MS.installTick,
        INSTALL_STEP
      ).pipe(
        Stream.map(
          (percent): AgentInstallEvent => ({
            percent,
            stage: installStage(percent),
            type: "progress",
          })
        ),
        Stream.concat(
          Stream.fromEffect(
            Effect.sync(
              (): AgentInstallEvent => ({
                agent: mockComputer.install(),
                type: "installed",
              })
            )
          )
        )
      ),
      loginCancel: Effect.sync(() => mockComputer.closeLogin()),
      loginStart: Effect.sleep(MOCK_DELAY_MS.loginStart).pipe(
        Effect.map(() => mockComputer.openLogin())
      ),
      loginSubmit: (code: string) =>
        Effect.sleep(MOCK_DELAY_MS.loginSubmit).pipe(
          Effect.flatMap(() => mockComputer.submitLogin(code))
        ),
      openLoginPage: (_url: string) => Effect.void,
      openPermissionSettings: (_kind: PermissionKind) =>
        Effect.sync(() => mockComputer.openSettings()),
      permissions: Effect.sleep(MOCK_DELAY_MS.permissionsCheck).pipe(
        Effect.map(() => mockComputer.readPermissions())
      ),
      requestPermission: (kind: PermissionKind) =>
        Effect.suspend(() => mockComputer.ask(kind)),
      restartApp: Effect.void,
      windowFocus: Stream.never,
    })
  );
}

/* ---------------------------------------------------------------------- */
/* Tauri                                                                   */
/* ---------------------------------------------------------------------- */

/** Registers a listener of a generated event; resolves to its removal. */
function listenEvent<T>(
  event: {
    listen: (handler: (event: { payload: T }) => void) => Promise<() => void>;
  },
  onPayload: (payload: T) => void
) {
  return Effect.acquireRelease(
    Effect.tryPromise({
      catch: transportError,
      try: () => event.listen(({ payload }) => onPayload(payload)),
    }),
    (unlisten) => Effect.sync(unlisten)
  );
}

/*
 * The level of `source` while the stream runs. Listens first, then
 * subscribes the window (`audio_level_start`), so the first frames and an
 * early stop aren't lost; the finalizer unsubscribes. Rust sends
 * `AudioLevelStopped` when it drops the subscription: the window was
 * hidden (the stream ends, the page subscribes again on focus) or the
 * capture failed (the stream fails with the reason).
 */
export function tauriAudioLevel(source: AudioSource) {
  return Stream.callback<AudioLevelFrame, BackendError>((queue) =>
    Effect.gen(function* () {
      yield* listenEvent(events.audioLevel, (frame) => {
        if (frame.source === source) {
          Queue.offerUnsafe(queue, {
            level: frame.level,
            playing: frame.playing ?? null,
          });
        }
      });
      yield* listenEvent(events.audioLevelStopped, (stopped) => {
        if (stopped.source !== source) {
          return;
        }
        if (stopped.reason || stopped.message) {
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(
              new BackendError({
                kind: "External",
                message: stopped.message ?? "Захват звука остановился",
                ...(stopped.reason ? { reason: stopped.reason } : {}),
              })
            )
          );
        } else {
          Queue.endUnsafe(queue);
        }
      });
      yield* Effect.acquireRelease(
        call(() => commands.audioLevelStart(source)),
        () => Effect.ignore(call(() => commands.audioLevelStop(source)))
      );
    })
  );
}

/* ---------------------------------------------------------------------- */
/* Shared by both layers                                                   */
/* ---------------------------------------------------------------------- */

function transportError(cause: unknown) {
  return new BackendError({
    kind: "Transport",
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function fromBindingsStatus(
  status: BindingsPermissionStatus
): PermissionStatus {
  return { message: status.message ?? null, state: status.state };
}

function fromBindingsAgent(agent: BindingsAgentState): AgentState {
  if (agent.status === "ready") {
    return {
      status: "ready",
      subscription: agent.subscriptionType,
      version: agent.version,
    };
  }
  return agent;
}

function copyText(text: string) {
  return Effect.tryPromise({
    catch: () => new ClipboardError({ message: "Буфер обмена недоступен" }),
    try: () => navigator.clipboard.writeText(text),
  });
}

/* ---------------------------------------------------------------------- */
/* The mock computer                                                       */
/* ---------------------------------------------------------------------- */

/** Durations of the simulated work, ms. */
export const MOCK_DELAY_MS = {
  agentCheck: 1500,
  installTick: 100,
  loginStart: 800,
  loginSubmit: 1000,
  permissionsCheck: 900,
} as const;

const FULL = 100;
const INSTALL_STEP = 4;
const INSTALLING_FROM = 35;
const VERIFYING_FROM = 70;

/** The shortest code the mock CLI takes. */
export const MOCK_LOGIN_CODE_LENGTH = 8;
export const MOCK_LOGIN_URL =
  "https://claude.ai/oauth/authorize?code=true&client_id=grill-mock&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";

const MOCK_AGENT_VERSION = "2.1.4";
const MOCK_SUBSCRIPTION = "max";

/** Percents from `from` up to 100, one per `tick` ms. */
function mockDownload(from: number, tick: number, step: number) {
  return Stream.unfold(from, (percent) =>
    percent >= FULL
      ? Effect.succeed(undefined)
      : Effect.as(Effect.sleep(tick), [
          Math.min(FULL, percent + step),
          Math.min(FULL, percent + step),
        ] as const)
  );
}

function installStage(percent: number): AgentInstallStage {
  if (percent < INSTALLING_FROM) {
    return "downloading";
  }
  return percent < VERIFYING_FROM ? "installing" : "verifying";
}

interface MockComputerState {
  agent: AgentState;
  /** `loginStart` ran and no code was submitted since. */
  loginOpen: boolean;
  permissions: Record<PermissionKind, PermissionState>;
  /** Answers the fake macOS dialog is waiting for. */
  prompts: Map<PermissionKind, (state: PermissionState) => void>;
  /**
   * The user opened System Settings. The mock assumes they flipped every
   * denied toggle there, so the next read finds the accesses on.
   */
  settingsOpened: boolean;
}

function freshComputer(): MockComputerState {
  return {
    agent: { status: "needsLogin", version: MOCK_AGENT_VERSION },
    loginOpen: false,
    permissions: { microphone: "notDetermined", systemAudio: "notDetermined" },
    prompts: new Map(),
    settingsOpened: false,
  };
}

let computer = freshComputer();

/*
 * What `layerMock` reads and changes. Plain synchronous state, so the fake
 * macOS dialog and the dev `force*` helpers of the store can set it the way
 * a user would in the real OS. Not part of the contract: the Tauri layer
 * has the real computer.
 */
export const mockComputer = {
  /** The fake macOS dialog was answered. */
  answer(kind: PermissionKind, allowed: boolean) {
    const state: PermissionState = allowed ? "granted" : "denied";
    computer.permissions[kind] = state;
    const prompt = computer.prompts.get(kind);
    computer.prompts.delete(kind);
    prompt?.(state);
  },

  /** `requestPermission`: waits for the fake dialog unless already answered. */
  ask(kind: PermissionKind): Effect.Effect<PermissionStatus> {
    const state = computer.permissions[kind];
    if (state === "granted" || state === "denied") {
      return Effect.succeed({ message: null, state });
    }
    return Effect.callback<PermissionStatus>((resume) => {
      computer.prompts.set(kind, (answer) =>
        resume(Effect.succeed({ message: null, state: answer }))
      );
      return Effect.sync(() => {
        computer.prompts.delete(kind);
      });
    });
  },

  closeLogin() {
    computer.loginOpen = false;
  },

  /** `agentStatus`. "Проверить снова" finds an agent the user installed. */
  findAgent(): AgentState {
    if (computer.agent.status === "notInstalled") {
      computer.agent = { status: "needsLogin", version: MOCK_AGENT_VERSION };
    }
    return computer.agent;
  },

  install(): AgentState {
    computer.agent = { status: "needsLogin", version: MOCK_AGENT_VERSION };
    return computer.agent;
  },

  openLogin(): string {
    computer.loginOpen = true;
    return MOCK_LOGIN_URL;
  },

  openSettings() {
    computer.settingsOpened = true;
  },

  readPermissions(): Permissions {
    if (computer.settingsOpened) {
      for (const kind of ["microphone", "systemAudio"] as const) {
        if (computer.permissions[kind] === "denied") {
          computer.permissions[kind] = "granted";
        }
      }
    }
    return {
      microphone: { message: null, state: computer.permissions.microphone },
      systemAudio: { message: null, state: computer.permissions.systemAudio },
    };
  },

  /** Back to a fresh computer (tests, "Пройти настройку заново"). */
  reset() {
    computer = freshComputer();
  },

  /** Dev only: what the agent is. */
  setAgent(status: AgentState["status"]) {
    computer.loginOpen = false;
    switch (status) {
      case "notInstalled":
        computer.agent = { status };
        break;
      case "ready":
        computer.agent = {
          status,
          subscription: MOCK_SUBSCRIPTION,
          version: MOCK_AGENT_VERSION,
        };
        break;
      case "error":
        computer.agent = { message: "Claude Code не отвечает", status };
        break;
      default:
        computer.agent = { status, version: MOCK_AGENT_VERSION };
    }
  },

  /** Dev only: how the accesses are set. */
  setPermissions(permissions: Record<PermissionKind, PermissionState>) {
    computer.permissions = { ...permissions };
    computer.prompts.clear();
    computer.settingsOpened = false;
  },

  /** `loginSubmit`: any code of 8+ characters logs in. */
  submitLogin(
    code: string
  ): Effect.Effect<AgentState, AgentLoginCodeError | BackendError> {
    const open = computer.loginOpen;
    computer.loginOpen = false;
    if (!open) {
      return Effect.fail(
        new BackendError({ kind: "NotFound", message: "Вход не начат" })
      );
    }
    if (code.trim().length < MOCK_LOGIN_CODE_LENGTH) {
      return Effect.fail(
        new AgentLoginCodeError({ message: "Код не подошёл" })
      );
    }
    computer.agent = {
      status: "ready",
      subscription: MOCK_SUBSCRIPTION,
      version: MOCK_AGENT_VERSION,
    };
    return Effect.succeed(computer.agent);
  },
};
