import {
  Context,
  Effect,
  Fiber,
  Layer,
  Queue,
  type Scope,
  Stream,
} from "effect";

import {
  type BenchmarkResult,
  commands,
  events,
  type ModelId,
  type ModelState,
  type RefineState,
  type SpeechModel,
  type TranscriptChannel,
  type TranscriptPass,
  type TranscriptSegment,
  type TranscriptState,
} from "@/bindings";
import { BackendError, call, listen, subscribe } from "@/effect/tauri";
import { mockRecordingId } from "@/features/recording/backend";

/*
 * Speech recognition (speech-recognition design.md, decision 16):
 * - the two Whisper models: their list and changes, download, pause,
 *   cancel, remove and which one recognizes;
 * - the hardware check and the mic check of a model;
 * - the transcript of a recording: what is stored, the live events of
 *   the recognizer and the progress of the second pass.
 *
 * `layerTauri` runs the Rust commands and events. `layerMock` plays them on
 * timers for the browser and the tests: turbo downloads in ~4 s, its sum
 * is checked, the hardware check passes and the mic check hears the demo
 * phrase. The mock has no live transcript: the browser call window plays
 * its own script (`CallBackend.layerMock`).
 */

export type {
  BenchmarkFailure,
  BenchmarkResult,
  ModelId,
  ModelState,
  RefineState,
  SpeechModel,
  TranscriptChannel,
  TranscriptSegment,
} from "@/bindings";

/** What the recognizer says about a recording while it records. */
export type TranscriptEvent =
  /** Phrases stored before the events (`transcriptFeed` only). */
  | { readonly segments: readonly TranscriptSegment[]; readonly type: "stored" }
  /** A phrase went to recognition: "расшифровываю" in its place. */
  | {
      readonly channel: TranscriptChannel;
      readonly startMs: number;
      readonly type: "pending";
    }
  /** The phrase is recognized: its text replaces the pending one. */
  | {
      readonly channel: TranscriptChannel;
      readonly endMs: number;
      readonly id: string;
      readonly pass: TranscriptPass;
      readonly startMs: number;
      readonly text: string;
      readonly type: "phrase";
    }
  /** The phrase had no text: the pending one goes away. */
  | {
      readonly channel: TranscriptChannel;
      readonly startMs: number;
      readonly type: "dropped";
    }
  /** The live pass gave up on the phrase: "пропущено", refined later. */
  | {
      readonly channel: TranscriptChannel;
      readonly endMs: number;
      readonly startMs: number;
      readonly type: "skipped";
    }
  /** Seconds of audio waiting for recognition; 0 once caught up. */
  | { readonly seconds: number; readonly type: "lag" };

/** The second pass over a recording. */
export interface RefineProgress {
  /** 0–100. */
  readonly progress: number;
  readonly state: RefineState;
}

export class SpeechBackend extends Context.Service<
  SpeechBackend,
  {
    /* Models --------------------------------------------------------- */

    /** Both models, turbo first. */
    readonly models: Effect.Effect<readonly SpeechModel[], BackendError>;
    /** Every change of a model: progress, state, selection. */
    readonly modelChanges: Stream.Stream<SpeechModel, BackendError>;
    /** Both models now, then after every change; none lost in between. */
    readonly watchModels: Stream.Stream<readonly SpeechModel[], BackendError>;
    /**
     * "Скачать" / "Продолжить" / "Повторить": starts or resumes the download
     * in the background and resolves at once; progress comes as changes.
     */
    readonly download: (
      id: ModelId
    ) => Effect.Effect<SpeechModel, BackendError>;
    /** Stops the download and keeps what is downloaded. */
    readonly pause: (id: ModelId) => Effect.Effect<SpeechModel, BackendError>;
    /** Stops the download and deletes the unfinished file. */
    readonly cancel: (id: ModelId) => Effect.Effect<SpeechModel, BackendError>;
    /** Deletes the model; the selected one while recording is `Invalid`. */
    readonly remove: (id: ModelId) => Effect.Effect<SpeechModel, BackendError>;
    /**
     * Recognize with this model. Only a ready one; while recording only the
     * one already selected (`Invalid` otherwise).
     */
    readonly select: (id: ModelId) => Effect.Effect<SpeechModel, BackendError>;

    /* Checks --------------------------------------------------------- */

    /**
     * The hardware check: the bundled phrases at the pace of a call. The
     * result is stored in the setting `speechBenchmark`. Interrupting
     * cancels it. Never while recording (`Invalid`).
     */
    readonly benchmark: (
      id: ModelId
    ) => Effect.Effect<BenchmarkResult, BackendError>;
    /**
     * Up to 8 s from the microphone, recognized with the selected model; an
     * empty string when nothing was said. Nothing is stored.
     */
    readonly micCheck: Effect.Effect<string, BackendError>;

    /* Transcript ----------------------------------------------------- */

    /** The stored transcript: refined if there is one, else live. */
    readonly transcript: (
      recordingId: string
    ) => Effect.Effect<readonly TranscriptSegment[], BackendError>;
    /** The recognizer's events of a recording from now on. */
    readonly transcriptEvents: (
      recordingId: string
    ) => Stream.Stream<TranscriptEvent, BackendError>;
    /**
     * The stored transcript (one `stored` event), then the events. Listens
     * before it reads, so nothing said in between is lost.
     */
    readonly transcriptFeed: (
      recordingId: string
    ) => Stream.Stream<TranscriptEvent, BackendError>;
    /**
     * The second pass of a recording; ends with `done` or `failed`. A pass
     * already over (also before the stream listened) ends it at once.
     */
    readonly refine: (
      recordingId: string
    ) => Stream.Stream<RefineProgress, BackendError>;
  }
>()("grill/features/speech/SpeechBackend") {
  static readonly layerTauri = Layer.succeed(SpeechBackend, {
    benchmark: (id: ModelId) =>
      call(() => commands.speechBenchmark(id)).pipe(
        Effect.onInterrupt(() =>
          call(() => commands.speechBenchmarkCancel()).pipe(Effect.ignore)
        )
      ),
    cancel: (id: ModelId) => call(() => commands.speechModelCancel(id)),
    download: (id: ModelId) => call(() => commands.speechModelDownload(id)),
    micCheck: call(() => commands.speechMicCheck()),
    modelChanges: listen(events.speechModelChanged),
    models: call(() => commands.speechModelsList()),
    pause: (id: ModelId) => call(() => commands.speechModelPause(id)),
    refine: (recordingId: string) =>
      Stream.callback<RefineProgress, BackendError>((queue) =>
        Effect.gen(function* () {
          yield* subscribe(events.transcriptRefine, (event) => {
            if (event.recordingId === recordingId) {
              Queue.offerUnsafe(queue, {
                progress: event.progress,
                state: event.state,
              });
            }
          });
          // Read after listening: a pass that ended before is not missed.
          const stored = yield* call(() =>
            commands.transcriptState(recordingId)
          );
          const over = refineOver(stored);
          if (over) {
            Queue.offerUnsafe(queue, over);
          }
        })
      ).pipe(Stream.takeUntil((event) => event.state !== "refining")),
    remove: (id: ModelId) => call(() => commands.speechModelRemove(id)),
    select: (id: ModelId) => call(() => commands.speechModelSelect(id)),
    transcript: (recordingId: string) =>
      call(() => commands.transcriptForRecording(recordingId)),
    transcriptEvents: (recordingId: string) =>
      Stream.callback<TranscriptEvent, BackendError>((queue) =>
        subscribeToTranscript(recordingId, (event) => {
          Queue.offerUnsafe(queue, event);
        })
      ),
    transcriptFeed: (recordingId: string) =>
      Stream.callback<TranscriptEvent, BackendError>((queue) =>
        Effect.gen(function* () {
          let early: TranscriptEvent[] | null = [];
          yield* subscribeToTranscript(recordingId, (event) => {
            if (early) {
              early.push(event);
            } else {
              Queue.offerUnsafe(queue, event);
            }
          });
          const segments = yield* call(() =>
            commands.transcriptForRecording(recordingId)
          );
          Queue.offerUnsafe(queue, { segments, type: "stored" });
          for (const event of early) {
            Queue.offerUnsafe(queue, event);
          }
          early = null;
        })
      ),
    watchModels: Stream.callback<readonly SpeechModel[], BackendError>(
      (queue) =>
        Effect.gen(function* () {
          let list: readonly SpeechModel[] | null = null;
          const early: SpeechModel[] = [];
          yield* subscribe(events.speechModelChanged, (model) => {
            if (list === null) {
              early.push(model);
              return;
            }
            list = withModel(list, model);
            Queue.offerUnsafe(queue, list);
          });
          const read = yield* call(() => commands.speechModelsList());
          // A change heard while reading is at least as new as the read.
          list = early.reduce(withModel, read);
          Queue.offerUnsafe(queue, list);
        })
    ),
  });

  static readonly layerMock = Layer.succeed(SpeechBackend, {
    benchmark: (id: ModelId) =>
      Effect.suspend(() => {
        if (mockRecordingId() !== null) {
          return Effect.fail(
            invalid("Проверку нельзя запустить во время записи")
          );
        }
        if (mock.states[id].status !== "ready") {
          return Effect.succeed(NO_MODEL_RESULT);
        }
        return Effect.as(
          Effect.sleep(MOCK_SPEECH_DELAY_MS.benchmark),
          MOCK_BENCHMARK
        );
      }),
    cancel: (id: ModelId) =>
      Effect.gen(function* () {
        yield* stopMockDownload(id);
        if (mock.states[id].status !== "ready") {
          mock.set(id, NOT_DOWNLOADED);
        }
        return mock.model(id);
      }),
    download: (id: ModelId) =>
      Effect.gen(function* () {
        const { status } = mock.states[id];
        if (
          status === "ready" ||
          status === "downloading" ||
          status === "checking"
        ) {
          return mock.model(id);
        }
        yield* stopMockDownload(id);
        const from = mockPercent(id);
        mock.set(id, downloading(from));
        const run = mock.begin(id);
        mock.downloads.set(
          id,
          yield* Effect.forkDetach(mockDownload(id, from, run))
        );
        return mock.model(id);
      }),
    micCheck: Effect.suspend(() =>
      mock.states[mock.selected].status === "ready"
        ? Effect.as(Effect.sleep(MOCK_SPEECH_DELAY_MS.micCheck), MOCK_MIC_TEXT)
        : Effect.fail(invalid("Модель распознавания не скачана"))
    ),
    modelChanges: Stream.callback<SpeechModel, BackendError>((queue) =>
      mockListener((model) => {
        Queue.offerUnsafe(queue, model);
      })
    ),
    models: Effect.sync(() => mock.list()),
    pause: (id: ModelId) =>
      Effect.gen(function* () {
        yield* stopMockDownload(id);
        if (mock.states[id].status === "downloading") {
          mock.set(id, { percent: mockPercent(id), status: "paused" });
        }
        return mock.model(id);
      }),
    refine: (_recordingId: string) =>
      Stream.range(0, MOCK_REFINE_STEPS).pipe(
        Stream.mapEffect((step) =>
          Effect.as(
            Effect.sleep(MOCK_SPEECH_DELAY_MS.refineStep),
            step === MOCK_REFINE_STEPS
              ? { progress: 100, state: "done" as const }
              : {
                  progress: Math.round((step / MOCK_REFINE_STEPS) * 100),
                  state: "refining" as const,
                }
          )
        )
      ),
    remove: (id: ModelId) =>
      Effect.gen(function* () {
        if (id === mock.selected && mockRecordingId() !== null) {
          return yield* Effect.fail(
            invalid("Модель, которой идёт расшифровка, нельзя удалить")
          );
        }
        yield* stopMockDownload(id);
        mock.set(id, NOT_DOWNLOADED);
        return mock.model(id);
      }),
    select: (id: ModelId) =>
      Effect.suspend(() => {
        if (mock.states[id].status !== "ready") {
          return Effect.fail(invalid("Выбрать можно только скачанную модель"));
        }
        if (id !== mock.selected && mockRecordingId() !== null) {
          return Effect.fail(invalid("Модель нельзя сменить во время записи"));
        }
        mock.select(id);
        return Effect.succeed(mock.model(id));
      }),
    transcript: (_recordingId: string) => Effect.succeed([]),
    transcriptEvents: (_recordingId: string) => Stream.never,
    transcriptFeed: (_recordingId: string) =>
      Stream.concat(
        Stream.succeed<TranscriptEvent>({ segments: [], type: "stored" }),
        Stream.never
      ),
    watchModels: Stream.callback<readonly SpeechModel[], BackendError>(
      (queue) =>
        Effect.gen(function* () {
          yield* mockListener(() => {
            Queue.offerUnsafe(queue, mock.list());
          });
          Queue.offerUnsafe(queue, mock.list());
        })
    ),
  });
}

/** How a second pass that is over ended; `null` while it may still run. */
function refineOver(state: TranscriptState): RefineProgress | null {
  switch (state) {
    case "refined":
      return { progress: 100, state: "done" };
    // Never refined: the live transcript is what there is.
    case "failed":
    case "skipped":
      return { progress: 0, state: "failed" };
    default:
      return null;
  }
}

/** `list` with `model` in place of the one with its id. */
export function withModel(
  list: readonly SpeechModel[],
  model: SpeechModel
): readonly SpeechModel[] {
  const selectionMoved = model.selected;
  const next = list.map((item) => {
    if (item.id === model.id) {
      return model;
    }
    return selectionMoved ? { ...item, selected: false } : item;
  });
  return next.some((item) => item.id === model.id) ? next : [...next, model];
}

/* ---------------------------------------------------------------------- */
/* Tauri                                                                   */
/* ---------------------------------------------------------------------- */

/** Every transcript event of `recordingId`, in the order Rust sent them. */
function subscribeToTranscript(
  recordingId: string,
  emit: (event: TranscriptEvent) => void
): Effect.Effect<void, BackendError, Scope.Scope> {
  const mine = (payload: { recordingId: string }) =>
    payload.recordingId === recordingId;
  return Effect.all(
    [
      subscribe(events.transcriptPending, (event) => {
        if (mine(event)) {
          emit({
            channel: event.channel,
            startMs: event.startMs,
            type: "pending",
          });
        }
      }),
      subscribe(events.transcriptPhrase, (event) => {
        if (mine(event)) {
          emit({
            channel: event.channel,
            endMs: event.endMs,
            id: event.id,
            pass: event.pass,
            startMs: event.startMs,
            text: event.text,
            type: "phrase",
          });
        }
      }),
      subscribe(events.transcriptDropped, (event) => {
        if (mine(event)) {
          emit({
            channel: event.channel,
            startMs: event.startMs,
            type: "dropped",
          });
        }
      }),
      subscribe(events.transcriptSkipped, (event) => {
        if (mine(event)) {
          emit({
            channel: event.channel,
            endMs: event.endMs,
            startMs: event.startMs,
            type: "skipped",
          });
        }
      }),
      subscribe(events.transcriptLag, (event) => {
        if (mine(event)) {
          emit({ seconds: event.seconds, type: "lag" });
        }
      }),
    ],
    { discard: true }
  );
}

/* ---------------------------------------------------------------------- */
/* The mock models                                                          */
/* ---------------------------------------------------------------------- */

/** Durations of the simulated work, ms. */
export const MOCK_SPEECH_DELAY_MS = {
  benchmark: 800,
  checksum: 400,
  downloadTick: 100,
  micCheck: 2000,
  refineStep: 500,
};

/** Percent per download tick: ~4 s from 0 to 100. */
const MOCK_DOWNLOAD_STEP = 2.5;
const MOCK_BYTES_PER_SEC = 12_400_000;
const MOCK_REFINE_STEPS = 4;
const FULL = 100;
const MS_PER_SECOND = 1000;

/** What the mock mic check "hears". */
export const MOCK_MIC_TEXT =
  "Привет, это Дима, проверяю, как Grill меня слышит";

/** A pass on an Apple Silicon Mac, as measured on M3. */
export const MOCK_BENCHMARK: BenchmarkResult = {
  p95Ms: 1473,
  passed: true,
  rtf: 0.18,
  wer: 0.032,
};

const NO_MODEL_RESULT: BenchmarkResult = {
  p95Ms: 0,
  passed: false,
  reason: "noModel",
  rtf: 0,
  wer: 0,
};

const MOCK_CATALOG: readonly Omit<SpeechModel, "selected" | "state">[] = [
  { id: "turbo", name: "Whisper large-v3-turbo", sizeBytes: 574_041_195 },
  { id: "small", name: "Whisper small", sizeBytes: 487_601_967 },
];

const NOT_DOWNLOADED: ModelState = { status: "notDownloaded" };
const CHECKING: ModelState = { status: "checking" };

function downloading(percent: number): ModelState {
  return {
    bytesPerSec: MOCK_BYTES_PER_SEC,
    percent,
    status: "downloading",
  };
}

function invalid(message: string) {
  return new BackendError({ kind: "Invalid", message });
}

type Listener = (model: SpeechModel) => void;

function freshStates(): Record<ModelId, ModelState> {
  return { small: NOT_DOWNLOADED, turbo: NOT_DOWNLOADED };
}

/** Ids of the mock downloads; a stopped or reset one never writes again. */
let lastRun = 0;

const mock = {
  /** A new download of `id`: the one before it no longer writes. */
  begin(id: ModelId): number {
    lastRun += 1;
    mock.runs[id] = lastRun;
    return lastRun;
  },
  downloads: new Map<ModelId, Fiber.Fiber<void>>(),
  list(): SpeechModel[] {
    return MOCK_CATALOG.map((entry) => mock.model(entry.id));
  },
  listeners: new Set<Listener>(),
  model(id: ModelId): SpeechModel {
    const entry =
      MOCK_CATALOG.find((item) => item.id === id) ?? MOCK_CATALOG[0];
    return { ...entry, selected: mock.selected === id, state: mock.states[id] };
  },
  notify(id: ModelId) {
    const model = mock.model(id);
    for (const listener of mock.listeners) {
      listener(model);
    }
  },
  /** The download `run` of `id` moves on, unless it was stopped. */
  progress(run: number, id: ModelId, state: ModelState): boolean {
    if (mock.runs[id] !== run) {
      return false;
    }
    mock.set(id, state);
    return true;
  },
  runs: { small: 0, turbo: 0 } as Record<ModelId, number>,
  select(id: ModelId) {
    const previous = mock.selected;
    mock.selected = id;
    if (previous !== id) {
      mock.notify(previous);
    }
    mock.notify(id);
  },
  selected: "turbo" as ModelId,
  set(id: ModelId, state: ModelState) {
    mock.states[id] = state;
    mock.notify(id);
  },
  states: freshStates(),
};

function mockPercent(id: ModelId): number {
  const state = mock.states[id];
  return "percent" in state ? state.percent : 0;
}

function mockListener(listener: Listener) {
  return Effect.acquireRelease(
    Effect.sync(() => mock.listeners.add(listener)),
    () => Effect.sync(() => mock.listeners.delete(listener))
  );
}

/** Stops the download of `id`: interrupted, and it never writes again. */
function stopMockDownload(id: ModelId) {
  return Effect.suspend(() => {
    mock.begin(id);
    const fiber = mock.downloads.get(id);
    mock.downloads.delete(id);
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  });
}

/**
 * Ticks from `from` to 100 %, checks the sum, then the model is ready.
 * Stops as soon as it no longer owns the model (`run`).
 */
function mockDownload(
  id: ModelId,
  from: number,
  run: number
): Effect.Effect<void> {
  return Effect.gen(function* () {
    let percent = from;
    while (percent < FULL) {
      yield* Effect.sleep(MOCK_SPEECH_DELAY_MS.downloadTick);
      percent = Math.min(FULL, percent + MOCK_DOWNLOAD_STEP);
      const state = percent < FULL ? downloading(percent) : CHECKING;
      if (!mock.progress(run, id, state)) {
        return;
      }
    }
    yield* Effect.sleep(MOCK_SPEECH_DELAY_MS.checksum);
    if (mock.progress(run, id, { status: "ready" })) {
      mock.downloads.delete(id);
    }
  });
}

/*
 * The mock models outside the contract: the dev navigator opens a speech
 * step in a given state, the tests start from a clean computer.
 */
export const mockSpeechModels = {
  /**
   * Puts a model in `state`. A downloading or checking one goes on by
   * itself, as after a click on "Скачать".
   */
  force(id: ModelId, state: ModelState) {
    Effect.runSync(stopMockDownload(id));
    mock.set(id, state);
    const run = mock.begin(id);
    if (state.status === "downloading") {
      mock.downloads.set(
        id,
        Effect.runFork(mockDownload(id, state.percent, run))
      );
    } else if (state.status === "checking") {
      mock.downloads.set(id, Effect.runFork(mockDownload(id, FULL, run)));
    } else if (state.status === "noNetwork") {
      // The connection comes back by the time the retry comes.
      const retry = Effect.sleep(state.retryInSec * MS_PER_SECOND).pipe(
        Effect.andThen(
          Effect.sync(() => mock.progress(run, id, downloading(state.percent)))
        ),
        Effect.andThen(mockDownload(id, state.percent, run))
      );
      mock.downloads.set(id, Effect.runFork(retry));
    }
  },

  /** Both models not downloaded, turbo selected. */
  reset() {
    for (const id of mock.downloads.keys()) {
      Effect.runFork(stopMockDownload(id));
    }
    mock.begin("turbo");
    mock.begin("small");
    mock.downloads.clear();
    mock.states = freshStates();
    mock.selected = "turbo";
  },
};
