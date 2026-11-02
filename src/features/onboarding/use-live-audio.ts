"use client";

import { useEffect, useState } from "react";

import { listenToAudioLevel, listenToMicCheck } from "./api";
import type { AudioSource } from "./backend";

const BAR_COUNT = 10;
const REST_HEIGHT = 4;
const MIN_ACTIVE_HEIGHT = 6;
const PEAK_EXTRA = 14;
const RESTING_BARS: readonly number[] = new Array<number>(BAR_COUNT).fill(
  REST_HEIGHT
);

export interface MeterLevels {
  /** How many bars from the left are lit. */
  active: number;
  /** Bar heights, px. */
  levels: readonly number[];
}

/** Turns a 0–1 level into the bars of AudioLevelMeter. */
export function levelToBars(level: number): MeterLevels {
  const active = Math.round(level * BAR_COUNT);
  const levels = RESTING_BARS.map((rest, index) => {
    if (index >= active) {
      return rest;
    }
    // A soft hump over the lit bars, taller when louder
    const wave = 0.5 + 0.5 * Math.sin((index + 1) * 1.3);
    return MIN_ACTIVE_HEIGHT + Math.round(PEAK_EXTRA * level * wave);
  });
  return { active, levels };
}

const SILENCE: MeterLevels = { active: 0, levels: RESTING_BARS };

/** Live meter bars for `source` while `enabled`, resting bars otherwise. */
export function useAudioLevelBars(
  source: AudioSource,
  enabled: boolean
): MeterLevels {
  const [bars, setBars] = useState<MeterLevels>(SILENCE);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const unsubscribe = listenToAudioLevel(source, (level) =>
      setBars(levelToBars(level))
    );
    return () => {
      unsubscribe();
      setBars(SILENCE);
    };
  }, [enabled, source]);

  return bars;
}

/** The mic-check transcript growing word by word while `enabled`. */
export function useMicCheckTranscript(
  phrase: string,
  enabled: boolean
): string {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const unsubscribe = listenToMicCheck(phrase, setText);
    return () => {
      unsubscribe();
      setText("");
    };
  }, [enabled, phrase]);

  return text;
}
