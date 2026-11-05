import { Context, Effect, Layer } from "effect";

import {
  type Call,
  type CallCreate,
  type CallSearch,
  type CallUpdate,
  commands,
  type Person,
  type Value,
} from "@/bindings";
import { type BackendError, call } from "@/effect/tauri";
import { mergePatch } from "@/lib/merge-patch";

import {
  compareIds,
  dropCallRecords,
  invalid,
  MockDatabase,
  notFound,
  orCurrent,
} from "./mock-database";
import { searchCalls } from "./mock-search";

/*
 * Calls and their participants. A participant is a person of the call's
 * project; one from another project is `Invalid`. A call may have no
 * project ("Звонок без проекта"): it has no participants then. The
 * `summary` JSON is the frontend's (`src/data/calls.ts`); the summary,
 * proposals and recordings Rust keeps are other services
 * (`./summaries.ts`, `./proposals.ts`, `./call-records.ts`). Deleting a
 * call deletes them.
 *
 * `search` looks through the calls' titles, transcripts (the shown pass)
 * and summaries, without case and «ё»: at most 200 matches with ±60
 * characters around each, and the counts per project over every call.
 *
 * In an update `null` clears a nullable field (`endedAt`, `summary`) and
 * an absent key leaves it. `patchSummary` merges an RFC 7386 patch into
 * the summary where it is stored, so writers of different keys never
 * lose each other's change.
 */
export class CallsData extends Context.Service<
  CallsData,
  {
    /** Calls of a project, or every call for `null`; newest first. */
    readonly list: (
      projectId: string | null
    ) => Effect.Effect<Call[], BackendError>;
    readonly get: (id: string) => Effect.Effect<Call, BackendError>;
    readonly create: (input: CallCreate) => Effect.Effect<Call, BackendError>;
    readonly update: (
      id: string,
      patch: CallUpdate
    ) => Effect.Effect<Call, BackendError>;
    /** Applies a JSON merge patch to the call's `summary`. */
    readonly patchSummary: (
      id: string,
      patch: Value
    ) => Effect.Effect<Call, BackendError>;
    readonly remove: (id: string) => Effect.Effect<void, BackendError>;
    readonly participants: (
      callId: string
    ) => Effect.Effect<Person[], BackendError>;
    readonly addParticipant: (
      callId: string,
      personId: string
    ) => Effect.Effect<Call, BackendError>;
    readonly removeParticipant: (
      callId: string,
      personId: string
    ) => Effect.Effect<Call, BackendError>;
    /** Searches the calls of a project, or all of them for `null`. */
    readonly search: (
      query: string,
      projectId: string | null
    ) => Effect.Effect<CallSearch, BackendError>;
  }
>()("grill/data/services/CallsData") {
  static readonly layerTauri = Layer.succeed(CallsData, {
    addParticipant: (callId, personId) =>
      call(() => commands.callParticipantsAdd(callId, personId)),
    create: (input) => call(() => commands.callsCreate(input)),
    get: (id) => call(() => commands.callsGet(id)),
    list: (projectId) => call(() => commands.callsList(projectId)),
    participants: (callId) => call(() => commands.callParticipantsList(callId)),
    patchSummary: (id, patch) =>
      call(() => commands.callsPatchSummary(id, patch)),
    remove: (id) => Effect.asVoid(call(() => commands.callsDelete(id))),
    removeParticipant: (callId, personId) =>
      call(() => commands.callParticipantsRemove(callId, personId)),
    search: (query, projectId) =>
      call(() => commands.callsSearch(query, projectId)),
    update: (id, patch) => call(() => commands.callsUpdate(id, patch)),
  });

  static readonly layerMock = Layer.effect(
    CallsData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const get = Effect.fnUntraced(function* (id: string) {
        const found = tables.calls.get(id);
        if (!found) {
          return yield* notFound(`Звонок ${id} не найден`);
        }
        return found;
      });

      const checkTimes = Effect.fnUntraced(function* (
        startedAt: number | null,
        endedAt: number | null
      ) {
        if (startedAt !== null && endedAt !== null && endedAt < startedAt) {
          return yield* invalid(
            "Звонок не может закончиться раньше, чем начался"
          );
        }
      });

      /**
       * A person of the call's project, or why not. A call without a
       * project has no participants.
       */
      const participant = Effect.fnUntraced(function* (
        projectId: string | null,
        personId: string
      ) {
        if (projectId === null) {
          return yield* invalid("У звонка без проекта нет участников");
        }
        const person = tables.people.get(personId);
        if (!person) {
          return yield* notFound(`Человек ${personId} не найден`);
        }
        if (person.projectId !== projectId) {
          return yield* invalid(
            `${person.name} из другого проекта и не может быть участником этого звонка`
          );
        }
        return person;
      });

      const create = Effect.fnUntraced(function* (input: CallCreate) {
        const projectId = input.projectId ?? null;
        if (projectId !== null && !tables.projects.has(projectId)) {
          return yield* notFound(`Проект ${projectId} не найден`);
        }
        const { id, now } = yield* database.stamp;
        const startedAt = input.startedAt ?? now;
        const endedAt = input.endedAt ?? null;
        yield* checkTimes(startedAt, endedAt);
        const participantIds: string[] = [];
        for (const personId of input.participantIds ?? []) {
          yield* participant(projectId, personId);
          if (!participantIds.includes(personId)) {
            participantIds.push(personId);
          }
        }
        const created: Call = {
          createdAt: now,
          endedAt,
          id,
          openQuestions: 0,
          participantIds,
          projectId,
          startedAt,
          status: input.status ?? "live",
          summary: input.summary ?? null,
          title: input.title?.trim() ?? "",
          updatedAt: now,
        };
        tables.calls.set(id, created);
        yield* database.emit("call", id, projectId, "created");
        return created;
      });

      const update = Effect.fnUntraced(function* (
        id: string,
        patch: CallUpdate
      ) {
        const current = yield* get(id);
        const startedAt = orCurrent(patch.startedAt, current.startedAt);
        const endedAt = orCurrent(patch.endedAt, current.endedAt);
        yield* checkTimes(startedAt, endedAt);
        const updated: Call = {
          ...current,
          endedAt,
          startedAt,
          status: patch.status ?? current.status,
          summary: orCurrent(patch.summary, current.summary),
          title: patch.title?.trim() ?? current.title,
          updatedAt: yield* database.touch(current.updatedAt),
        };
        tables.calls.set(id, updated);
        yield* database.emit("call", id, updated.projectId, "updated");
        return updated;
      });

      const patchSummary = Effect.fnUntraced(function* (
        id: string,
        patch: Value
      ) {
        const current = yield* get(id);
        const summary = mergePatch(current.summary, patch);
        const updated: Call = {
          ...current,
          summary,
          updatedAt: yield* database.touch(current.updatedAt),
        };
        tables.calls.set(id, updated);
        yield* database.emit("call", id, updated.projectId, "updated");
        return updated;
      });

      const remove = Effect.fnUntraced(function* (id: string) {
        const current = yield* get(id);
        tables.calls.delete(id);
        dropCallRecords(tables, id);
        yield* database.emit("call", id, current.projectId, "deleted");
      });

      /** Participant changes count as an update of the call. */
      const changeParticipants = Effect.fnUntraced(function* (
        current: Call,
        participantIds: string[]
      ) {
        const updated: Call = {
          ...current,
          participantIds,
          updatedAt: yield* database.touch(current.updatedAt),
        };
        tables.calls.set(current.id, updated);
        yield* database.emit("call", current.id, current.projectId, "updated");
        return updated;
      });

      const addParticipant = Effect.fnUntraced(function* (
        callId: string,
        personId: string
      ) {
        const current = yield* get(callId);
        yield* participant(current.projectId, personId);
        const participantIds = current.participantIds.includes(personId)
          ? current.participantIds
          : [...current.participantIds, personId];
        return yield* changeParticipants(current, participantIds);
      });

      const removeParticipant = Effect.fnUntraced(function* (
        callId: string,
        personId: string
      ) {
        const current = yield* get(callId);
        if (!current.participantIds.includes(personId)) {
          return yield* notFound(
            `Человек ${personId} не участвует в звонке ${callId}`
          );
        }
        return yield* changeParticipants(
          current,
          current.participantIds.filter((item) => item !== personId)
        );
      });

      const participants = Effect.fnUntraced(function* (callId: string) {
        const current = yield* get(callId);
        return current.participantIds.flatMap((personId) => {
          const person = tables.people.get(personId);
          return person ? [person] : [];
        });
      });

      const newest = (item: Call) => item.startedAt ?? item.createdAt;
      const listed = (projectId: string | null) =>
        [...tables.calls.values()]
          .filter((item) => projectId === null || item.projectId === projectId)
          .sort((a, b) => newest(b) - newest(a) || compareIds(b.id, a.id));

      return CallsData.of({
        addParticipant,
        create,
        get,
        list: (projectId) => Effect.sync(() => listed(projectId)),
        participants,
        patchSummary,
        remove,
        removeParticipant,
        search: (query, projectId) =>
          Effect.sync(() =>
            searchCalls(tables, listed(null), query, projectId)
          ),
        update,
      });
    })
  );
}
