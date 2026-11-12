import type {
  AgentStatus,
  CallState,
  CallStateView,
  Evidence,
  Question,
  Topic,
} from "@/bindings";

/*
 * Builders of the backend's call state (`call_state_get`) for the adapter
 * and the Tauri-mode tests of the call window and the overlay.
 */

export const STATE_RECORDING = "019a0000-0000-7000-8000-0000000000aa";

/** 12:00 local time on the day of the tests. */
export const NOON = new Date(2026, 10, 4, 12, 0).getTime();

/** `minutes` after noon, ms since the epoch. */
export function at(minutes: number) {
  return NOON + minutes * 60_000;
}

export function topic(id: string, title: string, position: number): Topic {
  return {
    callId: null,
    createdAt: at(position * 10),
    id,
    position,
    recordingId: STATE_RECORDING,
    title,
    updatedAt: at(position * 10),
  };
}

export function segmentEvidence(id: string, quote: string): Evidence {
  return { id, quote, source: "segment" };
}

export function question(
  id: string,
  text: string,
  fields: Partial<Question> = {}
): Question {
  return {
    answerEvidence: null,
    callId: null,
    cardField: "goal",
    cardId: null,
    createdAt: at(1),
    description: `Почему: ${text}`,
    evidence: [],
    gapType: "empty",
    id,
    pinned: false,
    priority: 2,
    rank: null,
    recordingId: STATE_RECORDING,
    shownAt: null,
    status: "open",
    text,
    topicId: null,
    updatedAt: at(1),
    visible: false,
    ...fields,
  };
}

/** A visible open question of the current topic at `rank`. */
export function visible(
  id: string,
  text: string,
  topicId: string,
  rank: number,
  fields: Partial<Question> = {}
): Question {
  return question(id, text, {
    rank,
    shownAt: at(2),
    topicId,
    visible: true,
    ...fields,
  });
}

export function callState(fields: Partial<CallState> = {}): CallState {
  return {
    cards: [],
    contextSearch: null,
    contextSources: { clickup: 0, files: 0, outline: 0 },
    currentTopicId: null,
    finalCheck: null,
    findings: [],
    questions: [],
    recordingId: STATE_RECORDING,
    topics: [],
    ...fields,
  };
}

export const IDLE_AGENT: AgentStatus = {
  recordingId: STATE_RECORDING,
  state: { kind: "idle" },
  utilization: null,
};

export function view(
  fields: Partial<CallState> = {},
  agent: AgentStatus = IDLE_AGENT
): CallStateView {
  return { ...callState(fields), agent };
}
