import { Context, Effect, Layer, Predicate } from "effect";

import {
  commands,
  type Person,
  type PersonCreate,
  type PersonUpdate,
  type Value,
} from "@/bindings";
import { type BackendError, call } from "@/effect/tauri";

import {
  compareIds,
  invalid,
  MockDatabase,
  notFound,
  requiredName,
} from "./mock-database";

/*
 * People of the client, per project. The rich part of a person (how to
 * ask, levels, portrait) lives in the `profile` JSON object. Every write
 * also tells about the project: its brief is built from its people.
 */
export class PeopleData extends Context.Service<
  PeopleData,
  {
    /** People of a project, oldest first; `[]` for an unknown project. */
    readonly list: (projectId: string) => Effect.Effect<Person[], BackendError>;
    readonly get: (id: string) => Effect.Effect<Person, BackendError>;
    readonly create: (
      input: PersonCreate
    ) => Effect.Effect<Person, BackendError>;
    readonly update: (
      id: string,
      patch: PersonUpdate
    ) => Effect.Effect<Person, BackendError>;
    readonly remove: (id: string) => Effect.Effect<void, BackendError>;
  }
>()("grill/data/services/PeopleData") {
  static readonly layerTauri = Layer.succeed(PeopleData, {
    create: (input) => call(() => commands.peopleCreate(input)),
    get: (id) => call(() => commands.peopleGet(id)),
    list: (projectId) => call(() => commands.peopleList(projectId)),
    remove: (id) => Effect.asVoid(call(() => commands.peopleDelete(id))),
    update: (id, patch) => call(() => commands.peopleUpdate(id, patch)),
  });

  static readonly layerMock = Layer.effect(
    PeopleData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const profileObject = Effect.fnUntraced(function* (
        profile: Value | null | undefined
      ) {
        if (Predicate.isNullish(profile)) {
          return {};
        }
        if (!Predicate.isObject(profile) || Array.isArray(profile)) {
          return yield* invalid("Профиль человека должен быть объектом");
        }
        return profile;
      });

      /** The project's `DataChanged` after a write of its people. */
      const projectChanged = (projectId: string) =>
        database.emit("project", projectId, projectId, "updated");

      const get = Effect.fnUntraced(function* (id: string) {
        const person = tables.people.get(id);
        if (!person) {
          return yield* notFound(`Человек ${id} не найден`);
        }
        return person;
      });

      const create = Effect.fnUntraced(function* (input: PersonCreate) {
        const name = yield* requiredName(input.name);
        const profile = yield* profileObject(input.profile);
        if (!tables.projects.has(input.projectId)) {
          return yield* notFound(`Проект ${input.projectId} не найден`);
        }
        const { id, now } = yield* database.stamp;
        const person: Person = {
          createdAt: now,
          id,
          name,
          profile,
          projectId: input.projectId,
          role: input.role?.trim() ?? "",
          updatedAt: now,
        };
        tables.people.set(id, person);
        yield* database.emit("person", id, person.projectId, "created");
        yield* projectChanged(person.projectId);
        return person;
      });

      const update = Effect.fnUntraced(function* (
        id: string,
        patch: PersonUpdate
      ) {
        const current = yield* get(id);
        const person: Person = {
          ...current,
          name: Predicate.isNullish(patch.name)
            ? current.name
            : yield* requiredName(patch.name),
          profile: Predicate.isNullish(patch.profile)
            ? current.profile
            : yield* profileObject(patch.profile),
          role: patch.role?.trim() ?? current.role,
          updatedAt: yield* database.touch(current.updatedAt),
        };
        tables.people.set(id, person);
        yield* database.emit("person", id, person.projectId, "updated");
        yield* projectChanged(person.projectId);
        return person;
      });

      const remove = Effect.fnUntraced(function* (id: string) {
        const person = yield* get(id);
        tables.people.delete(id);
        // Their proposals go with them (`ON DELETE CASCADE`).
        for (const [proposalId, proposal] of tables.proposals) {
          if (proposal.personId === id) {
            tables.proposals.delete(proposalId);
          }
        }
        // They leave every call they took part in.
        for (const [callId, item] of tables.calls) {
          if (item.participantIds.includes(id)) {
            tables.calls.set(callId, {
              ...item,
              participantIds: item.participantIds.filter(
                (personId) => personId !== id
              ),
            });
          }
        }
        yield* database.emit("person", id, person.projectId, "deleted");
        yield* projectChanged(person.projectId);
      });

      return PeopleData.of({
        create,
        get,
        list: (projectId) =>
          Effect.sync(() =>
            [...tables.people.values()]
              .filter((person) => person.projectId === projectId)
              .sort(
                (a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id)
              )
          ),
        remove,
        update,
      });
    })
  );
}
