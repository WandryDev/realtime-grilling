import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Context, Effect, Layer, Queue, Random, Stream } from "effect";

import {
  type AgentState,
  type AgentUsage,
  type AudioInputs,
  commands,
  type DataSummary,
  events,
  type RecordingsInfo,
} from "@/bindings";
import {
  BackendError,
  call,
  currentThenChanges,
  subscribe,
} from "@/effect/tauri";
import { tauriAudioLevel } from "@/features/onboarding/backend";

import {
  AGENT,
  AGENT_UTILIZATION,
  DATA_SUMMARY,
  MICROPHONES,
  RECORDINGS,
} from "./mock";

/*
 * Backend contract of every Settings operation that needs the system
 * (settings-real design.md, decision 9). `layerTauri` runs the Rust
 * commands; `layerMock` plays a computer with timers for the browser demo,
 * `/dev` and the tests in browser mode.
 *
 * The contract types (`AgentState`, `AudioInputs`, `RecordingsInfo`…) are
 * the generated ones of `src/bindings.ts`.
 */

export type AudioChannel = "microphone" | "system";

const PERCENT = 100;
const LEVEL_TICK_MS = 160;

export class SettingsBackend extends Context.Service<
  SettingsBackend,
  {
    /** The recordings' folder, what its files take and the calls with audio. */
    readonly recordingsInfo: Effect.Effect<RecordingsInfo, BackendError>;
    /** Opens the folder in Finder (Explorer on Windows). */
    readonly revealInFinder: (
      path: string
    ) => Effect.Effect<void, BackendError>;
    /**
     * The microphones and the chosen one's state, then every change, while
     * the stream runs (Rust polls the devices only while subscribed). Ends
     * when the app stopped listening on its own (the window was hidden).
     */
    readonly audioInputs: Stream.Stream<AudioInputs, BackendError>;
    /**
     * Live input level of a channel, 0–100, while the stream runs. Fails
     * with an `External` `BackendError` whose `reason` says why the source
     * can't be opened; ends when the app stopped listening on its own (the
     * window was hidden).
     */
    readonly inputLevel: (
      channel: AudioChannel
    ) => Stream.Stream<number, BackendError>;
    /** Records the chosen microphone for a moment; what was recognized. */
    readonly soundCheck: Effect.Effect<string, BackendError>;
    /**
     * Asks Claude Code what it is: at the saved path (or found by itself)
     * without `path`, at `path` otherwise. Never saves the path.
     */
    readonly checkAgent: (
      path?: string
    ) => Effect.Effect<AgentState, BackendError>;
    /** The last known share of the subscription limit, `null` without one. */
    readonly agentUsage: Effect.Effect<AgentUsage | null, BackendError>;
    /** «Удалить всё»: what it deletes. */
    readonly dataSummary: Effect.Effect<DataSummary, BackendError>;
    /**
     * Deletes the data, the recordings and the connectors' secrets, resets
     * the settings and starts onboarding again. Refused (`Invalid`) while a
     * call records.
     */
    readonly deleteAllData: Effect.Effect<void, BackendError>;
  }
>()("grill/features/settings/SettingsBackend") {
  static readonly layerTauri = Layer.succeed(SettingsBackend, {
    agentUsage: call(() => commands.agentUsage()),
    audioInputs: currentThenChanges(
      (emit, end) =>
        Effect.gen(function* () {
          yield* subscribe(events.audioInputsChanged, emit);
          // Hiding the window dropped its subscription in Rust.
          yield* subscribe(events.audioInputsStopped, end);
          yield* Effect.acquireRelease(
            call(() => commands.audioInputsStart()),
            () => Effect.ignore(call(() => commands.audioInputsStop()))
          );
        }),
      call(() => commands.audioInputsGet())
    ),
    checkAgent: (path?: string) =>
      path === undefined
        ? call(() => commands.agentStatus())
        : call(() => commands.agentCheckPath(path)),
    dataSummary: call(() => commands.dataSummary()),
    deleteAllData: Effect.asVoid(call(() => commands.dataDeleteAll())),
    inputLevel: (channel: AudioChannel) =>
      tauriAudioLevel(channel).pipe(
        Stream.map((frame) => Math.round(frame.level * PERCENT))
      ),
    recordingsInfo: call(() => commands.recordingsInfo()),
    revealInFinder: (path: string) =>
      Effect.tryPromise({
        catch: (cause) =>
          new BackendError({
            kind: "Transport",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        try: () => revealItemInDir(path),
      }),
    soundCheck: call(() => commands.speechMicCheck()),
  });

  /*
   * Speech-like noise on the microphone, near silence on the system audio.
   * Claude Code is ready at any path ending with `claude`. The microphones
   * are `mockMicrophones` below.
   */
  static readonly layerMock = Layer.succeed(SettingsBackend, {
    agentUsage: Effect.sync(() => ({
      measuredAt: Date.now() - MOCK_USAGE_AGE_MS,
      utilization: AGENT_UTILIZATION,
    })),
    audioInputs: Stream.callback<AudioInputs, BackendError>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          mockMicrophones.subscribe((inputs) => {
            Queue.offerUnsafe(queue, inputs);
          })
        ),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
    ),
    checkAgent: (path?: string) =>
      Effect.as(
        Effect.sleep(MOCK_AGENT_CHECK_MS),
        path === undefined || path.trim().endsWith("claude")
          ? AGENT
          : ({ status: "notInstalled" } satisfies AgentState)
      ),
    dataSummary: Effect.succeed(DATA_SUMMARY),
    deleteAllData: Effect.sleep("1500 millis"),
    inputLevel: (channel: AudioChannel) =>
      Stream.iterate(0, (tick) => tick + 1).pipe(
        Stream.mapEffect(() =>
          Effect.gen(function* () {
            yield* Effect.sleep(LEVEL_TICK_MS);
            const noise = yield* Random.next;
            const level =
              channel === "microphone" ? 35 + noise * 45 : noise * 6;
            return Math.round(level);
          })
        )
      ),
    recordingsInfo: Effect.succeed(RECORDINGS),
    revealInFinder: (_path: string) => Effect.void,
    soundCheck: Effect.as(
      Effect.sleep("2500 millis"),
      "Раз, два, проверка. Меня хорошо слышно?"
    ),
  });
}

/* ---------------------------------------------------------------------- */
/* The mock computer                                                       */
/* ---------------------------------------------------------------------- */

const MOCK_AGENT_CHECK_MS = 600;
const MOCK_USAGE_AGE_MS = 20 * 60_000;

const MOCK_INPUTS: AudioInputs = {
  devices: MICROPHONES,
  missingSince: null,
  selected: "system",
};

let currentInputs = MOCK_INPUTS;
const inputListeners = new Set<(next: AudioInputs) => void>();

/*
 * The microphones `layerMock` reports. Plain synchronous state, so a demo
 * state can unplug a device the way a user would. Not part of the
 * contract: the Tauri layer has the real devices.
 */
export const mockMicrophones = {
  /** Unplugs a device; `since` is when the chosen one went missing. */
  disconnect(name: string, since: number) {
    mockMicrophones.set({
      devices: currentInputs.devices.filter((device) => device.name !== name),
      missingSince: since,
      selected: name,
    });
  },
  /** Back to the demo's microphones (tests). */
  reset() {
    mockMicrophones.set(MOCK_INPUTS);
  },
  set(next: AudioInputs) {
    currentInputs = next;
    for (const listener of inputListeners) {
      listener(currentInputs);
    }
  },
  /** Calls `listener` with the devices now and on every change. */
  subscribe(listener: (next: AudioInputs) => void) {
    inputListeners.add(listener);
    listener(currentInputs);
    return () => {
      inputListeners.delete(listener);
    };
  },
};
