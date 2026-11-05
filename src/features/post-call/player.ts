"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PlayerChannel, PlayerSpeed } from "./components/transcript";

/*
 * The player of a recording (post-call design.md, decision 9): the two
 * channel files play in two `<audio>` elements (WAV over `grill-audio`).
 * «Клиент» (the system sound, `others`) leads: its clock is the player's
 * position. «Вы» (`me`) follows it: it plays and pauses with it, takes its
 * speed and jumps to its time once they drift apart by more than 150 ms.
 * «Оба» plays both; «Только вы» and «Только клиент» mute the other one, so
 * the follower stays in time and switching back is instant.
 *
 * Without audio files (the browser, the tests) both channels are clocks
 * (`clockMedia`), so the demo player still plays.
 */

/** What the player uses of an `HTMLMediaElement`. */
export interface MediaLike {
  currentTime: number;
  readonly ended: boolean;
  muted: boolean;
  pause: () => void;
  readonly paused: boolean;
  play: () => Promise<void> | undefined;
  playbackRate: number;
}

/** The two channels of a recording: the lead plays «Клиент». */
export interface MediaPair {
  follower: MediaLike;
  lead: MediaLike;
}

/** How far the follower may drift from the lead before it jumps. */
export const MAX_DRIFT_S = 0.15;

export const SPEED_RATE: Record<PlayerSpeed, number> = {
  "1,5×": 1.5,
  "1×": 1,
  "2×": 2,
};

/** Mutes the channel the manager doesn't want to hear. */
export function applyChannel(pair: MediaPair, channel: PlayerChannel) {
  pair.lead.muted = channel === "you";
  pair.follower.muted = channel === "client";
}

/**
 * Keeps the follower with the lead: its speed, playing or paused, and its
 * time within `MAX_DRIFT_S`. `true` when it had to jump.
 */
export function syncFollower({ follower, lead }: MediaPair) {
  if (follower.playbackRate !== lead.playbackRate) {
    follower.playbackRate = lead.playbackRate;
  }
  if (lead.paused || lead.ended) {
    if (!follower.paused) {
      follower.pause();
    }
  } else if (follower.paused) {
    follower.play()?.catch(() => undefined);
  }
  if (Math.abs(follower.currentTime - lead.currentTime) > MAX_DRIFT_S) {
    follower.currentTime = lead.currentTime;
    return true;
  }
  return false;
}

/** Both channels to `seconds`. */
export function seekPair(pair: MediaPair, seconds: number) {
  pair.lead.currentTime = seconds;
  pair.follower.currentTime = seconds;
}

export function setPairRate(pair: MediaPair, rate: number) {
  pair.lead.playbackRate = rate;
  pair.follower.playbackRate = rate;
}

/** Starts both channels; rejects when the lead can't play. */
export async function playPair(pair: MediaPair) {
  syncFollower(pair);
  await Promise.all([pair.lead.play(), pair.follower.play()]);
}

export function pausePair(pair: MediaPair) {
  pair.lead.pause();
  pair.follower.pause();
}

/** A channel without a file: a clock that runs while it plays. */
export function clockMedia(durationS: number): MediaLike {
  let base = 0;
  let since: number | null = null;
  let rate = 1;
  const now = () => {
    if (since === null) {
      return base;
    }
    return Math.min(durationS, base + ((Date.now() - since) / 1000) * rate);
  };
  return {
    get currentTime() {
      return now();
    },
    set currentTime(seconds: number) {
      base = Math.min(Math.max(seconds, 0), durationS);
      since = since === null ? null : Date.now();
    },
    get ended() {
      return now() >= durationS;
    },
    muted: false,
    pause() {
      base = now();
      since = null;
    },
    get paused() {
      return since === null;
    },
    play() {
      if (since === null) {
        since = Date.now();
      }
      return Promise.resolve();
    },
    get playbackRate() {
      return rate;
    },
    set playbackRate(next: number) {
      base = now();
      since = since === null ? null : Date.now();
      rate = next;
    },
  };
}

/** How often the position on screen follows the lead while it plays. */
const TICK_MS = 200;

export interface PlayerOptions {
  /** The recording's length; the clocks end there. */
  durationMs: number;
  /** Whether the channels have files (`<audio>` elements) or are clocks. */
  hasAudio: boolean;
  /** Where the player stands before anything is played. */
  initialMs: number;
  /** The channels could not play. */
  onError?: () => void;
  /** The recording played; a new one starts from `initialMs` again. */
  recordingId: string | null;
}

/**
 * The player of the details page: play and pause, the position, seeking,
 * the speed and the channel. With audio, attach `leadRef` / `followerRef`
 * to the `<audio>` elements of «Клиент» and «Вы».
 */
export function usePlayer({
  durationMs,
  hasAudio,
  initialMs,
  onError,
  recordingId,
}: PlayerOptions) {
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(initialMs);
  const [speed, setSpeed] = useState<PlayerSpeed>("1×");
  const [channel, setChannel] = useState<PlayerChannel>("both");
  /** Where the channels go once they are there (a new recording). */
  const startMs = useRef(initialMs);
  const settings = useRef({ channel, speed });
  settings.current = { channel, speed };
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const clocks = useMemo((): MediaPair | null => {
    if (hasAudio || recordingId === null) {
      return null;
    }
    const pair = {
      follower: clockMedia(durationMs / 1000),
      lead: clockMedia(durationMs / 1000),
    };
    seekPair(pair, startMs.current / 1000);
    return pair;
  }, [durationMs, hasAudio, recordingId]);

  const elements = useRef<{
    follower: HTMLAudioElement | null;
    lead: HTMLAudioElement | null;
  }>({ follower: null, lead: null });

  const pair = useCallback((): MediaPair | null => {
    if (clocks) {
      return clocks;
    }
    const { follower, lead } = elements.current;
    return follower && lead ? { follower, lead } : null;
  }, [clocks]);

  /** A channel element as it mounts: at the position, speed and channel. */
  const attach = useCallback(
    (role: "follower" | "lead") => (element: HTMLAudioElement | null) => {
      elements.current[role] = element;
      if (!element) {
        return;
      }
      element.currentTime = startMs.current / 1000;
      element.playbackRate = SPEED_RATE[settings.current.speed];
      const { channel: heard } = settings.current;
      element.muted = role === "lead" ? heard === "you" : heard === "client";
    },
    []
  );
  const leadRef = useMemo(() => attach("lead"), [attach]);
  const followerRef = useMemo(() => attach("follower"), [attach]);

  const pause = useCallback(() => {
    const current = pair();
    if (current) {
      pausePair(current);
    }
    setPlaying(false);
  }, [pair]);

  const seek = useCallback(
    (ms: number) => {
      const clamped = Math.min(Math.max(ms, 0), durationMs);
      startMs.current = clamped;
      setPositionMs(clamped);
      const current = pair();
      if (current) {
        seekPair(current, clamped / 1000);
      }
    },
    [durationMs, pair]
  );

  const play = useCallback(() => {
    const current = pair();
    if (!current) {
      return;
    }
    if (current.lead.ended) {
      seekPair(current, 0);
    }
    applyChannel(current, settings.current.channel);
    setPairRate(current, SPEED_RATE[settings.current.speed]);
    setPlaying(true);
    playPair(current).catch(() => {
      pausePair(current);
      setPlaying(false);
      errorRef.current?.();
    });
  }, [pair]);

  const toggle = useCallback(() => {
    if (playing) {
      pause();
    } else {
      play();
    }
  }, [pause, play, playing]);

  // The position follows the lead; the follower is kept with it.
  useEffect(() => {
    if (!playing) {
      return;
    }
    const timer = setInterval(() => {
      const current = pair();
      if (!current) {
        return;
      }
      syncFollower(current);
      const ms = current.lead.currentTime * 1000;
      startMs.current = ms;
      setPositionMs(ms);
      if (current.lead.ended || ms >= durationMs) {
        pausePair(current);
        setPlaying(false);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [durationMs, pair, playing]);

  const changeSpeed = useCallback(
    (next: PlayerSpeed) => {
      setSpeed(next);
      const current = pair();
      if (current) {
        setPairRate(current, SPEED_RATE[next]);
      }
    },
    [pair]
  );

  const changeChannel = useCallback(
    (next: PlayerChannel) => {
      setChannel(next);
      const current = pair();
      if (current) {
        applyChannel(current, next);
      }
    },
    [pair]
  );

  return {
    changeChannel,
    changeSpeed,
    channel,
    followerRef,
    leadRef,
    pause,
    playing,
    positionMs,
    seek,
    speed,
    toggle,
  };
}
