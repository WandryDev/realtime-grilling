"use client";

import { Effect, Option, Schema } from "effect";

import type {
  Brief,
  BriefState,
  Project,
  ProjectOverview,
  Value,
} from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";
import type { MockProject } from "@/features/mock/projects";
import { isCardLens } from "@/lib/card-lens";

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

/** A stored project with its brief, as the project screens draw it. */
export interface ProjectRecord extends MockProject {
  /** `null` until the agent built one (or when it can't be read). */
  brief: Brief | null;
  /** When the brief was built, ms; `null` without one. */
  briefBuiltAt: number | null;
  briefState: BriefState;
  /** The brief was built from shortened materials. */
  briefTruncated: boolean;
  /** What the manager wrote about the project for the agent. */
  notes: string;
  /** Home: open questions of the project's recordings and the last one. */
  recordings: { lastAt: number | null; openQuestions: number };
}

const BriefSchema = Schema.Struct({
  // A brief built before the gaps has none; a lens is checked on reading.
  gaps: Schema.optionalKey(
    Schema.Array(Schema.Struct({ lens: Schema.String, text: Schema.String }))
  ),
  glossary: Schema.Array(
    Schema.Struct({ definition: Schema.String, term: Schema.String })
  ),
  keyDocuments: Schema.Array(
    Schema.Struct({
      sourceId: Schema.String,
      title: Schema.String,
      why: Schema.String,
    })
  ),
  modules: Schema.Array(
    Schema.Struct({ description: Schema.String, name: Schema.String })
  ),
  product: Schema.String,
  stack: Schema.Array(Schema.String),
});
const decodeBrief = Schema.decodeUnknownOption(BriefSchema);

/** The stored brief JSON, or `null` when it isn't the agent's shape. */
function toBrief(value: Value | null): Brief | null {
  return Option.match(decodeBrief(value), {
    onNone: () => null,
    onSome: (brief) => ({
      gaps: (brief.gaps ?? []).flatMap(({ lens, text }) =>
        isCardLens(lens) ? [{ lens, text }] : []
      ),
      glossary: brief.glossary.map((entry) => ({ ...entry })),
      keyDocuments: brief.keyDocuments.map((document) => ({ ...document })),
      modules: brief.modules.map((module) => ({ ...module })),
      product: brief.product,
      stack: [...brief.stack],
    }),
  });
}

const NO_RECORDINGS = { lastAt: null, openQuestions: 0 };

/** A stored project as the screens draw it. */
export function toProjectRecord(
  project: Project,
  overview?: ProjectOverview
): ProjectRecord {
  const name = project.name.trim();
  return {
    brief: toBrief(project.brief),
    briefBuiltAt: project.briefBuiltAt,
    briefState: project.briefState,
    briefTruncated: project.briefTruncated,
    description: project.description,
    id: project.id,
    initial: name.charAt(0).toUpperCase() || "П",
    name,
    notes: project.notes,
    openQuestions: project.openQuestions,
    recordings: overview
      ? {
          lastAt: overview.lastRecordingAt,
          openQuestions: overview.openQuestions,
        }
      : NO_RECORDINGS,
  };
}

/** A stored project as the sidebar and the pickers draw it. */
export function toMockProject(project: Project): MockProject {
  const { description, id, initial, name, openQuestions } =
    toProjectRecord(project);
  return { description, id, initial, name, openQuestions };
}

/* --------------------------------------------------------------- Store */

const readProjects = Effect.gen(function* () {
  const projects = yield* ProjectsData;
  const [list, overview] = yield* Effect.all(
    [projects.list, projects.overview],
    { concurrency: "unbounded" }
  );
  const byProject = new Map(overview.map((item) => [item.projectId, item]));
  return list.map((project) =>
    toProjectRecord(project, byProject.get(project.id))
  );
});

/** What the home table and the sidebar count, besides the project itself. */
const PROJECT_ENTITIES = new Set(["project", "question", "call"]);

const projectsStore = createSyncedStore({
  empty: [] as ProjectRecord[],
  live: inTauri,
  // A project (its brief, people or documents), a question or a call: the
  // sidebar and home count the open questions and the last recording.
  onChange: (change) =>
    PROJECT_ENTITIES.has(change.entity)
      ? { update: Effect.map(readProjects, (list) => () => list) }
      : undefined,
  read: readProjects,
  runtime: appRuntime,
  seed: () => mockSeed().projects.map((project) => toProjectRecord(project)),
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
  notes?: string;
}): Promise<string | undefined> {
  return projectsStore
    .mutate(
      ProjectsData.use((projects) =>
        projects.create({
          description: input.description ?? "",
          name: input.name,
          notes: input.notes ?? "",
        })
      ),
      { error: "Не удалось создать проект" }
    )
    .then((project) => project?.id);
}

/** `initial` follows the name; `openQuestions` is counted by the backend. */
export function updateProject(
  id: string,
  patch: Partial<Pick<ProjectRecord, "description" | "name" | "notes">> &
    Partial<Pick<MockProject, "initial">>
) {
  return projectsStore.mutate(
    ProjectsData.use((projects) =>
      projects.update(id, {
        description: patch.description,
        name: patch.name,
        notes: patch.notes,
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
