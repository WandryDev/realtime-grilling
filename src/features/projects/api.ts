"use client";

import { Effect, Stream } from "effect";

import { toast } from "@/components/ui/toast";
import { createStore } from "@/data/store";
import { runCancelable } from "@/effect/runtime";

import {
  BRIEF_BUILD_STAGES,
  type ExportTarget,
  ProjectsBackend,
} from "./backend";

/*
 * React-facing side of the projects backend. The work itself lives in the
 * ProjectsBackend Effect service (`./backend.ts`); this module runs it
 * through the app runtime and keeps the progress in a store the screens
 * subscribe to.
 */

/* ------------------------------------------------ Сбор брифа (мастер) */

export interface BriefBuild {
  /** Collapsed to the background: a toast tells when it is ready. */
  background: boolean;
  projectName: string;
  /** Finished stages, 0…BRIEF_BUILD_STAGES. */
  stage: number;
  status: "building" | "ready" | "stopped";
}

const buildsStore = createStore<Record<string, BriefBuild>>({});
const cancelBuilds = new Map<string, () => void>();

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

const buildBrief = Effect.fn("buildBrief")(
  function* (projectId: string) {
    const backend = yield* ProjectsBackend;
    yield* backend
      .buildBrief(projectId)
      .pipe(
        Stream.runForEach((stage) =>
          Effect.sync(() => patchBuild(projectId, { stage }))
        )
      );
    patchBuild(projectId, { stage: BRIEF_BUILD_STAGES, status: "ready" });
    const build = buildsStore.get()[projectId];
    if (build?.background) {
      // Stands in for the system notification.
      toast.add({
        description: "Откройте проект, чтобы проверить главное",
        title: `Бриф проекта «${build.projectName}» готов`,
        type: "success",
      });
    }
  },
  (effect, projectId) =>
    effect.pipe(
      Effect.catchTag("BriefError", (error) =>
        Effect.sync(() => {
          patchBuild(projectId, { status: "stopped" });
          toast.add({
            description: error.message,
            title: "Не удалось собрать бриф",
            type: "error",
          });
        })
      ),
      Effect.ensuring(Effect.sync(() => cancelBuilds.delete(projectId)))
    )
);

/**
 * The agent reads the description, Outline, GitHub, ClickUp and writes the
 * brief. Runs outside React so it keeps going when the wizard is left.
 */
export function startBriefBuild(projectId: string, projectName: string) {
  cancelBuild(projectId);
  buildsStore.set((builds) => ({
    ...builds,
    [projectId]: {
      background: false,
      projectName,
      stage: 0,
      status: "building",
    },
  }));
  cancelBuilds.set(projectId, runCancelable(buildBrief(projectId)));
}

/** "Свернуть в фон": the build goes on, a toast tells when it is ready. */
export function sendBriefBuildToBackground(projectId: string) {
  patchBuild(projectId, { background: true });
}

/** "Остановить": the project stays, the brief is left as it is. */
export function stopBriefBuild(projectId: string) {
  cancelBuild(projectId);
  patchBuild(projectId, { status: "stopped" });
}

/* ---------------------------------------------- Обновление брифа (проект) */

/**
 * "Обновить": the agent rereads only what changed. Calls `onDone` when
 * finished; the returned function cancels ("Остановить").
 */
export function refreshBrief(
  projectId: string,
  onDone: () => void
): () => void {
  return runCancelable(
    ProjectsBackend.use((backend) => backend.refreshBrief(projectId)).pipe(
      Effect.tap(() => Effect.sync(onDone)),
      Effect.catchTag("BriefError", (error) =>
        Effect.sync(() =>
          toast.add({
            description: error.message,
            title: "Не удалось обновить бриф",
            type: "error",
          })
        )
      )
    )
  );
}

/* -------------------------------------------------------- Экспорт */

/** Writes Markdown files to a folder the user picks (Finder in Tauri). */
export function exportToMarkdown(what: ExportTarget, projectName: string) {
  runCancelable(
    ProjectsBackend.use((backend) =>
      backend.exportMarkdown(what, projectName)
    ).pipe(
      Effect.tap((folder) =>
        Effect.sync(() =>
          toast.add({
            description: `Папка «${folder}»`,
            title:
              what === "brief"
                ? `Бриф «${projectName}» сохранён в Markdown`
                : `Итоги звонков «${projectName}» сохранены в Markdown`,
            type: "success",
          })
        )
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
