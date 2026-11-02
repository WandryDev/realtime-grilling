"use client";

import { Effect } from "effect";

import type { Project } from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";
import type { MockProject } from "@/features/mock/projects";

import { mockSeed } from "./services/mock-seed";
import { ProjectsData } from "./services/projects";
import { createSyncedStore } from "./synced-store";

/*
 * Projects of the user. The sidebar, home, history, the start widget and the
 * new-project wizard all read this list, so a project created in the wizard
 * or deleted on its page shows up everywhere, in every window. Ids come
 * from the backend (UUID v7); the demo records keep their readable ids.
 */

/* ------------------------------------------------------------- Adapter */

/** A stored project as the screens draw it. */
export function toMockProject(project: Project): MockProject {
  const name = project.name.trim();
  return {
    description: project.description,
    id: project.id,
    initial: name.charAt(0).toUpperCase() || "П",
    name,
    openQuestions: project.openQuestions,
  };
}

/* --------------------------------------------------------------- Store */

const readProjects = ProjectsData.use((projects) => projects.list).pipe(
  Effect.map((list) => list.map(toMockProject))
);

const projectsStore = createSyncedStore({
  empty: [] as MockProject[],
  live: inTauri,
  // A project, or a question: the sidebar counts the open ones.
  onChange: (change) =>
    change.entity === "project" || change.entity === "question"
      ? { update: Effect.map(readProjects, (list) => () => list) }
      : undefined,
  read: readProjects,
  runtime: appRuntime,
  seed: () => mockSeed().projects.map(toMockProject),
});

export function useProjects() {
  return projectsStore.use();
}

/** The list with its load status: the main window waits for it. */
export function useProjectsState() {
  return projectsStore.useState();
}

export function getProjectsState() {
  return projectsStore.getState();
}

export function subscribeProjects(listener: () => void) {
  return projectsStore.subscribe(listener);
}

export function useProject(id: string | null | undefined) {
  const projects = projectsStore.use();
  return projects.find((project) => project.id === id);
}

export function getProjects() {
  return projectsStore.get();
}

/**
 * Creates a project and resolves to the id the backend gave it, or
 * `undefined` when it failed (a toast says why). In the browser the list
 * already has it when this returns.
 */
export function createProject(input: {
  description?: string;
  name: string;
}): Promise<string | undefined> {
  return projectsStore
    .mutate(
      ProjectsData.use((projects) =>
        projects.create({
          description: input.description ?? "",
          name: input.name,
        })
      ),
      { error: "Не удалось создать проект" }
    )
    .then((project) => project?.id);
}

/** `initial` follows the name; `openQuestions` is counted by the backend. */
export function updateProject(
  id: string,
  patch: Partial<Omit<MockProject, "id">>
) {
  return projectsStore.mutate(
    ProjectsData.use((projects) =>
      projects.update(id, {
        description: patch.description,
        name: patch.name,
      })
    ),
    { error: "Не удалось сохранить проект" }
  );
}

/** Deletes the project with its people and calls. */
export function deleteProject(id: string) {
  return projectsStore.mutate(
    ProjectsData.use((projects) => projects.remove(id)),
    { error: "Не удалось удалить проект" }
  );
}

/** Reads the projects again (the storage error screen's "Повторить"). */
export function refreshProjects() {
  return projectsStore.refresh();
}
