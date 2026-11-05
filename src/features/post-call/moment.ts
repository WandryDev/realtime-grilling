import type {
  CallQuestion,
  CallRecording,
  SummaryTopic,
  TranscriptChannel,
} from "@/bindings";
import { clockTime, pad2 } from "@/lib/clock";

import type {
  CallQuestion as QuestionItem,
  TranscriptSection,
  TranscriptTurnData,
} from "./mock";

/*
 * The transcript of a call as the details page shows it, and its moments
 * (post-call design.md, decision 11; `call-details` «Момент звонка»).
 *
 * The recordings of the call follow each other in the order they started.
 * Adjacent phrases of one channel of a recording make a turn of «Вы» or
 * «Клиент»; a turn's time is the wall clock, `recording.startedAt +
 * startMs`. With a summary the turns go into its topics, each starting at
 * the topic's first phrase; without one, into the recordings («Часть 1»).
 *
 * `?moment=` of `/calls/transcript` names what to open:
 * - `<recordingId>@<startMs>[@<segmentId>]` (`momentParam`): a phrase of a
 *   recording. Links from the summary points, the card facts and the
 *   search results build it from their `CallEvidence` / `CallMoment`. The
 *   segment is found by its id when the shown pass has it, otherwise the
 *   phrase of that recording at `startMs` (an evidence of the live pass
 *   after the second pass replaced it);
 * - a question id: its answer once answered, otherwise the phrase it rests
 *   on;
 * - a segment id of the shown pass;
 * - a wall-clock time code, «12:04» (anywhere in that minute) or
 *   «12:02:14»: the last phrase said by then.
 *
 * The transcript scrolls to the moment, highlights its turns and the
 * player stands at `at`.
 */

export interface TranscriptMoment {
  /** Where the player stands: the recording and the offset in it. */
  at?: { recordingId: string; startMs: number };
  /** Caption over the highlighted phrases. */
  label: string;
  /** Player position at the moment, "29:12". */
  position?: string;
  /** The question of the right column, when the moment is one. */
  questionId?: string;
  turnIds: string[];
}

/** A turn with where it is in the call. */
export interface CallTurn extends TranscriptTurnData {
  recordingId: string;
  /** The segments it joins, in time order. */
  segmentIds: string[];
  /** Offset of its first phrase from the start of the recording. */
  startMs: number;
}

export interface CallTranscript {
  sections: TranscriptSection[];
  /** Every turn in the order of the call. */
  turns: CallTurn[];
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
const LAST_SECOND = 59;
const TIME_CODE = /^\d{1,2}:\d{2}(?::\d{2})?$/u;
const SEPARATOR = "@";

/** «29:12», or «1:05:09» past an hour: a player position. */
export function playerClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND));
  const seconds = total % SECONDS_PER_MINUTE;
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

/** The `?moment=` of a phrase of a recording (see above). */
export function momentParam(moment: {
  recordingId: string;
  segmentId?: string | null;
  startMs: number;
}) {
  const at = `${moment.recordingId}${SEPARATOR}${Math.round(moment.startMs)}`;
  return moment.segmentId ? `${at}${SEPARATOR}${moment.segmentId}` : at;
}

const SPEAKER: Record<TranscriptChannel, TranscriptTurnData["speaker"]> = {
  me: "you",
  others: "client",
};

interface Section {
  /** Recording order, then offset: where the section starts. */
  index: number;
  startMs: number;
  topic: TranscriptSection["topic"];
  turns: CallTurn[];
}

/** Topics of the summary in the order of the call. */
function topicSections(
  recordings: CallRecording[],
  topics: SummaryTopic[]
): Section[] {
  const order = new Map(recordings.map((item, index) => [item.id, index]));
  return topics
    .flatMap((topic) => {
      const index = order.get(topic.from.recordingId);
      const recording = recordings[index ?? -1];
      if (index === undefined || !recording) {
        return [];
      }
      const time = clockTime(recording.startedAt + topic.from.startMs);
      return [
        {
          index,
          startMs: topic.from.startMs,
          topic: { id: topic.id, time: time.slice(0, 5), title: topic.title },
          turns: [],
        },
      ];
    })
    .sort((a, b) => a.index - b.index || a.startMs - b.startMs);
}

/** One section per recording: «Часть 1», «Часть 2», or one «Расшифровка». */
function partSections(recordings: CallRecording[]): Section[] {
  return recordings.map((recording, index) => ({
    index,
    startMs: 0,
    topic: {
      id: `part-${recording.id}`,
      time: clockTime(recording.startedAt, false),
      title: recordings.length > 1 ? `Часть ${index + 1}` : "Расшифровка",
    },
    turns: [],
  }));
}

/**
 * The turns of the recordings (in the order they started) in sections:
 * the summary's topics when it has any, the recordings otherwise.
 */
export function buildTranscript(
  recordings: CallRecording[],
  topics: SummaryTopic[] = []
): CallTranscript {
  const fromTopics = topicSections(recordings, topics);
  const sections =
    fromTopics.length > 0 ? fromTopics : partSections(recordings);
  const turns: CallTurn[] = [];
  let section = 0;

  recordings.forEach((recording, index) => {
    let last: CallTurn | undefined;
    const segments = [...recording.segments].sort(
      (a, b) => a.startMs - b.startMs
    );
    for (const segment of segments) {
      // The last section that started by this phrase; the phrases before
      // the first topic stay with it.
      let next = section;
      while (
        next + 1 < sections.length &&
        ((sections[next + 1]?.index ?? 0) < index ||
          ((sections[next + 1]?.index ?? 0) === index &&
            (sections[next + 1]?.startMs ?? 0) <= segment.startMs))
      ) {
        next += 1;
      }
      if (next !== section) {
        section = next;
        last = undefined;
      }
      const speaker = SPEAKER[segment.channel];
      if (last && last.speaker === speaker) {
        last.text = `${last.text} ${segment.text}`;
        last.segmentIds.push(segment.id);
        continue;
      }
      last = {
        id: segment.id,
        recordingId: recording.id,
        segmentIds: [segment.id],
        speaker,
        startMs: segment.startMs,
        text: segment.text,
        time: clockTime(recording.startedAt + segment.startMs),
      };
      turns.push(last);
      sections[section]?.turns.push(last);
    }
  });

  return {
    sections: sections
      .filter((item) => item.turns.length > 0)
      .map(({ topic, turns: sectionTurns }) => ({
        topic,
        turns: sectionTurns,
      })),
    turns,
  };
}

/** The turn with this segment of the shown pass. */
function turnOfSegment(transcript: CallTranscript, segmentId: string) {
  return transcript.turns.find((turn) => turn.segmentIds.includes(segmentId));
}

/** The turn of `recordingId` said at `startMs`: the last one started by then. */
function turnAt(
  transcript: CallTranscript,
  recordingId: string,
  startMs: number
) {
  const own = transcript.turns.filter(
    (turn) => turn.recordingId === recordingId
  );
  return own.filter((turn) => turn.startMs <= startMs).at(-1) ?? own[0];
}

/** A turn and the one right after it: a question and its reply. */
function withReply(transcript: CallTranscript, turn: CallTurn) {
  const index = transcript.turns.indexOf(turn);
  return transcript.turns.slice(index, index + 2).map((item) => item.id);
}

/** An answer and the manager's question right before it. */
function withQuestion(transcript: CallTranscript, turn: CallTurn) {
  const index = transcript.turns.indexOf(turn);
  const before = transcript.turns[index - 1];
  return before?.speaker === "you" ? [before.id, turn.id] : [turn.id];
}

function standAt(recordingId: string, startMs: number) {
  return {
    at: { recordingId, startMs },
    position: playerClock(startMs),
  };
}

function fromQuestion(
  transcript: CallTranscript,
  question: CallQuestion
): TranscriptMoment {
  const label = question.answer
    ? `Ответ на «${question.text}»`
    : `Здесь спросили «${question.text}»`;
  const moment = question.answer ?? question.moment;
  if (!moment) {
    return { label, questionId: question.id, turnIds: [] };
  }
  const turn =
    turnOfSegment(transcript, moment.segmentId) ??
    turnAt(transcript, moment.recordingId, moment.startMs);
  if (!turn) {
    return { label, questionId: question.id, turnIds: [] };
  }
  return {
    ...standAt(moment.recordingId, moment.startMs),
    label,
    questionId: question.id,
    turnIds: question.answer
      ? withQuestion(transcript, turn)
      : withReply(transcript, turn),
  };
}

/** «12:11» means anywhere in that minute. */
function secondsOfDay(time: string) {
  const [hours = 0, minutes = 0, seconds = LAST_SECOND] = time
    .split(":")
    .map(Number);
  return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds;
}

function fromTimeCode(
  transcript: CallTranscript,
  value: string
): TranscriptMoment | undefined {
  const target = secondsOfDay(value);
  const nearest =
    transcript.turns
      .filter((turn) => secondsOfDay(turn.time) <= target)
      .at(-1) ?? transcript.turns[0];
  if (!nearest) {
    return;
  }
  return {
    ...standAt(nearest.recordingId, nearest.startMs),
    label: `Момент ${value.slice(0, 5)}`,
    turnIds: withReply(transcript, nearest),
  };
}

function fromParam(
  transcript: CallTranscript,
  value: string
): TranscriptMoment | undefined {
  const [recordingId = "", offset = "", segmentId] = value.split(SEPARATOR);
  const startMs = Number(offset);
  if (!(recordingId && Number.isFinite(startMs))) {
    return;
  }
  const turn =
    (segmentId ? turnOfSegment(transcript, segmentId) : undefined) ??
    turnAt(transcript, recordingId, startMs);
  if (!turn) {
    return;
  }
  return {
    ...standAt(turn.recordingId, startMs),
    label: `Момент ${turn.time.slice(0, 5)}`,
    turnIds: [turn.id],
  };
}

/** What `?moment=` (or a question of the right column) opens. */
export function resolveMoment(
  transcript: CallTranscript,
  questions: CallQuestion[],
  value: string | null | undefined
): TranscriptMoment | undefined {
  if (!value) {
    return;
  }
  const question = questions.find((item) => item.id === value);
  if (question) {
    return fromQuestion(transcript, question);
  }
  if (value.includes(SEPARATOR)) {
    return fromParam(transcript, value);
  }
  const turn = turnOfSegment(transcript, value);
  if (turn) {
    return {
      ...standAt(turn.recordingId, turn.startMs),
      label: `Момент ${turn.time.slice(0, 5)}`,
      turnIds: [turn.id],
    };
  }
  return TIME_CODE.test(value) ? fromTimeCode(transcript, value) : undefined;
}

/** Topic of the first highlighted phrase. */
export function topicOfMoment(
  sections: TranscriptSection[],
  moment: TranscriptMoment | undefined
) {
  const [first] = moment?.turnIds ?? [];
  return sections.find((section) =>
    section.turns.some((turn) => turn.id === first)
  )?.topic.id;
}

/**
 * The questions of the right column: answered, open (asked without an
 * answer, too) and assumptions; hidden ones are not shown. The time is
 * when the phrase it rests on (or its answer) was said.
 */
export function questionItems(
  recordings: CallRecording[],
  questions: CallQuestion[]
): QuestionItem[] {
  const started = new Map(recordings.map((item) => [item.id, item.startedAt]));
  return questions
    .filter((question) => question.status !== "hidden")
    .map((question) => {
      let status: QuestionItem["status"] = "open";
      if (question.status === "answered") {
        status = "answered";
      } else if (question.gapType === "assumption") {
        status = "assumption";
      }
      const moment = question.moment ?? question.answer;
      const start = moment ? started.get(moment.recordingId) : undefined;
      return {
        id: question.id,
        status,
        text: question.text,
        time:
          moment && start !== undefined
            ? clockTime(start + moment.startMs, false)
            : "",
      };
    });
}
