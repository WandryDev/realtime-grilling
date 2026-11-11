"use client";

import { Effect } from "effect";

import type {
  ConnectorKind,
  ProjectConnectorView,
  SelectionItem,
} from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";

import { Connectors } from "./services/connectors";
import { ProjectsData } from "./services/projects";
import { createSyncedStore } from "./synced-store";

/*
 * What each project picked in the connectors (Outline's collections and
 * documents) with the state of its last sync. The project page and the
 * wizard draw it next to the documents; Settings names the projects a
 * disconnect touches.
 *
 * Rust sends `connectorSelections` when a selection or its sync state
 * changes, but a sync that changed the sources sends only the project's
 * event: the store re-reads the project on both. A connect or a
 * disconnect changes `connected` of every selection: it reads all again.
 */

const readAll = Effect.gen(function* () {
  const projects = yield* ProjectsData;
  const connectors = yield* Connectors;
  const list = yield* projects.list;
  const perProject = yield* Effect.forEach(
    list,
    (project) => connectors.selectionGet(project.id),
    { concurrency: "unbounded" }
  );
  return perProject.flat();
});

const rereadProject = (projectId: string) =>
  Connectors.use((connectors) => connectors.selectionGet(projectId)).pipe(
    // A deleted project has no selection left.
    Effect.catchTag("BackendError", (error) =>
      error.kind === "NotFound" ? Effect.succeed([]) : Effect.fail(error)
    ),
    Effect.map(
      (list) => (current: ProjectConnectorView[]) =>
        current.filter((view) => view.projectId !== projectId).concat(list)
    )
  );

const selectionsStore = createSyncedStore({
  empty: [] as ProjectConnectorView[],
  live: inTauri,
  onChange: (change) => {
    if (change.entity === "connections") {
      return { update: Effect.map(readAll, (list) => () => list) };
    }
    const concernsProject =
      change.entity === "connectorSelections" || change.entity === "project";
    return concernsProject && change.projectId
      ? { scope: change.projectId, update: rereadProject(change.projectId) }
      : undefined;
  },
  read: readAll,
  runtime: appRuntime,
  // The demo projects have picked nothing.
  seed: () => [],
});

/** The project's selection in a connector; `undefined` before any. */
export function useProjectConnector(
  projectId: string | null | undefined,
  kind: ConnectorKind
): ProjectConnectorView | undefined {
  const views = selectionsStore.use();
  return views.find(
    (view) => view.projectId === projectId && view.kind === kind
  );
}

/** Every project's selections, e.g. to name what a disconnect touches. */
export function useConnectorSelections() {
  return selectionsStore.use();
}

/**
 * Replaces the project's selection (an empty list removes it); Rust
 * syncs it in the background. `undefined` when it failed (a toast says
 * why, e.g. more than 200 documents).
 */
export function setConnectorSelection(
  projectId: string,
  kind: ConnectorKind,
  items: SelectionItem[]
) {
  return selectionsStore.mutate(
    Connectors.use((connectors) =>
      connectors.selectionSet(projectId, kind, items)
    ),
    { error: "Не удалось сохранить выбор" }
  );
}

/** The edits of each project's selection, one after another. */
const edits = new Map<string, Promise<unknown>>();

function itemsOf(view: ProjectConnectorView | undefined): SelectionItem[] {
  return (view?.items ?? []).map(({ externalId, itemKind, title, url }) => ({
    externalId,
    itemKind,
    title,
    url,
  }));
}

/**
 * Changes the project's selection from what the store has when the edit
 * runs: two quick edits (two crosses) queue, the second starts from the
 * first's result, so none is lost. Resolves like `setConnectorSelection`.
 */
export function updateConnectorSelection(
  projectId: string,
  kind: ConnectorKind,
  change: (items: SelectionItem[]) => SelectionItem[]
): Promise<ProjectConnectorView | undefined> {
  const key = `${projectId}:${kind}`;
  const edit = (edits.get(key) ?? Promise.resolve()).then(() => {
    const current = selectionsStore
      .get()
      .find((view) => view.projectId === projectId && view.kind === kind);
    return setConnectorSelection(projectId, kind, change(itemsOf(current)));
  });
  edits.set(key, edit);
  const forget = () => {
    if (edits.get(key) === edit) {
      edits.delete(key);
    }
  };
  edit.then(forget, forget);
  return edit;
}

/** «Обновить»: resolves when the sync is done. */
export function syncConnector(projectId: string, kind: ConnectorKind) {
  return selectionsStore.mutate(
    Connectors.use((connectors) => connectors.sync(projectId, kind)),
    { error: "Не удалось обновить" }
  );
}

/** Reads the selections again. */
export function refreshConnectorSelections() {
  return selectionsStore.refresh();
}
