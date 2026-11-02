import { Context, Effect, Layer, Predicate } from "effect";

import {
  commands,
  type Project,
  type ProjectCreate,
  type ProjectUpdate,
} from "@/bindings";
import { type BackendError, call } from "@/effect/tauri";

import {
  compareIds,
  MockDatabase,
  notFound,
  orCurrent,
  requiredName,
} from "./mock-database";

/*
 * Projects in the local database. `layerTauri` calls the Rust commands,
 * `layerMock` keeps the same contract in memory (MockDatabase): UUID v7
 * ids, `Invalid` for an empty name, `NotFound`, a cascade delete and one
 * `DataChanged` per write.
 */
export class ProjectsData extends Context.Service<
  ProjectsData,
  {
    /** Oldest first. */
    readonly list: Effect.Effect<Project[], BackendError>;
    readonly get: (id: string) => Effect.Effect<Project, BackendError>;
    readonly create: (
      input: ProjectCreate
    ) => Effect.Effect<Project, BackendError>;
    readonly update: (
      id: string,
      patch: ProjectUpdate
    ) => Effect.Effect<Project, BackendError>;
    /** Takes the project's people and calls along. */
    readonly remove: (id: string) => Effect.Effect<void, BackendError>;
  }
>()("grill/data/services/ProjectsData") {
  static readonly layerTauri = Layer.succeed(ProjectsData, {
    create: (input) => call(() => commands.projectsCreate(input)),
    get: (id) => call(() => commands.projectsGet(id)),
    list: call(() => commands.projectsList()),
    remove: (id) => Effect.asVoid(call(() => commands.projectsDelete(id))),
    update: (id, patch) => call(() => commands.projectsUpdate(id, patch)),
  });

  static readonly layerMock = Layer.effect(
    ProjectsData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const get = Effect.fnUntraced(function* (id: string) {
        const project = tables.projects.get(id);
        if (!project) {
          return yield* notFound(`Проект ${id} не найден`);
        }
        return project;
      });

      const create = Effect.fnUntraced(function* (input: ProjectCreate) {
        const name = yield* requiredName(input.name);
        const { id, now } = yield* database.stamp;
        const project: Project = {
          brief: input.brief ?? null,
          createdAt: now,
          description: input.description?.trim() ?? "",
          id,
          name,
          openQuestions: 0,
          updatedAt: now,
        };
        tables.projects.set(id, project);
        yield* database.emit("project", id, id, "created");
        return project;
      });

      const update = Effect.fnUntraced(function* (
        id: string,
        patch: ProjectUpdate
      ) {
        const current = yield* get(id);
        const name = Predicate.isNullish(patch.name)
          ? current.name
          : yield* requiredName(patch.name);
        const project: Project = {
          ...current,
          brief: orCurrent(patch.brief, current.brief),
          description: patch.description?.trim() ?? current.description,
          name,
          updatedAt: yield* database.touch(current.updatedAt),
        };
        tables.projects.set(id, project);
        yield* database.emit("project", id, id, "updated");
        return project;
      });

      const remove = Effect.fnUntraced(function* (id: string) {
        yield* get(id);
        tables.projects.delete(id);
        for (const [personId, person] of tables.people) {
          if (person.projectId === id) {
            tables.people.delete(personId);
          }
        }
        for (const [callId, item] of tables.calls) {
          if (item.projectId === id) {
            tables.calls.delete(callId);
          }
        }
        // One event about the root record, like the cascade in SQLite.
        yield* database.emit("project", id, id, "deleted");
      });

      return ProjectsData.of({
        create,
        get,
        list: Effect.sync(() =>
          [...tables.projects.values()].sort(
            (a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id)
          )
        ),
        remove,
        update,
      });
    })
  );
}
