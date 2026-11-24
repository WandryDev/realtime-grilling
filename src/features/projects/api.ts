"use client";

import { toast } from "@grill/ui/toast";
import { Effect, Stream } from "effect";
import { useCallback, useEffect, useState } from "react";
import type { SourceAddResult } from "@/bindings";
import { ProjectsData } from "@/data/services/projects";
import { addProjectSources } from "@/data/sources";
import { createStore } from "@/data/store";
import { refreshMockStores } from "@/data/synced-store";
import { appRuntime, inTauri, runCancelable } from "@/effect/runtime";

import {
  BRIEF_BUILD_STAGES,
  type DocumentDrop,
  type ExportTarget,
  endsBuild,
  finishedStages,
  GRILL_LIMIT,
  ProjectsBackend,
} from "./backend";
import type { RejectedDocument } from "./components/documents-block";

/*
 * React-facing side of the projects backend. The work itself lives in the
 * ProjectsBackend Effect service (`./backend.ts`); this module runs it
 * through the app runtime and keeps the progress in stores the screens
 * subscribe to:
 * - the builds started here (`useBriefBuild`): the wizard follows its own
 *   build to "Бриф готов", "Свернуть" leaves it to a toast;
 * - the stages of every build (`useBriefProgress`), whoever started it:
 *   another window, or the start widget before a call.
 *
 * The mock stores don't follow `DataChanged`, so after every stage the
 * mock ones re-read (the project reads `building`, then its new brief).
 * In Tauri the stores follow the events and this does nothing.
 */

/* ------------------------------------------------ Сбор брифа (мастер) */

export interface BriefBuild {
  /** Collapsed to the background: a toast tells when it is ready. */
  background: boolean;
  /**
   * Why it failed (`status: "failed"`); `GRILL_LIMIT` when a threshold of
   * Grill held it back before the agent.
   */
  error?: string;
  projectName: string;
  /** Finished stages, 0…BRIEF_BUILD_STAGES. */
  stage: number;
  status: "building" | "ready" | "stopped" | "failed";
}

const buildsStore = createStore<Record<string, BriefBuild>>({});
const cancelBuilds = new Map<string, () => void>();
/** "Открыть проект" in the toast of a build in the background. */
const openOnReady = new Map<string, () => void>();

export function useBriefBuild(projectId: string | null | undefined) {
  const builds = buildsStore.use();
  return projectId ? builds[projectId] : undefined;
}

function patchBuild(projectId: string, patch: Partial<BriefBuild>) {
  buildsStore.set((builds) => {
    const current = builds[projectId];
    if (!current) {
      return builds;
    }
    return { ...builds, [projectId]: { ...current, ...patch } };
  });
}

function cancelBuild(projectId: string) {
  cancelBuilds.get(projectId)?.();
  cancelBuilds.delete(projectId);
}

/** The build of a deleted project: no state, no toast. */
function forgetBuild(projectId: string) {
  buildsStore.set((builds) => {
    if (!(projectId in builds)) {
      return builds;
    }
    const { [projectId]: _deleted, ...rest } = builds;
    return rest;
  });
  refreshMockStores();
}

/** Whether the project is gone (its build ends with it). */
const projectDeleted = (projectId: string) =>
  ProjectsData.use((projects) => projects.get(projectId)).pipe(
    Effect.match({
      onFailure: (error) => error.kind === "NotFound",
      onSuccess: () => false,
    })
  );

const buildBrief = Effect.fn("buildBrief")(
  function* (projectId: string, overLimit: boolean) {
    const backend = yield* ProjectsBackend;
    yield* backend.buildBrief(projectId, overLimit).pipe(
      Stream.onStart(Effect.sync(refreshMockStores)),
      Stream.runForEach((stage) =>
        Effect.sync(() => {
          patchBuild(projectId, { stage });
          refreshMockStores();
        })
      )
    );
    patchBuild(projectId, { stage: BRIEF_BUILD_STAGES, status: "ready" });
    refreshMockStores();
    const build = buildsStore.get()[projectId];
    const open = openOnReady.get(projectId);
    if (build?.background) {
      // Stands in for the system notification.
      toast.add({
        actionProps: open ? { children: "Открыть", onClick: open } : undefined,
        description: "Откройте проект, чтобы проверить главное",
        title: `Бриф проекта «${build.projectName}» готов`,
        type: "success",
      });
    }
  },
  (effect, projectId) =>
    effect.pipe(
      Effect.catchTag("BriefError", (error) =>
        Effect.gen(function* () {
          // Deleting a project stops its build: nothing to tell about.
          if (yield* projectDeleted(projectId)) {
            forgetBuild(projectId);
            return;
          }
          patchBuild(projectId, { error: error.message, status: "failed" });
          refreshMockStores();
          if (error.message === GRILL_LIMIT) {
            // The wizard and the project page show the threshold and offer
            // «Собрать сверх лимита»; only a build in the background tells.
            if (buildsStore.get()[projectId]?.background) {
              toast.add({
                description:
                  "Бриф можно собрать сверх лимита на странице проекта",
                title: "Бриф не собран: достигнут лимит Grill",
                type: "warning",
              });
            }
            return;
          }
          toast.add({
            description: error.message,
            title: "Не удалось собрать бриф",
            type: "error",
          });
        })
      ),
      // Stopped here ("Остановить"), in another window, or the project was
      // deleted: the old brief stays.
      Effect.catchTag("BriefCancelled", () =>
        Effect.gen(function* () {
          if (yield* projectDeleted(projectId)) {
            forgetBuild(projectId);
            return;
          }
          patchBuild(projectId, { status: "stopped" });
          refreshMockStores();
        })
      ),
      Effect.ensuring(
        Effect.sync(() => {
          cancelBuilds.delete(projectId);
          openOnReady.delete(projectId);
        })
      )
    )
);

/**
 * The agent reads the description, the notes, the people and the
 * documents and writes the brief. Runs outside React, so it keeps going
 * when the screen is left. With `background` a toast tells when it is
 * ready; `onOpen` puts "Открыть" in that toast. `overLimit` is «Собрать
 * сверх лимита»: the thresholds of Grill don't hold it back.
 */
export function startBriefBuild(
  projectId: string,
  projectName: string,
  options: {
    background?: boolean;
    onOpen?: () => void;
    overLimit?: boolean;
  } = {}
) {
  cancelBuild(projectId);
  buildsStore.set((builds) => ({
    ...builds,
    [projectId]: {
      background: options.background ?? false,
      projectName,
      stage: 0,
      status: "building",
    },
  }));
  if (options.onOpen) {
    openOnReady.set(projectId, options.onOpen);
  }
  cancelBuilds.set(
    projectId,
    runCancelable(buildBrief(projectId, options.overLimit ?? false))
  );
}

/** "Свернуть в фон": the build goes on, a toast tells when it is ready. */
export function sendBriefBuildToBackground(
  projectId: string,
  onOpen?: () => void
) {
  patchBuild(projectId, { background: true });
  if (onOpen) {
    openOnReady.set(projectId, onOpen);
  }
}

/** "Остановить": the agent stops, the project keeps its old brief. */
export function stopBriefBuild(projectId: string) {
  cancelBuild(projectId);
  patchBuild(projectId, { status: "stopped" });
  appRuntime
    .runPromise(ProjectsBackend.use((backend) => backend.cancel(projectId)))
    .then(refreshMockStores);
}

/* ------------------------------------------------ Этапы любой сборки */

export interface BriefStageProgress {
  /** Why the last build failed; `null` while it runs or when it didn't. */
  error: string | null;
  /** Finished stages, 0…BRIEF_BUILD_STAGES. */
  finished: number;
  running: boolean;
}

const progressStore = createStore<Record<string, BriefStageProgress>>({});
let followingProgress = false;

/** Starts following `BriefProgress` once, for the whole window. */
function followProgress() {
  if (followingProgress) {
    return;
  }
  followingProgress = true;
  runCancelable(
    ProjectsBackend.use((backend) =>
      Stream.runForEach(backend.progress, (progress) =>
        Effect.sync(() => {
          // Every stage sends its own `done`; only the build's end stops it.
          const running = !endsBuild(progress);
          progressStore.set((current) => ({
            ...current,
            [progress.projectId]: {
              error:
                progress.state.status === "failed"
                  ? progress.state.message
                  : null,
              finished: finishedStages(progress),
              running,
            },
          }));
          refreshMockStores();
        })
      )
    )
  );
}

/**
 * The build of a project that runs now, wherever it was started; the last
 * one stays with `running: false`.
 */
export function useBriefProgress(
  projectId: string | null | undefined
): BriefStageProgress | undefined {
  const progress = progressStore.use();
  useEffect(followProgress, []);
  return projectId ? progress[projectId] : undefined;
}

/**
 * The start widget, shown for a project: Rust refreshes an outdated brief
 * in the background when the agent is ready. The call never waits for it.
 */
export function prepareBrief(projectId: string) {
  followProgress();
  return appRuntime
    .runPromise(
      ProjectsBackend.use((backend) => backend.prepareBrief(projectId))
    )
    .then((started) => {
      refreshMockStores();
      return started;
    });
}

/* -------------------------------------------------------- Документы */

/** "Выбрать файлы": the paths picked in the dialog, `[]` when closed. */
export function pickDocuments(): Promise<string[]> {
  return appRuntime.runPromise(
    ProjectsBackend.use((backend) => backend.pickDocuments)
  );
}

/** Whether files dropped on the window reach the app (Tauri only). */
export const documentDropSupported = inTauri;

/**
 * Files dragged onto the window while `onDrop` is set: `hovering` while
 * they are over it, `onDrop` gets their paths. Nothing in the browser.
 */
export function useDocumentDrop(onDrop: ((paths: string[]) => void) | null) {
  const [hovering, setHovering] = useState(false);
  const enabled = onDrop !== null;

  useEffect(() => {
    if (!(enabled && onDrop)) {
      return;
    }
    const handle = (drop: DocumentDrop) => {
      setHovering(drop.type === "enter");
      if (drop.type === "drop" && drop.paths.length > 0) {
        onDrop(drop.paths);
      }
    };
    const stop = runCancelable(
      ProjectsBackend.use((backend) =>
        Stream.runForEach(backend.documentDrops, (drop) =>
          Effect.sync(() => handle(drop))
        )
      )
    );
    return () => {
      stop();
      setHovering(false);
    };
  }, [enabled, onDrop]);

  return hovering;
}

/** What `project_sources_add` turned away, and what was there already. */
function splitResults(results: SourceAddResult[]) {
  const rejected: RejectedDocument[] = [];
  const duplicates: string[] = [];
  for (const { name, result } of results) {
    if (result.outcome === "rejected") {
      rejected.push({ message: result.message, name });
    } else if (result.outcome === "duplicate") {
      duplicates.push(name);
    }
  }
  return { duplicates, rejected };
}

const NONE_REJECTED = {
  items: [] as RejectedDocument[],
  projectId: null as string | null,
};

/**
 * Adds files to a project and keeps what was not taken, to show next to
 * the list; a duplicate gets a toast. Shared by the page and the wizard;
 * `add` takes the project when it was created just now.
 */
export function useAddDocuments(projectId: string | null) {
  // Kept with the project they were turned away from: another project
  // (the page reused for another id) starts with none.
  const [turnedAway, setTurnedAway] = useState<{
    items: RejectedDocument[];
    projectId: string | null;
  }>(NONE_REJECTED);
  const [adding, setAdding] = useState(false);
  const otherProject = turnedAway.projectId !== projectId;
  if (otherProject && turnedAway !== NONE_REJECTED) {
    // Not shown again when the page comes back to that project.
    setTurnedAway(NONE_REJECTED);
  }
  const rejected = otherProject ? NONE_REJECTED.items : turnedAway.items;

  const add = useCallback(
    async (paths: string[], target: string | null = projectId) => {
      if (!target || paths.length === 0) {
        return;
      }
      setAdding(true);
      const results = await addProjectSources(target, paths);
      setAdding(false);
      if (!results) {
        return;
      }
      const split = splitResults(results);
      setTurnedAway({ items: split.rejected, projectId: target });
      if (split.duplicates.length > 0) {
        toast.add({
          description: split.duplicates.join(", "),
          title: "Эти документы уже в проекте",
          type: "info",
        });
      }
    },
    [projectId]
  );

  return { add, adding, rejected };
}

/* -------------------------------------------------------- Экспорт */

/**
 * The brief as Markdown, in a folder the user picks (Finder in Tauri).
 * The calls' export comes with the post-call work: a note says so.
 */
export function exportToMarkdown(
  what: ExportTarget,
  project: { id: string; name: string }
) {
  if (what === "calls") {
    toast.add({
      description: "Пока итоги можно открыть на странице звонка",
      title: "Экспорт итогов звонков появится позже",
      type: "info",
    });
    return;
  }
  runCancelable(
    ProjectsBackend.use((backend) =>
      backend.exportMarkdown("brief", project)
    ).pipe(
      Effect.tap((path) =>
        Effect.sync(() => {
          // The folder dialog was closed: nothing written, nothing to say.
          if (path === null) {
            return;
          }
          toast.add({
            description: path,
            title: `Бриф «${project.name}» сохранён в Markdown`,
            type: "success",
          });
        })
      ),
      Effect.catchTag("ExportError", (error) =>
        Effect.sync(() =>
          toast.add({
            description: error.message,
            title: "Не удалось сохранить Markdown",
            type: "error",
          })
        )
      )
    )
  );
}
