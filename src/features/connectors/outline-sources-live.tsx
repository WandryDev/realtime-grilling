"use client";

import { useCallback, useMemo, useState } from "react";

import type {
  ProjectSource,
  SelectionItem,
  SelectionItemView,
} from "@/bindings";
import {
  setConnectorSelection,
  syncConnector,
  updateConnectorSelection,
  useProjectConnector,
} from "@/data/connector-selections";
import { useIntegration } from "@/data/integrations";
import { useProjectSources } from "@/data/sources";
import {
  ConnectServiceDialog,
  type ConnectTarget,
} from "@/features/settings/dialogs/connect-service-dialog";

import { OutlinePickerDialog } from "./outline-picker";
import { OutlineSourcesBlock } from "./outline-sources";

/*
 * Outline in the sources of a project, on the stores: the connection, the
 * project's selection and its documents. «Подключить» (and «Обновить
 * ключ») opens the connect dialog over the page, so the wizard keeps its
 * draft and its step; once connected, the picker opens. The wizard has no
 * project before its first source: `ensureProject` saves the draft then.
 */

export function OutlineSources({
  className,
  ensureProject,
  projectId,
}: {
  className?: string;
  /** Saves the wizard's draft; its id. */
  ensureProject?: () => Promise<string | null>;
  projectId: string | null;
}) {
  const connection = useIntegration("outline");
  const view = useProjectConnector(projectId, "outline");
  const sources = useProjectSources(projectId);
  const documents = useMemo(
    () => sources.filter((source) => source.origin?.connector === "outline"),
    [sources]
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [connectTarget, setConnectTarget] = useState<ConnectTarget | null>(
    null
  );
  const [syncing, setSyncing] = useState(false);

  const save = useCallback(
    async (items: SelectionItem[]) => {
      const id = projectId ?? (await ensureProject?.()) ?? null;
      if (!id) {
        return false;
      }
      return (await setConnectorSelection(id, "outline", items)) !== undefined;
    },
    [ensureProject, projectId]
  );

  // Each edit starts from the store as it is when it runs: quick crosses
  // queue instead of overwriting each other.
  const editItems = useCallback(
    (change: (items: SelectionItem[]) => SelectionItem[]) => {
      if (projectId) {
        updateConnectorSelection(projectId, "outline", change);
      }
    },
    [projectId]
  );

  const removeItem = useCallback(
    (item: SelectionItemView) => {
      editItems((items) =>
        items.filter((entry) => entry.externalId !== item.externalId)
      );
    },
    [editItems]
  );

  const exclude = useCallback(
    (source: ProjectSource) => {
      const externalId = source.origin?.externalId;
      if (!externalId) {
        return;
      }
      editItems((items) => {
        const picked = items.find((item) => item.externalId === externalId);
        if (picked?.itemKind === "exclude") {
          return items;
        }
        // A document picked by itself leaves the selection; one that came
        // with a collection or a picked document is left out of it.
        return picked
          ? items.filter((item) => item !== picked)
          : [
              ...items,
              {
                externalId,
                itemKind: "exclude",
                title: source.name,
                url: source.origin?.url ?? null,
              },
            ];
      });
    },
    [editItems]
  );

  const sync = useCallback(async () => {
    if (!projectId) {
      return;
    }
    setSyncing(true);
    await syncConnector(projectId, "outline");
    setSyncing(false);
  }, [projectId]);

  const connect = useCallback(() => {
    setConnectTarget({
      reconnect: connection.status === "error",
      service: "outline",
    });
  }, [connection.status]);
  const closeConnect = useCallback((open: boolean) => {
    if (!open) {
      setConnectTarget(null);
    }
  }, []);
  const openPicker = useCallback(() => setPickerOpen(true), []);

  return (
    <>
      <OutlineSourcesBlock
        className={className}
        connection={connection}
        documents={documents}
        onConnect={connect}
        onExclude={exclude}
        onPick={openPicker}
        onRemoveItem={removeItem}
        onSync={sync}
        syncing={syncing || (view?.syncing ?? false)}
        view={view}
      />
      <OutlinePickerDialog
        items={view?.items ?? []}
        onOpenChange={setPickerOpen}
        onSave={save}
        open={pickerOpen}
      />
      <ConnectServiceDialog
        onConnected={openPicker}
        onOpenChange={closeConnect}
        target={connectTarget}
      />
    </>
  );
}
