import { Clock, Context, Effect, Layer, Queue, Stream } from "effect";

import {
  type RecordingStatus as BindingsRecordingStatus,
  commands,
  events,
  type MicActivityChanged,
  type RecordingChannels,
  type SegmentationStatus,
} from "@/bindings";
import { uuidv7 } from "@/data/services/mock-database";
import { BackendError, call, listen } from "@/effect/tauri";

/*
 * The recorder and the microphone watch (audio-capture design.md, 19):
 * - start / stop the recording of both channels, its status and its
 *   changes, the live levels of "Я" and "Остальные";
 * - whether another app holds the microphone (`micActivity`), which opens
 *   the start widget and the "Микрофон освободился" offer.
 *
 * `layerTauri` runs the Rust commands and events. `layerMock` plays them on
 * timers for the browser and the tests: one recording at a time, levels on
 * two sines, and a meeting app (`mockMicActivity` below) that the demo
 * buttons ("Выйти из встречи", the call script's end) let go of.
 */

export type { ChannelState } from "@/bindings";

/** The recording now; `id` is null when nothing is recorded. */
export interface RecordingStatus {
  readonly channels: RecordingChannels;
  readonly id: string | null;
  readonly segmentation: SegmentationStatus;
  /** Ms since the epoch, null when nothing is recorded. */
  readonly startedAt: number | null;
}

/** Both channels' input levels, 0–1. */
export interface RecordingLevels {
  readonly me: number;
  readonly others: number;
}

/**
 * Another app and the microphone:
 * - busy: `app` holds it since `since`;
 * - free: `app` let it go at `since` (5 s after the input stopped). Before
 *   the first busy period `app` is null.
 */
export interface MicActivity {
  readonly app: string | null;
  readonly busy: boolean;
  /** Ms since the epoch. */
  readonly since: number;
}

/** How often the levels come, as from Rust (~10 Hz). */
export const LEVELS_INTERVAL_MS = 100;

const IDLE_CHANNELS: RecordingChannels = { me: "ok", others: "ok" };

/* ---------------------------------------------------------------------- */
/* The mock recorder and meeting app                                       */
/* ---------------------------------------------------------------------- */

/** The meeting app of the browser demo, as the widget names it. */
export const MOCK_MEETING_APP = "Zoom";

const SINE_STEP = 0.35;
const LEVEL_MID = 0.45;
const LEVEL_SWING = 0.35;
/** "Остальные" moves slower and out of phase with "Я". */
const OTHERS_RATE = 0.6;
const OTHERS_PHASE = 1.7;

function sineLevels(tick: number): RecordingLevels {
  const at = tick * SINE_STEP;
  return {
    me: LEVEL_MID + LEVEL_SWING * Math.sin(at),
    others: LEVEL_MID + LEVEL_SWING * Math.sin(at * OTHERS_RATE + OTHERS_PHASE),
  };
}

type Listener<T> = (value: T) => void;

/** Emits every value given to `listeners` while the stream runs. */
function mockStream<T>(listeners: Set<Listener<T>>) {
  return Stream.callback<T, BackendError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener: Listener<T> = (value) => {
          Queue.offerUnsafe(queue, value);
        };
        listeners.add(listener);
        return listener;
      }),
      (listener) => Effect.sync(() => listeners.delete(listener))
    )
  );
}

function freshActivity(): MicActivity {
  return { app: MOCK_MEETING_APP, busy: true, since: Date.now() };
}

const mock = {
  activity: freshActivity(),
  activityListeners: new Set<Listener<MicActivity>>(),
  /** Every id `start` gave, so `stop` tells unknown ones apart. */
  known: new Set<string>(),
  notifyActivity() {
    for (const listener of mock.activityListeners) {
      listener(mock.activity);
    }
  },
  notifyStatus() {
    const status = mock.status();
    for (const listener of mock.statusListeners) {
      listener(status);
    }
  },
  recording: null as { id: string; startedAt: number } | null,
  status(): RecordingStatus {
    return {
      channels: IDLE_CHANNELS,
      id: mock.recording?.id ?? null,
      segmentation: "ok",
      startedAt: mock.recording?.startedAt ?? null,
    };
  },
  statusListeners: new Set<Listener<RecordingStatus>>(),
};

export class RecordingBackend extends Context.Service<
  RecordingBackend,
  {
    /**
     * Starts recording and resolves to its id; while a recording runs,
     * resolves to its id. No microphone access: an `External` error with
     * `reason: "noAccess"`.
     */
    readonly start: (
      callId?: string | null
    ) => Effect.Effect<string, BackendError>;
    /** Stops the recording `id`; an unknown id is `NotFound`. */
    readonly stop: (id: string) => Effect.Effect<void, BackendError>;
    readonly status: Effect.Effect<RecordingStatus, BackendError>;
    /** Every change of the status: start, stop, a channel's state. */
    readonly changes: Stream.Stream<RecordingStatus, BackendError>;
    /** ~10 Hz while recording and the window is visible. */
    readonly levels: Stream.Stream<RecordingLevels, BackendError>;
    /** Every change of who holds the microphone. */
    readonly micActivity: Stream.Stream<MicActivity, BackendError>;
    /** Who holds the microphone now. */
    readonly micActivityNow: Effect.Effect<MicActivity, BackendError>;
  }
>()("grill/features/recording/RecordingBackend") {
  static readonly layerTauri = Layer.succeed(RecordingBackend, {
    changes: listen(events.recordingChanged).pipe(Stream.map(fromBindings)),
    levels: listen(events.recordingLevels),
    micActivity: listen(events.micActivityChanged).pipe(
      Stream.map(fromBindingsActivity)
    ),
    micActivityNow: call(() => commands.micActivityGet()).pipe(
      Effect.map(fromBindingsActivity)
    ),
    start: (callId?: string | null) =>
      call(() => commands.recordingStart({ callId: callId ?? null })),
    status: call(() => commands.recordingStatus()).pipe(
      Effect.map(fromBindings)
    ),
    stop: (id: string) => Effect.asVoid(call(() => commands.recordingStop(id))),
  });

  static readonly layerMock = Layer.succeed(RecordingBackend, {
    changes: mockStream(mock.statusListeners),
    levels: Stream.unfold(0, (tick) =>
      Effect.as(Effect.sleep(LEVELS_INTERVAL_MS), [
        sineLevels(tick + 1),
        tick + 1,
      ] as const)
    ),
    micActivity: mockStream(mock.activityListeners),
    micActivityNow: Effect.sync(() => mock.activity),
    start: (_callId?: string | null) =>
      Effect.gen(function* () {
        if (mock.recording) {
          return mock.recording.id;
        }
        const now = yield* Clock.currentTimeMillis;
        const id = uuidv7(now);
        mock.recording = { id, startedAt: now };
        mock.known.add(id);
        mock.notifyStatus();
        return id;
      }),
    status: Effect.sync(() => mock.status()),
    stop: (id: string) =>
      Effect.suspend(() => {
        if (!mock.known.has(id)) {
          return Effect.fail(
            new BackendError({
              kind: "NotFound",
              message: `Записи ${id} нет`,
            })
          );
        }
        if (mock.recording?.id === id) {
          mock.recording = null;
          mock.notifyStatus();
        }
        return Effect.void;
      }),
  });
}

/* ---------------------------------------------------------------------- */
/* Tauri                                                                   */
/* ---------------------------------------------------------------------- */

function fromBindings(status: BindingsRecordingStatus): RecordingStatus {
  return {
    channels: status.channels,
    id: status.id ?? null,
    segmentation: status.segmentation,
    startedAt: status.startedAt ?? null,
  };
}

function fromBindingsActivity(activity: MicActivityChanged): MicActivity {
  return {
    app: activity.app ?? null,
    busy: activity.busy,
    since: activity.since,
  };
}

/*
 * The meeting app of `layerMock`: the browser demo's buttons take and free
 * the microphone through it, as Zoom would on the real computer. Not part
 * of the contract.
 */
export const mockMicActivity = {
  /** `app` takes the microphone. */
  hold(app: string = MOCK_MEETING_APP, at: number = Date.now()) {
    if (mock.activity.busy && mock.activity.app === app) {
      return;
    }
    mock.activity = { app, busy: true, since: at };
    mock.notifyActivity();
  },

  /**
   * The app lets the microphone go ("Выйти из встречи"). Freed already, it
   * takes it first, so every press is a new busy → free.
   */
  release(at: number = Date.now()) {
    const app = mock.activity.app ?? MOCK_MEETING_APP;
    if (!mock.activity.busy) {
      mockMicActivity.hold(app, at);
    }
    mock.activity = { app, busy: false, since: at };
    mock.notifyActivity();
  },

  /** Back to the start: Zoom holds the microphone, nothing is recorded. */
  reset() {
    mock.activity = freshActivity();
    mock.recording = null;
    mock.known.clear();
  },
};
