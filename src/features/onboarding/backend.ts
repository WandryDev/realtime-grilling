import { Context, Effect, Layer, Random, Schema, Stream } from "effect";

/*
 * Backend contract of the onboarding steps: the live input level, what the
 * speech model hears during the mic check, and the clipboard. `layerMock`
 * fakes the audio with timers; the Tauri layer will read audio levels from
 * the capture thread, partial results from the speech model and use the
 * clipboard plugin.
 */

export type AudioSource = "microphone" | "system";

export class ClipboardError extends Schema.TaggedError<ClipboardError>()(
  "ClipboardError",
  { message: Schema.String }
) {}

export const LEVEL_INTERVAL_MS = 120;
export const WORD_INTERVAL_MS = 280;
const START_LEVEL = 0.4;
const MIN_LEVEL = 0.05;
/** How far the fake level can move between two frames, 0–1. */
const LEVEL_JITTER = 0.35;

export class OnboardingBackend extends Context.Service<
  OnboardingBackend,
  {
    /** The input level (0–1) of the microphone or the system sound. */
    readonly audioLevel: (source: AudioSource) => Stream.Stream<number>;
    /**
     * What the speech model hears during the mic check, growing word by
     * word. The mock "hears" `phrase` and ends with it.
     */
    readonly micCheck: (phrase: string) => Stream.Stream<string>;
    /** Copies text for the support chat. */
    readonly copyText: (text: string) => Effect.Effect<void, ClipboardError>;
  }
>()("grill/features/onboarding/OnboardingBackend") {
  static readonly layerMock = Layer.succeed(OnboardingBackend, {
    audioLevel: (_source: AudioSource) =>
      Stream.unfold(START_LEVEL, (level) =>
        Effect.gen(function* () {
          yield* Effect.sleep(LEVEL_INTERVAL_MS);
          const jitter = ((yield* Random.next) - 0.5) * LEVEL_JITTER * 2;
          const next = Math.min(1, Math.max(MIN_LEVEL, level + jitter));
          return [next, next] as const;
        })
      ),
    copyText: (text: string) =>
      Effect.tryPromise({
        catch: () => new ClipboardError({ message: "Буфер обмена недоступен" }),
        try: () => navigator.clipboard.writeText(text),
      }),
    micCheck: (phrase: string) => {
      const words = phrase.split(" ");
      return Stream.range(1, words.length).pipe(
        Stream.mapEffect((count) =>
          Effect.as(
            Effect.sleep(WORD_INTERVAL_MS),
            words.slice(0, count).join(" ")
          )
        )
      );
    },
  });
}
