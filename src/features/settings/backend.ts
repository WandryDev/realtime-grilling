import { Context, Effect, Layer, Random, Schema, Stream } from "effect";

/*
 * Backend contract of every Settings operation that needs the system or the
 * network. Long operations are streams of progress, 0 to 100, that complete
 * when the work is done. `layerMock` fakes them with timers; the Tauri
 * layer will call the Rust commands.
 */

/** The agent CLI isn't at the path or isn't signed in. */
export class AgentCheckError extends Schema.TaggedError<AgentCheckError>()(
  "AgentCheckError",
  { message: Schema.String }
) {}

export type AudioChannel = "microphone" | "system";

export interface SoundCheckResult {
  client: string;
  you: string;
}

export interface ExportOptions {
  folder: string;
  includeAudio: boolean;
}

const PROGRESS_STEP_MS = 100;
const LEVEL_TICK_MS = 160;

/** Ticks up to 100 over `durationMs`. */
function simulateProgress(durationMs: number): Stream.Stream<number> {
  const steps = Math.max(1, Math.round(durationMs / PROGRESS_STEP_MS));
  return Stream.range(1, steps).pipe(
    Stream.mapEffect((step) =>
      Effect.as(
        Effect.sleep(PROGRESS_STEP_MS),
        Math.round((step / steps) * 100)
      )
    )
  );
}

export class SettingsBackend extends Context.Service<
  SettingsBackend,
  {
    /** Opens the folder in Finder. */
    readonly revealInFinder: (path: string) => Effect.Effect<void>;
    /** Moves the saved calls to `path`. */
    readonly moveRecordings: (path: string) => Stream.Stream<number>;
    /** Live input level of a channel, 0–100. Endless. */
    readonly inputLevel: (channel: AudioChannel) => Stream.Stream<number>;
    /** Records both channels for a moment; what was recognized. */
    readonly soundCheck: Effect.Effect<SoundCheckResult>;
    /** Looks for the CLI at `path` and checks that it is signed in. */
    readonly checkAgent: (path: string) => Effect.Effect<void, AgentCheckError>;
    /** Signs the CLI in (the browser opens). */
    readonly signInAgent: Effect.Effect<void>;
    /** Writes all projects to Markdown, audio when asked. */
    readonly exportData: (options: ExportOptions) => Stream.Stream<number>;
    /** Deletes calls, audio, projects and people from the computer. */
    readonly deleteAllData: Effect.Effect<void>;
    /** Opens a page in the browser. */
    readonly openExternal: (url: string) => Effect.Effect<void>;
  }
>()("grill/features/settings/SettingsBackend") {
  /*
   * Speech-like noise on the microphone, near silence on the system audio.
   * The agent is found when the path ends with `claude`. The services
   * connect through the `Connectors` data service.
   */
  static readonly layerMock = Layer.succeed(SettingsBackend, {
    checkAgent: Effect.fn("SettingsBackend.checkAgent")(function* (
      path: string
    ) {
      yield* Effect.sleep("1200 millis");
      if (!path.trim().endsWith("claude")) {
        return yield* new AgentCheckError({
          message: `По пути ${path} нет Claude Code`,
        });
      }
    }),
    deleteAllData: Effect.sleep("1500 millis"),
    exportData: (_options: ExportOptions) => simulateProgress(2000),
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
    moveRecordings: (_path: string) => simulateProgress(2000),
    openExternal: (_url: string) => Effect.void,
    revealInFinder: (_path: string) => Effect.void,
    signInAgent: Effect.sleep("1500 millis"),
    soundCheck: Effect.as(Effect.sleep("2500 millis"), {
      client: "тишина, системный звук не слышно",
      you: "«Раз, два, проверка. Меня хорошо слышно?»",
    }),
  });
}
