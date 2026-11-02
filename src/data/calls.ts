"use client";

import { Effect, Option, Schema } from "effect";
import { useMemo } from "react";

import type { Call, Value } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";
import { diffPatch } from "@/lib/merge-patch";

import { CallsData } from "./services/calls";
import { MockDatabase } from "./services/mock-database";
import { mockSeed, seedCallId } from "./services/mock-seed";
import { PeopleData } from "./services/people";
import { createStore } from "./store";
import { createSyncedStore } from "./synced-store";

/*
 * Finished calls: the history list and everything the user decides after a
 * call (proposals, task cards, the recording). Every finished call shows the
 * demo content of the Телемедиа call of 19 October; what differs per call is
 * the history row and the decisions stored here.
 *
 * The decisions live in the call's `summary` JSON (its shape belongs to
 * the frontend for now); dates, duration and the open count come from the
 * record. The summary build's progress is local to the window.
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

/* ------------------------------------------------------------- Adapter */

const SHORT_MONTHS = [
  "янв",
  "фев",
  "мар",
  "апр",
  "мая",
  "июн",
  "июл",
  "авг",
  "сен",
  "окт",
  "ноя",
  "дек",
];
const GENITIVE_MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
const MONTH_HEADINGS = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "40:12", or "1:05:09" past an hour. */
function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / MS_PER_SECOND));
  const seconds = total % SECONDS_PER_MINUTE;
  const minutes = Math.floor(total / SECONDS_PER_MINUTE) % MINUTES_PER_HOUR;
  const hours = Math.floor(total / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
    : `${minutes}:${pad2(seconds)}`;
}

const Review = Schema.Struct({
  decision: Schema.Literals(["pending", "accepted", "rejected"]),
  text: Schema.optionalKey(Schema.String),
});
const Sync = Schema.Struct({
  ref: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["sending", "sent"]),
});
const TaskReview = Schema.Struct({
  decision: Schema.Literals(["pending", "accepted", "discarded"]),
  sync: Schema.Record(Schema.String, Sync),
  title: Schema.optionalKey(Schema.String),
});
/** The frontend's part of a call: `Call.summary`. */
const CallSummary = Schema.Struct({
  audioDeleted: Schema.optionalKey(Schema.Boolean),
  /** Names from the call session, for people the project doesn't have. */
  participants: Schema.optionalKey(Schema.String),
  proposals: Schema.optionalKey(Schema.Record(Schema.String, Review)),
  summary: Schema.optionalKey(Schema.Literals(["processing", "ready"])),
  tasks: Schema.optionalKey(Schema.Record(Schema.String, TaskReview)),
});
const decodeSummary = Schema.decodeUnknownOption(CallSummary);

type SummaryJson = typeof CallSummary.Type;

interface CallEntry {
  record: CallRecord;
  /** The stored `summary` as decoded: what summary patches are made from. */
  summary: SummaryJson;
}

/** A stored call as the screens draw it; `names` resolves participant ids. */
function toCallEntry(call: Call, names: Map<string, string>): CallEntry {
  const summary: SummaryJson = Option.getOrElse(
    decodeSummary(call.summary),
    () => ({})
  );
  const start = new Date(call.startedAt ?? call.createdAt);
  const month = start.getMonth();
  const day = `${start.getDate()} ${GENITIVE_MONTHS[month]}`;
  const time = `${pad2(start.getHours())}:${pad2(start.getMinutes())}`;
  const people = call.participantIds.flatMap((id) => {
    const name = names.get(id);
    return name ? [name] : [];
  });
  return {
    record: {
      audioDeleted: summary.audioDeleted ?? false,
      date: `${start.getDate()} ${SHORT_MONTHS[month]}`,
      dateLabel: `${day}, ${time}`,
      day,
      duration: formatDuration(
        (call.endedAt ?? start.getTime()) - start.getTime()
      ),
      id: call.id,
      month: MONTH_HEADINGS[month] ?? "",
      openCount: call.openQuestions,
      participants: summary.participants ?? people.join(", "),
      projectId: call.projectId,
      proposals: { ...summary.proposals },
      summary: summary.summary ?? "ready",
      tasks: { ...summary.tasks } as Record<string, TaskCardReview>,
      time,
      title: call.title,
    },
    summary,
  };
}

/** A JSON value without `undefined` fields. */
function toJson(value: unknown): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

/* --------------------------------------------------------------- Store */

/** The calls of a project (or all of them) with their people's names. */
const readCalls = (projectId: string | null) =>
  Effect.gen(function* () {
    const calls = yield* CallsData;
    const people = yield* PeopleData;
    const list = yield* calls.list(projectId);
    const projects = [...new Set(list.map((item) => item.projectId))];
    const perProject = yield* Effect.forEach(
      projects,
      (id) => people.list(id),
      { concurrency: "unbounded" }
    );
    const names = new Map(
      perProject.flat().map((person) => [person.id, person.name])
    );
    return list.map((item) => toCallEntry(item, names));
  });

function seedEntries() {
  const seed = mockSeed();
  const names = new Map(seed.people.map((person) => [person.id, person.name]));
  return seed.calls.map((item) => toCallEntry(item, names));
}

const callsStore = createSyncedStore({
  empty: [] as CallEntry[],
  live: inTauri,
  // A call, its project or one of its people changed: re-read the project.
  onChange: (change) =>
    change.entity !== "settings" && change.projectId
      ? {
          scope: change.projectId,
          update: Effect.map(
            readCalls(change.projectId),
            (entries) => (current: CallEntry[]) =>
              current
                .filter((entry) => entry.record.projectId !== change.projectId)
                .concat(entries)
          ),
        }
      : undefined,
  read: readCalls(null),
  runtime: appRuntime,
  seed: seedEntries,
});

/*
 * Local to the window: the progress of a summary build, and the project
 * the start widget picked for the demo call (the demo records it under
 * Телемедиа; a call record can't change its project).
 */
interface LocalCall {
  projectId?: string;
  summaryProgress?: SummaryProgress;
}

const localStore = createStore<Record<string, LocalCall>>({});

function withLocal(entries: CallEntry[], local: Record<string, LocalCall>) {
  return entries.map(({ record }) => {
    const extra = local[record.id];
    if (!extra) {
      return record;
    }
    return {
      ...record,
      projectId: extra.projectId ?? record.projectId,
      summaryProgress: extra.summaryProgress,
    };
  });
}

/** Canonical id of a call, resolving the ids other screens use. */
export function resolveCallId(id: string | null | undefined) {
  if (!id) {
    return;
  }
  return seedCallId(id);
}

export function useCalls() {
  const entries = callsStore.use();
  const local = localStore.use();
  return useMemo(() => withLocal(entries, local), [entries, local]);
}

export function useCallsState() {
  return callsStore.useState();
}

export function useCall(id: string | null | undefined) {
  const calls = useCalls();
  const callId = resolveCallId(id);
  return calls.find((call) => call.id === callId);
}

export function getCall(id: string | null | undefined) {
  const callId = resolveCallId(id);
  return withLocal(callsStore.get(), localStore.get()).find(
    (call) => call.id === callId
  );
}

/** Live: the pending summary write of each call, the last one queued. */
const summaryWrites = new Map<string, Promise<unknown>>();

/**
 * Changes the summary JSON of a call by `update`. Only what `update`
 * changed goes to the backend, as a JSON merge patch that Rust applies to
 * the stored summary in one transaction (`calls_patch_summary`): a change
 * made from a stale copy keeps the keys other writes set meanwhile.
 *
 * In Tauri the writes of one call go one at a time, in the order they were
 * made, and each computes its change from the copy the previous one left.
 * The mock answers at once, so there the write happens before this returns.
 */
function updateSummary(
  id: string,
  update: (summary: SummaryJson) => SummaryJson,
  error = "Не удалось сохранить итоги звонка"
) {
  const write = () => {
    const entry = callsStore.get().find((item) => item.record.id === id);
    if (!entry) {
      return Promise.resolve(undefined);
    }
    const patch = diffPatch(
      toJson(entry.summary),
      toJson(update(entry.summary))
    );
    if (patch === undefined) {
      return Promise.resolve(undefined);
    }
    return callsStore.mutate(
      CallsData.use((calls) => calls.patchSummary(id, patch)),
      { error }
    );
  };
  if (!inTauri) {
    return write();
  }
  const written = (summaryWrites.get(id) ?? Promise.resolve()).then(write);
  const settled = written.catch(() => undefined);
  summaryWrites.set(id, settled);
  settled.then(() => {
    if (summaryWrites.get(id) === settled) {
      summaryWrites.delete(id);
    }
  });
  return written;
}

function setLocal(id: string, next: LocalCall) {
  localStore.set((local) => ({ ...local, [id]: { ...local[id], ...next } }));
}

/** Summary build of a just-finished call; `undefined` progress = ready. */
export function setSummaryProgress(
  id: string,
  progress: SummaryProgress | undefined,
  patch?: Partial<Pick<CallRecord, "participants" | "projectId">>
) {
  setLocal(id, {
    ...(patch?.projectId ? { projectId: patch.projectId } : {}),
    summaryProgress: progress,
  });
  const status: SummaryStatus = progress ? "processing" : "ready";
  const participants = patch?.participants;
  // Unchanged values make an empty patch, which writes nothing.
  updateSummary(id, (summary) => ({
    ...summary,
    ...(participants === undefined ? {} : { participants }),
    summary: status,
  }));
}

export function setProposalDecision(
  id: string,
  proposalId: string,
  review: ProposalReview
) {
  return updateSummary(id, (summary) => ({
    ...summary,
    proposals: { ...summary.proposals, [proposalId]: review },
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
  return updateSummary(
    id,
    (summary) => {
      const tasks = { ...summary.tasks } as Record<string, TaskCardReview>;
      return {
        ...summary,
        tasks: { ...tasks, [cardId]: update(tasks[cardId] ?? NEW_TASK_CARD) },
      };
    },
    "Не удалось сохранить карточку задачи"
  );
}

export function deleteRecording(id: string) {
  return updateSummary(
    id,
    (summary) => ({ ...summary, audioDeleted: true }),
    "Не удалось удалить запись"
  );
}

/** Proposals still waiting for a decision. */
export function countPendingProposals(call: CallRecord) {
  return Object.values(call.proposals).filter(
    (review) => review.decision === "pending"
  ).length;
}

/** Back to the demo history (tests, the dev navigator). Mock only. */
export function resetCalls() {
  localStore.set({});
  const database = appRuntime.runSync(Effect.serviceOption(MockDatabase));
  if (Option.isSome(database)) {
    appRuntime.runSync(database.value.resetCalls);
    callsStore.refresh();
  }
}

/** Reads the calls again (the storage error screen's "Повторить"). */
export function refreshCalls() {
  return callsStore.refresh();
}
