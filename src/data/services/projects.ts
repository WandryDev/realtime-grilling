import { Context, Effect, Layer, Predicate } from "effect";

import {
  commands,
  type Project,
  type ProjectCreate,
  type ProjectOverview,
  type ProjectUpdate,
} from "@/bindings";
import {
  DESCRIPTION_MAX_CHARS,
  DESCRIPTION_TOO_LONG,
  NOTES_MAX_CHARS,
  NOTES_TOO_LONG,
} from "@/data/project-limits";
import { type BackendError, call } from "@/effect/tauri";

import {
  briefStateOf,
  compareIds,
  dropCallRecords,
  limitedText,
  MockDatabase,
  notFound,
  orCurrent,
  requiredName,
} from "./mock-database";

/*
 * Projects in the local database. `layerTauri` calls the Rust commands,
 * `layerMock` keeps the same contract in memory (MockDatabase): UUID v7
 * ids, `Invalid` for an empty name or a description / notes over their
 * limits (`../project-limits.ts`), `NotFound`, a cascade delete (people,
 * calls, documents) and one `DataChanged` per write. The brief state is
 * computed on every read; a brief given in `create` / `update` is not the
 * agent's and reads as `outdated`.
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
    /** Takes the project's people, calls and documents along. */
    readonly remove: (id: string) => Effect.Effect<void, BackendError>;
    /** Open questions and the last recording of every project (home). */
    readonly overview: Effect.Effect<ProjectOverview[], BackendError>;
  }
>()("grill/data/services/ProjectsData") {
  static readonly layerTauri = Layer.succeed(ProjectsData, {
    create: (input) => call(() => commands.projectsCreate(input)),
    get: (id) => call(() => commands.projectsGet(id)),
    list: call(() => commands.projectsList()),
    overview: call(() => commands.projectsOverview()),
    remove: (id) => Effect.asVoid(call(() => commands.projectsDelete(id))),
    update: (id, patch) => call(() => commands.projectsUpdate(id, patch)),
  });

  static readonly layerMock = Layer.effect(
    ProjectsData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      /** A stored project as the read gives it: with its brief state. */
      const read = (project: Project): Project => ({
        ...project,
        briefState: briefStateOf(tables, project),
      });

      const stored = Effect.fnUntraced(function* (id: string) {
        const project = tables.projects.get(id);
        if (!project) {
          return yield* notFound(`Проект ${id} не найден`);
        }
        return project;
      });

      const get = (id: string) => Effect.map(stored(id), read);

      const description = (text: string) =>
        limitedText(text, DESCRIPTION_MAX_CHARS, DESCRIPTION_TOO_LONG);
      const notes = (text: string) =>
        limitedText(text, NOTES_MAX_CHARS, NOTES_TOO_LONG);

      const create = Effect.fnUntraced(function* (input: ProjectCreate) {
        const name = yield* requiredName(input.name);
        const checkedDescription = yield* description(input.description ?? "");
        const checkedNotes = yield* notes(input.notes ?? "");
        const { id, now } = yield* database.stamp;
        const brief = input.brief ?? null;
        const project: Project = {
          brief,
          briefBuiltAt: brief === null ? null : now,
          briefState: "none",
          briefTruncated: false,
          createdAt: now,
          description: checkedDescription,
          id,
          name,
          notes: checkedNotes,
          openQuestions: 0,
          updatedAt: now,
        };
        tables.projects.set(id, project);
        yield* database.emit("project", id, id, "created");
        return read(project);
      });

      const update = Effect.fnUntraced(function* (
        id: string,
        patch: ProjectUpdate
      ) {
        const current = yield* stored(id);
        const name = Predicate.isNullish(patch.name)
          ? current.name
          : yield* requiredName(patch.name);
        const checkedDescription = Predicate.isNullish(patch.description)
          ? current.description
          : yield* description(patch.description);
        const checkedNotes = Predicate.isNullish(patch.notes)
          ? current.notes
          : yield* notes(patch.notes);
        const updatedAt = yield* database.touch(current.updatedAt);
        const project: Project = {
          ...current,
          brief: orCurrent(patch.brief, current.brief),
          description: checkedDescription,
          name,
          notes: checkedNotes,
          updatedAt,
        };
        if (patch.brief !== undefined) {
          // Not the agent's brief: no fingerprint, so it reads as outdated.
          tables.briefInputs.delete(id);
          project.briefBuiltAt = patch.brief === null ? null : updatedAt;
          project.briefTruncated = false;
        }
        tables.projects.set(id, project);
        yield* database.emit("project", id, id, "updated");
        return read(project);
      });

      const remove = Effect.fnUntraced(function* (id: string) {
        yield* stored(id);
        tables.projects.delete(id);
        tables.briefInputs.delete(id);
        for (const [sourceId, { source }] of tables.sources) {
          if (source.projectId === id) {
            tables.sources.delete(sourceId);
          }
        }
        for (const [personId, person] of tables.people) {
          if (person.projectId === id) {
            tables.people.delete(personId);
          }
        }
        for (const [callId, item] of tables.calls) {
          if (item.projectId === id) {
            tables.calls.delete(callId);
            dropCallRecords(tables, callId);
          }
        }
        // One event about the root record, like the cascade in SQLite.
        yield* database.emit("project", id, id, "deleted");
      });

      const overview = Effect.sync(() =>
        [...tables.projects.values()].map((project): ProjectOverview => {
          let openQuestions = 0;
          let lastRecordingAt: number | null = null;
          for (const item of tables.calls.values()) {
            if (item.projectId !== project.id) {
              continue;
            }
            openQuestions += item.openQuestions;
            if (item.startedAt !== null) {
              lastRecordingAt = Math.max(lastRecordingAt ?? 0, item.startedAt);
            }
          }
          return { lastRecordingAt, openQuestions, projectId: project.id };
        })
      );

      return ProjectsData.of({
        create,
        get,
        list: Effect.sync(() =>
          [...tables.projects.values()]
            .sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id))
            .map(read)
        ),
        overview,
        remove,
        update,
      });
    })
  );
}
