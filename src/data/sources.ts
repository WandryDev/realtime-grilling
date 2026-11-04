"use client";

import { Effect } from "effect";

import type { ProjectSource, SourceAddResult } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";

import { ProjectsData } from "./services/projects";
import { ProjectSourcesData } from "./services/sources";
import { createSyncedStore } from "./synced-store";

/*
 * Documents of the projects, from the manager's computer. The wizard and
 * the project page list them with what reading them gave; a document added
 * or removed in any window shows up everywhere. Rust sends the project's
 * `DataChanged` after every write, so the store re-reads that project.
 */

/** Everyone's documents: those of every project. */
const readSources = Effect.gen(function* () {
  const projects = yield* ProjectsData;
  const sources = yield* ProjectSourcesData;
  const list = yield* projects.list;
  const perProject = yield* Effect.forEach(
    list,
    (project) => sources.list(project.id),
    { concurrency: "unbounded" }
  );
  return perProject.flat();
});

/** The documents of one project replace what the store had for it. */
const rereadProject = (projectId: string) =>
  ProjectSourcesData.use((sources) => sources.list(projectId)).pipe(
    // A deleted project has no documents left.
    Effect.catchTag("BackendError", (error) =>
      error.kind === "NotFound" ? Effect.succeed([]) : Effect.fail(error)
    ),
    Effect.map(
      (list) => (current: ProjectSource[]) =>
        current.filter((source) => source.projectId !== projectId).concat(list)
    )
  );

const sourcesStore = createSyncedStore({
  empty: [] as ProjectSource[],
  live: inTauri,
  onChange: (change) =>
    change.entity === "project" && change.projectId
      ? { scope: change.projectId, update: rereadProject(change.projectId) }
      : undefined,
  read: readSources,
  runtime: appRuntime,
  // The demo projects have no documents.
  seed: () => [],
});

export function useProjectSources(projectId: string | null | undefined) {
  const sources = sourcesStore.use();
  return sources.filter((source) => source.projectId === projectId);
}

/**
 * Adds files to a project: a result per path (added, a duplicate, or
 * rejected with the reason to show). `undefined` when the call failed
 * (a toast says why).
 */
export function addProjectSources(
  projectId: string,
  paths: string[]
): Promise<SourceAddResult[] | undefined> {
  return sourcesStore.mutate(
    ProjectSourcesData.use((sources) => sources.add(projectId, paths)),
    { error: "Не удалось добавить документы" }
  );
}

/** Deletes a document and its copy in the app data. */
export function removeProjectSource(id: string) {
  return sourcesStore.mutate(
    ProjectSourcesData.use((sources) => sources.remove(id)),
    { error: "Не удалось удалить документ" }
  );
}

/** Reads the documents again (the storage error screen's "Повторить"). */
export function refreshSources() {
  return sourcesStore.refresh();
}
