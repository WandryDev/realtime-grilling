"use client";

import { type MockProject, PROJECTS } from "@/features/mock/projects";

import { createStore } from "./store";

/*
 * Projects of the user. The sidebar, home, history, the start widget and the
 * new-project wizard all read this list, so a project created in the wizard
 * or deleted on its page shows up everywhere.
 */

const projectsStore = createStore<MockProject[]>(PROJECTS);

export function useProjects() {
  return projectsStore.use();
}

export function useProject(id: string | null | undefined) {
  const projects = projectsStore.use();
  return projects.find((project) => project.id === id);
}

export function getProjects() {
  return projectsStore.get();
}

function slugify(name: string) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return base || "project";
}

/** Adds a project and returns its id. */
export function createProject(input: {
  description?: string;
  name: string;
}): string {
  const existing = new Set(projectsStore.get().map((item) => item.id));
  const base = slugify(input.name);
  let id = base;
  let suffix = 2;
  while (existing.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }

  const project: MockProject = {
    description: input.description ?? "",
    id,
    initial: input.name.trim().charAt(0).toUpperCase() || "П",
    name: input.name.trim(),
    openQuestions: 0,
  };
  projectsStore.set((projects) => [...projects, project]);
  return id;
}

export function updateProject(
  id: string,
  patch: Partial<Omit<MockProject, "id">>
) {
  projectsStore.set((projects) =>
    projects.map((project) =>
      project.id === id ? { ...project, ...patch } : project
    )
  );
}

export function deleteProject(id: string) {
  projectsStore.set((projects) =>
    projects.filter((project) => project.id !== id)
  );
}
