import type {
  TranscriptChannel,
  TranscriptEvent,
  TranscriptSegment,
} from "@/features/speech/backend";

import type { CallFeedEvent, TranscriptItem } from "./types";

/*
 * The recognizer's events of a recording as the call window's feed
 * (speech-recognition design.md, decision 17). One phrase is one item: its
 * id is the recording, the channel and the start, so "расшифровываю", its
 * text, its drop or its skip all address the same item. "Я" is "Вы",
 * "Остальные" is "Клиент".
 */

/** The item id of the phrase of `channel` starting at `startMs`. */
export function phraseItemId(
  recordingId: string,
  channel: TranscriptChannel,
  startMs: number
) {
  return `${recordingId}:${channel}:${startMs}`;
}

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** "0:12" */
function duration(ms: number) {
  const total = Math.max(0, Math.round(ms / MS_PER_SECOND));
  const seconds = total % SECONDS_PER_MINUTE;
  return `${Math.floor(total / SECONDS_PER_MINUTE)}:${seconds.toString().padStart(2, "0")}`;
}

function phraseItem(
  recordingId: string,
  phrase: Pick<TranscriptSegment, "channel" | "startMs" | "text">
): TranscriptItem {
  const id = phraseItemId(recordingId, phrase.channel, phrase.startMs);
  return phrase.channel === "me"
    ? { id, kind: "me", text: phrase.text }
    : { id, kind: "client", text: phrase.text };
}

/** What `event` of the recording `recordingId` changes in the feed. */
export function transcriptFeedEvents(
  recordingId: string,
  event: TranscriptEvent
): CallFeedEvent[] {
  switch (event.type) {
    case "stored":
      return event.segments.map((segment) => ({
        item: phraseItem(recordingId, segment),
        type: "transcript",
      }));
    case "pending": {
      const id = phraseItemId(recordingId, event.channel, event.startMs);
      return [
        {
          item:
            event.channel === "me"
              ? { id, kind: "me", live: "transcribing", text: "" }
              : { id, kind: "client", live: "transcribing", text: "" },
          type: "transcript-pending",
        },
      ];
    }
    case "phrase":
      return [{ item: phraseItem(recordingId, event), type: "transcript" }];
    case "dropped":
      return [
        {
          id: phraseItemId(recordingId, event.channel, event.startMs),
          type: "transcript-remove",
        },
      ];
    case "skipped":
      return [
        {
          item: {
            duration: duration(event.endMs - event.startMs),
            id: phraseItemId(recordingId, event.channel, event.startMs),
            kind: "missing",
            label:
              event.channel === "me"
                ? "Ваша фраза пропущена, расшифрую после звонка"
                : "Пропущено, расшифрую после звонка",
          },
          type: "transcript",
        },
      ];
    default:
      return [{ seconds: event.seconds, type: "transcript-lag" }];
  }
}
