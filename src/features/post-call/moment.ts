import {
  CALL_QUESTIONS,
  type TranscriptSection,
  type TranscriptTurnData,
} from "./mock";

/*
 * A moment of the transcript: what `?moment=` of the transcript route points
 * at. Links pass a question id (the right column), a turn id (a search
 * result) or a time code ("12:04" from the summary, "12:02:14" from a task
 * card quote; the nearest phrase at or before it).
 */

export interface TranscriptMoment {
  /** Caption over the highlighted phrases. */
  label: string;
  /** Player position at the moment, "29:12". */
  position?: string;
  /** The question of the right column, when the moment is one. */
  questionId?: string;
  turnIds: string[];
}

/** The recording starts at 12:01:00. */
const CALL_START_SECONDS = 12 * 3600 + 60;
const SECONDS_IN_MINUTE = 60;
const TIME_CODE = /^\d{1,2}:\d{2}(?::\d{2})?$/u;

function clockSeconds(time: string) {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return hours * 3600 + minutes * SECONDS_IN_MINUTE + seconds;
}

/** Player position of a phrase said at `time`. */
export function positionOf(time: string) {
  const offset = Math.max(clockSeconds(time) - CALL_START_SECONDS, 0);
  const minutes = Math.floor(offset / SECONDS_IN_MINUTE);
  const seconds = offset % SECONDS_IN_MINUTE;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function allTurns(sections: TranscriptSection[]) {
  return sections.flatMap((section) => section.turns);
}

/** The phrase and the answer right after it. */
function turnWithReply(turns: TranscriptTurnData[], turnId: string) {
  const index = turns.findIndex((turn) => turn.id === turnId);
  if (index === -1) {
    return [];
  }
  return turns.slice(index, index + 2).map((turn) => turn.id);
}

function fromQuestion(
  turns: TranscriptTurnData[],
  question: (typeof CALL_QUESTIONS)[number]
): TranscriptMoment {
  const turnIds = question.momentTurnId
    ? turnWithReply(turns, question.momentTurnId)
    : [];
  return {
    label: `Здесь спросили «${question.text}»`,
    position: turnIds.length > 0 ? question.position : undefined,
    questionId: question.id,
    turnIds,
  };
}

export function resolveMoment(
  sections: TranscriptSection[],
  value: string | null | undefined
): TranscriptMoment | undefined {
  if (!value) {
    return;
  }
  const turns = allTurns(sections);

  const question = CALL_QUESTIONS.find((item) => item.id === value);
  if (question) {
    return fromQuestion(turns, question);
  }

  const turn = turns.find((item) => item.id === value);
  if (turn) {
    return {
      label: `Найдено в расшифровке, ${turn.time.slice(0, 5)}`,
      position: positionOf(turn.time),
      turnIds: [turn.id],
    };
  }

  if (!TIME_CODE.test(value)) {
    return;
  }
  const asked = CALL_QUESTIONS.find(
    (item) => item.time === value && item.momentTurnId
  );
  if (asked) {
    return fromQuestion(turns, asked);
  }
  // "12:11" means anywhere in that minute
  const target = clockSeconds(
    value.split(":").length === 2 ? `${value}:59` : value
  );
  const before = turns.filter((item) => clockSeconds(item.time) <= target);
  const nearest = before.at(-1) ?? turns[0];
  if (!nearest) {
    return;
  }
  return {
    label: `Момент ${value.slice(0, 5)}`,
    position: positionOf(nearest.time),
    turnIds: turnWithReply(turns, nearest.id),
  };
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
