"use client";

import { useCallback, useMemo, useState } from "react";

import type {
  ProjectSource,
  SelectionItem,
  SelectionItemView,
} from "@/bindings";
import {
  saveConnectorSelection,
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

import { ConnectorPickerDialog } from "./connector-picker";
import { ConnectorSourcesBlock } from "./connector-sources";
import type { SourceConnector } from "./labels";

/*
 * A connector (Outline, ClickUp) in the sources of a project, on the
 * stores: the connection, the project's selection and its documents.
 * «Подключить» (and «Обновить ключ» / «Обновить токен») opens the connect
 * dialog over the page, so the wizard keeps its draft and its step; once
 * connected, the picker opens. The wizard has no project before its first
 * source: `ensureProject` saves the draft then.
 */

const NO_ITEMS: SelectionItemView[] = [];

export function ConnectorSources({
  className,
  ensureProject,
  kind,
  projectId,
}: {
  className?: string;
  /** Saves the wizard's draft; its id. */
  ensureProject?: () => Promise<string | null>;
  kind: SourceConnector;
  projectId: string | null;
}) {
  const connection = useIntegration(kind);
  const view = useProjectConnector(projectId, kind);
  const sources = useProjectSources(projectId);
  const documents = useMemo(
    () => sources.filter((source) => source.origin?.connector === kind),
    [kind, sources]
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
        return { saved: false } as const;
      }
      return saveConnectorSelection(id, kind, items);
    },
    [ensureProject, kind, projectId]
  );

  // Each edit starts from the store as it is when it runs: quick crosses
  // queue instead of overwriting each other.
  const editItems = useCallback(
    (change: (items: SelectionItem[]) => SelectionItem[]) => {
      if (projectId) {
        updateConnectorSelection(projectId, kind, change);
      }
    },
    [kind, projectId]
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
    await syncConnector(projectId, kind);
    setSyncing(false);
  }, [kind, projectId]);

  const connect = useCallback(() => {
    setConnectTarget({
      reconnect: connection.status === "error",
      service: kind,
    });
  }, [connection.status, kind]);
  const closeConnect = useCallback((open: boolean) => {
    if (!open) {
      setConnectTarget(null);
    }
  }, []);
  const openPicker = useCallback(() => setPickerOpen(true), []);

  return (
    <>
      <ConnectorSourcesBlock
        className={className}
        connection={connection}
        documents={documents}
        kind={kind}
        onConnect={connect}
        onExclude={exclude}
        onPick={openPicker}
        onRemoveItem={removeItem}
        onSync={sync}
        syncing={syncing || (view?.syncing ?? false)}
        view={view}
      />
      <ConnectorPickerDialog
        items={view?.items ?? NO_ITEMS}
        kind={kind}
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
