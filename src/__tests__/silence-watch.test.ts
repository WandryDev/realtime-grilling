import { describe, expect, it } from "vitest";

import type { AudioLevelFrame } from "@/features/onboarding/backend";
import {
  NO_SILENCE,
  SILENT_WHILE_PLAYING_MS,
  type SilenceWatch,
  watchSilence,
} from "@/features/onboarding/use-live-audio";

/** Feeds frames 1 s apart, returns whether each made the watch suspicious. */
function play(frames: AudioLevelFrame[]): boolean[] {
  let watch: SilenceWatch = NO_SILENCE;
  return frames.map((frame, index) => {
    watch = watchSilence(watch, frame, index * 1000);
    return watch.suspicious;
  });
}

const SILENT_PLAYING: AudioLevelFrame = { level: 0, playing: true };

describe("watchSilence", () => {
  it("suspects a missing access after seconds of silence while playing", () => {
    expect(SILENT_WHILE_PLAYING_MS).toBe(4000);
    expect(play(new Array(6).fill(SILENT_PLAYING))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  it("starts over on any sound or when nothing plays", () => {
    expect(
      play([
        SILENT_PLAYING,
        SILENT_PLAYING,
        SILENT_PLAYING,
        { level: 0.4, playing: true },
        SILENT_PLAYING,
        SILENT_PLAYING,
        { level: 0, playing: false },
        SILENT_PLAYING,
      ])
    ).toEqual([false, false, false, false, false, false, false, false]);
  });

  it("never suspects silence when Rust doesn't know what plays", () => {
    expect(play(new Array(8).fill({ level: 0, playing: null }))).not.toContain(
      true
    );
  });
});
