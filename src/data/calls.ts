"use client";

import {
  type HistoryCall,
  PROJECT_HISTORY,
  PROPOSAL_GROUPS,
} from "@/features/post-call/mock";

import { CURRENT_CALL_ID } from "./call-session";
import { createStore } from "./store";

/*
 * Finished calls: the history list and everything the user decides after a
 * call (proposals, task cards, the recording). Every finished call shows the
 * demo content of the Телемедиа call of 19 October; what differs per call is
 * the history row and the decisions stored here.
 *
 * Backend: the list and the decisions become Tauri commands over the local
 * database; the hooks keep their signatures.
 */

export type SummaryStatus = "processing" | "ready";

export type ProposalDecision = "pending" | "accepted" | "rejected";

export interface ProposalReview {
  decision: ProposalDecision;
  /** The user's version, set by "Сохранить и принять". */
  text?: string;
}

export type TaskCardDecision = "pending" | "accepted" | "discarded";

export type TaskSyncService = "clickup" | "github";

export interface TaskSync {
  /** Task or issue id once sent: "CU-612", "#48". */
  ref?: string;
  status: "sending" | "sent";
}

export interface TaskCardReview {
  decision: TaskCardDecision;
  sync: Partial<Record<TaskSyncService, TaskSync>>;
  /** Title edited by the user. */
  title?: string;
}

/** Where the summary build is: the step index and its percent. */
export interface SummaryProgress {
  progress: number;
  step: number;
}

export interface CallRecord {
  /** The recording was deleted; transcript and summary stay. */
  audioDeleted: boolean;
  /** "19 окт" */
  date: string;
  /** "19 октября, 12:01" */
  dateLabel: string;
  /** "19 октября" */
  day: string;
  duration: string;
  id: string;
  /** Month heading of the history, "Октябрь". */
  month: string;
  openCount: number;
  participants: string;
  projectId: string;
  proposals: Record<string, ProposalReview>;
  summary: SummaryStatus;
  summaryProgress?: SummaryProgress;
  tasks: Record<string, TaskCardReview>;
  time: string;
  title: string;
}

const MONTHS: Record<string, string> = {
  окт: "октября",
  сен: "сентября",
};

function dayOf(date: string) {
  const [day = "", month = ""] = date.split(" ");
  return `${day} ${MONTHS[month] ?? month}`;
}

/** Ids of the history mock that stand for the call the demo records. */
const ALIASES: Record<string, string> = {
  "oct-19": CURRENT_CALL_ID,
  today: CURRENT_CALL_ID,
};

/**
 * The current call starts with the proposals of the Paper review; older
 * calls were reviewed already, so their pending proposals are accepted.
 */
function initialProposals(reviewed: boolean) {
  const proposals: Record<string, ProposalReview> = {};
  for (const group of PROPOSAL_GROUPS) {
    for (const proposal of group.proposals) {
      let decision: ProposalDecision = "pending";
      if (proposal.state === "accepted" || proposal.state === "rejected") {
        decision = proposal.state;
      } else if (reviewed) {
        decision = "accepted";
      }
      proposals[proposal.id] = { decision };
    }
  }
  return proposals;
}

function toRecord(
  call: HistoryCall,
  projectId: string,
  month: string
): CallRecord {
  const id = ALIASES[call.id] ?? call.id;
  const day = dayOf(call.date);
  return {
    audioDeleted: call.participants.includes("аудио удалено"),
    date: call.date,
    dateLabel: `${day}, ${call.time}`,
    day,
    duration: call.duration,
    id,
    month,
    openCount: call.openCount,
    participants: call.participants.replace(", аудио удалено", ""),
    projectId,
    proposals: initialProposals(id !== CURRENT_CALL_ID),
    summary: "ready",
    tasks: {},
    time: call.time,
    title: call.title,
  };
}

/* The call found by search in "Ветклиника Лапа" gets a history row too. */
const LAPA_CALLS: HistoryCall[] = [
  {
    date: "8 окт",
    duration: "27:15",
    id: "oct-8",
    openCount: 0,
    participants: "Марина Котова",
    time: "12:10",
    title: "Онлайн-запись и напоминания",
  },
];

function initialCalls(): CallRecord[] {
  const calls: CallRecord[] = [];
  for (const [projectId, months] of Object.entries(PROJECT_HISTORY)) {
    for (const month of months) {
      for (const call of month.calls) {
        calls.push(toRecord(call, projectId, month.month));
      }
    }
  }
  for (const call of LAPA_CALLS) {
    calls.push(toRecord(call, "lapa", "Октябрь"));
  }
  return calls;
}

const callsStore = createStore<CallRecord[]>(initialCalls());

/** Canonical id of a call, resolving the ids other screens use. */
export function resolveCallId(id: string | null | undefined) {
  if (!id) {
    return;
  }
  return ALIASES[id] ?? id;
}

export function useCalls() {
  return callsStore.use();
}

export function useCall(id: string | null | undefined) {
  const calls = callsStore.use();
  const callId = resolveCallId(id);
  return calls.find((call) => call.id === callId);
}

export function getCall(id: string | null | undefined) {
  const callId = resolveCallId(id);
  return callsStore.get().find((call) => call.id === callId);
}

function updateCall(id: string, update: (call: CallRecord) => CallRecord) {
  callsStore.set((calls) =>
    calls.map((call) => (call.id === id ? update(call) : call))
  );
}

/** Summary build of a just-finished call; `undefined` progress = ready. */
export function setSummaryProgress(
  id: string,
  progress: SummaryProgress | undefined,
  patch?: Partial<Pick<CallRecord, "participants" | "projectId">>
) {
  updateCall(id, (call) => ({
    ...call,
    ...patch,
    summary: progress ? "processing" : "ready",
    summaryProgress: progress,
  }));
}

export function setProposalDecision(
  id: string,
  proposalId: string,
  review: ProposalReview
) {
  updateCall(id, (call) => ({
    ...call,
    proposals: { ...call.proposals, [proposalId]: review },
  }));
}

const NEW_TASK_CARD: TaskCardReview = { decision: "pending", sync: {} };

export function getTaskCardReview(call: CallRecord, cardId: string) {
  return call.tasks[cardId] ?? NEW_TASK_CARD;
}

export function updateTaskCard(
  id: string,
  cardId: string,
  update: (review: TaskCardReview) => TaskCardReview
) {
  updateCall(id, (call) => ({
    ...call,
    tasks: {
      ...call.tasks,
      [cardId]: update(getTaskCardReview(call, cardId)),
    },
  }));
}

export function deleteRecording(id: string) {
  updateCall(id, (call) => ({ ...call, audioDeleted: true }));
}

/** Proposals still waiting for a decision. */
export function countPendingProposals(call: CallRecord) {
  return Object.values(call.proposals).filter(
    (review) => review.decision === "pending"
  ).length;
}

/** Back to the demo history (tests, the dev navigator). */
export function resetCalls() {
  callsStore.set(initialCalls());
}
