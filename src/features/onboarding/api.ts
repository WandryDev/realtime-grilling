"use client";

/*
 * MOCK native capabilities of the onboarding steps that aren't state: the
 * live input level, the live mic-check transcript and the clipboard. In the
 * app these become Tauri events (audio levels from the capture thread,
 * partial results from the speech model) and the clipboard plugin.
 *
 * Every listener returns its unsubscribe function, call it on unmount.
 */

export type AudioSource = "microphone" | "system";

const LEVEL_INTERVAL = 120;
const WORD_INTERVAL = 280;
/** How far the fake level can move between two frames, 0–1. */
const LEVEL_JITTER = 0.35;

/** Streams the input level (0–1) of the microphone or the system sound. */
export function listenToAudioLevel(
  _source: AudioSource,
  onLevel: (level: number) => void
): () => void {
  let level = 0.4;
  const timer = setInterval(() => {
    level = Math.min(
      1,
      Math.max(0.05, level + (Math.random() - 0.5) * LEVEL_JITTER * 2)
    );
    onLevel(level);
  }, LEVEL_INTERVAL);
  return () => clearInterval(timer);
}

/*
 * Streams what the speech model hears during the mic check, word by word.
 * The mock "hears" `phrase` and stops at its end.
 */
export function listenToMicCheck(
  phrase: string,
  onText: (text: string) => void
): () => void {
  const words = phrase.split(" ");
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    onText(words.slice(0, count).join(" "));
    if (count >= words.length) {
      clearInterval(timer);
    }
  }, WORD_INTERVAL);
  return () => clearInterval(timer);
}

/** Copies text for the support chat. Resolves to whether it worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
