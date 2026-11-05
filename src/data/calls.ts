"use client";

import { Effect, Option, Schema } from "effect";
import { useMemo } from "react";

import type { Call, Value } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";
import { diffPatch } from "@/lib/merge-patch";
import { deleteCallAudio, isCallAudioDeleted } from "./call-records";
import { CallsData } from "./services/calls";
import { MockDatabase } from "./services/mock-database";
import { mockSeed, seedCallId } from "./services/mock-seed";
import { PeopleData } from "./services/people";
import { createStore } from "./store";
import { createSyncedStore, refreshMockStores } from "./synced-store";

/*
 * Finished calls: the history list and the call record every post-call
 * page frames itself with.
 *
 * The call's `summary` JSON (its shape belongs to the frontend) keeps the
 * participants' names of the call session; dates, duration and the open
 * count come from the record. The summary, its build, proposals, task
 * cards and recordings Rust keeps are read by `./summaries.ts`,
 * `./proposals.ts` and `./call-records.ts`.
 *
 * Until the details page reads the recordings (post-call task 4.5), the
 * deleted audio stays local to the window too, seeded with the demo's
 * (`reviewSeed`); «Удалить запись» also deletes the files
 * (`call_audio_delete`).
 */

/** How the screens name a call without a project. */
export const NO_PROJECT_CALL = "Звонок без проекта";

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
  /** When it ended, ms since the epoch; `null` while it goes on. */
  endedAt: number | null;
  id: string;
  /** Month heading of the history, "Октябрь". */
  month: string;
  openCount: number;
  /** The client's people on the call, as stored. */
  participantIds: string[];
  participants: string;
  /** null: a call without a project ("Звонок без проекта"). */
  projectId: string | null;
  /** When it started (its creation without a start), ms since the epoch. */
  startedAt: number;
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

/** The frontend's part of a call: `Call.summary`. */
const CallSummary = Schema.Struct({
  /** Names from the call session, for people the project doesn't have. */
  participants: Schema.optionalKey(Schema.String),
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
      audioDeleted: false,
      date: `${start.getDate()} ${SHORT_MONTHS[month]}`,
      dateLabel: `${day}, ${time}`,
      day,
      duration: formatDuration(
        (call.endedAt ?? start.getTime()) - start.getTime()
      ),
      endedAt: call.endedAt,
      id: call.id,
      month: MONTH_HEADINGS[month] ?? "",
      openCount: call.openQuestions,
      participantIds: call.participantIds,
      participants: summary.participants ?? people.join(", "),
      projectId: call.projectId,
      startedAt: start.getTime(),
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
    const projects = [
      ...new Set(
        list.flatMap((item) => (item.projectId ? [item.projectId] : []))
      ),
    ];
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
  // A call without a project has no scope of its own: re-read them all.
  onChange: (change) => {
    if (change.entity === "call" && change.projectId === null) {
      return {
        update: Effect.map(readCalls(null), (entries) => () => entries),
      };
    }
    return change.entity !== "settings" && change.projectId
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
      : undefined;
  },
  read: readCalls(null),
  runtime: appRuntime,
  seed: seedEntries,
});

/*
 * Local to the window: the project the start widget picked for the demo
 * call (the demo records it under Телемедиа; a call record can't change
 * its project) and the deleted audio, until the details page reads it.
 */
interface LocalCall {
  audioDeleted?: boolean;
  projectId?: string;
}

/** The history's «аудио удалено» calls of the demo have no audio. */
function reviewSeed(): Record<string, LocalCall> {
  const seed = mockSeed();
  const local: Record<string, LocalCall> = {};
  for (const call of seed.calls) {
    const audioDeleted = seed.recordings.some(
      (item) => item.callId === call.id && item.recording.audioDeleted
    );
    local[call.id] = { audioDeleted };
  }
  return local;
}

const localStore = createStore<Record<string, LocalCall>>(reviewSeed());

function withLocal(entries: CallEntry[], local: Record<string, LocalCall>) {
  return entries.map(({ record }) => {
    const extra = local[record.id];
    if (!extra) {
      return record;
    }
    return {
      ...record,
      audioDeleted: extra.audioDeleted ?? record.audioDeleted,
      projectId: extra.projectId ?? record.projectId,
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

/**
 * The people of the call session of a call that just ended: their names
 * go to the summary JSON, the project stays local (the demo records every
 * call of the browser under one id). Unchanged names write nothing.
 */
export function setCallPeople(
  id: string,
  patch: Partial<Pick<CallRecord, "participants" | "projectId">>
) {
  if (patch.projectId) {
    setLocal(id, { projectId: patch.projectId });
  }
  const { participants } = patch;
  if (participants === undefined) {
    return Promise.resolve(undefined);
  }
  return updateSummary(id, (summary) => ({ ...summary, participants }));
}

/**
 * «Удалить запись»: deletes the audio of every recording of the call
 * (`call_audio_delete`); the call reads `audioDeleted` once it is done.
 */
export function deleteRecording(id: string) {
  const deleted = deleteCallAudio(id);
  // The mock deletes before this returns, as the screens' tests expect.
  if (!inTauri && isCallAudioDeleted(id)) {
    setLocal(id, { audioDeleted: true });
    return deleted;
  }
  return deleted.then((done) => {
    if (done) {
      setLocal(id, { audioDeleted: true });
    }
    return done;
  });
}

/**
 * Deletes the calls without a project ("Удалить все данные": a deleted
 * project takes its calls along, these have none).
 */
export async function deleteCallsWithoutProject() {
  const ids = callsStore
    .get()
    .filter((entry) => entry.record.projectId === null)
    .map((entry) => entry.record.id);
  await Promise.all(
    ids.map((id) =>
      callsStore.mutate(
        CallsData.use((calls) => calls.remove(id)),
        { error: "Не удалось удалить звонок" }
      )
    )
  );
}

/** Back to the demo history (tests, the dev navigator). Mock only. */
export function resetCalls() {
  localStore.set(reviewSeed());
  const database = appRuntime.runSync(Effect.serviceOption(MockDatabase));
  if (Option.isSome(database)) {
    appRuntime.runSync(database.value.resetCalls);
    // The calls and every per-call store (summaries, cards, proposals).
    refreshMockStores();
  }
}

/** Reads the calls again (the storage error screen's "Повторить"). */
export function refreshCalls() {
  return callsStore.refresh();
}
