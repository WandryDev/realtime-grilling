"use client";

import { useEffect, useState } from "react";

import {
  type CaptureProblem,
  listenToAudioLevel,
  listenToMicCheck,
  listenToWindowFocus,
} from "./api";
import type { AudioLevelFrame, AudioSource } from "./backend";

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

/** Below this the meter counts as silent. */
export const SILENT_LEVEL = 0.02;
/** Silence while something plays this long means no access, ms. */
export const SILENT_WHILE_PLAYING_MS = 4000;

/** Since when the system sound has been silent while something plays. */
export interface SilenceWatch {
  since: number | null;
  /** Long enough to suspect the access is missing. */
  suspicious: boolean;
}

export const NO_SILENCE: SilenceWatch = { since: null, suspicious: false };

/*
 * macOS gives silence instead of an error when the system audio access is
 * missing. Zeros while another app plays (`playing`) for a few seconds are
 * the sign; any sound or the end of playback resets the watch.
 */
export function watchSilence(
  watch: SilenceWatch,
  frame: AudioLevelFrame,
  now: number
): SilenceWatch {
  if (frame.playing !== true || frame.level > SILENT_LEVEL) {
    return NO_SILENCE;
  }
  const since = watch.since ?? now;
  return { since, suspicious: now - since >= SILENT_WHILE_PLAYING_MS };
}

export interface AudioLevelCheck {
  bars: MeterLevels;
  /** The source can't be opened. */
  problem: CaptureProblem | null;
  /** Silent while another app plays, see `watchSilence`. */
  silentWhilePlaying: boolean;
}

const IDLE_CHECK: AudioLevelCheck = {
  bars: SILENCE,
  problem: null,
  silentWhilePlaying: false,
};

/**
 * The live level of `source` while `enabled`: meter bars and problems.
 * The app stops listening when the window hides and on a failure; the
 * window getting the focus back starts it again (a plugged-in microphone,
 * a freed device). A problem stays on screen until a frame arrives.
 */
export function useAudioLevelCheck(
  source: AudioSource,
  enabled: boolean
): AudioLevelCheck {
  const [check, setCheck] = useState<AudioLevelCheck>(IDLE_CHECK);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let watch = NO_SILENCE;
    let stopped = false;
    let unsubscribe: () => void = () => undefined;
    const subscribe = () => {
      stopped = false;
      unsubscribe = listenToAudioLevel(source, {
        onEnd: () => {
          stopped = true;
          setCheck(IDLE_CHECK);
        },
        onFrame: (frame) => {
          watch = watchSilence(watch, frame, Date.now());
          setCheck({
            bars: levelToBars(frame.level),
            problem: null,
            silentWhilePlaying: watch.suspicious,
          });
        },
        onProblem: (problem) => {
          stopped = true;
          setCheck({ ...IDLE_CHECK, problem });
        },
      });
    };
    subscribe();
    const stopFocus = listenToWindowFocus(() => {
      if (stopped) {
        subscribe();
      }
    });
    return () => {
      stopFocus();
      unsubscribe();
      setCheck(IDLE_CHECK);
    };
  }, [enabled, source]);

  return check;
}

/** Calls `onFocus` when this window gets the focus back (Tauri only). */
export function useWindowFocus(onFocus: () => void) {
  useEffect(() => listenToWindowFocus(onFocus), [onFocus]);
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
