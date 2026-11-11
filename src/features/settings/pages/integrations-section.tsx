"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "@/components/ui/toast";
import { useConnectorSelections } from "@/data/connector-selections";
import {
  disconnectIntegration,
  getIntegrations,
  retryIntegration,
  setIntegration,
  useIntegrations,
} from "@/data/integrations";
import { useProjects } from "@/data/projects";
import type { IntegrationService } from "@/lib/routes";

import { openExternal } from "../api";
import { DisconnectServiceAlertDialog } from "../components/integration-overlays";
import {
  ConnectServiceDialog,
  type ConnectTarget,
} from "../dialogs/connect-service-dialog";
import {
  disconnectOutlineContent,
  GITHUB,
  OUTLINE,
  SERVICE_NAMES,
} from "../mock";
import { IntegrationsSettings } from "../screens/integrations-settings";
import { showUndoToast } from "../toasts";

export type IntegrationsDemo =
  | "outline-broken"
  | "outline-unreachable"
  | "confirm-disconnect"
  | "github-disconnected";

const HOUR_MS = 3_600_000;

/**
 * Disconnects. A demo service offers "Вернуть" with the state from
 * before; Outline's key is gone from Keychain, so it only says so.
 */
async function disconnectWithUndo(service: IntegrationService) {
  const previous = getIntegrations()[service];
  const done = await disconnectIntegration(service);
  if (!done) {
    return;
  }
  if (service === "outline") {
    toast.add({
      description: "Документы Outline остались в проектах с последним текстом",
      title: "Outline отключён",
      type: "success",
    });
    return;
  }
  showUndoToast(`${SERVICE_NAMES[service]} отключён`, () => {
    setIntegration(service, previous);
  });
}

/** Names of the projects that picked Outline's documents. */
function useOutlineProjects() {
  const selections = useConnectorSelections();
  const projects = useProjects();
  return useMemo(() => {
    const ids = new Set(
      selections
        .filter((view) => view.kind === "outline" && view.items.length > 0)
        .map((view) => view.projectId)
    );
    return projects
      .filter((project) => ids.has(project.id))
      .map((project) => project.name);
  }, [projects, selections]);
}

/**
 * Settings → Интеграции in the app, on the integrations store. Demo states
 * put the store into the Paper states: a broken Outline key, the open
 * "Отключить GitHub?" dialog, GitHub just disconnected.
 */
export function IntegrationsSection({ demo }: { demo?: IntegrationsDemo }) {
  const services = useIntegrations();
  const [disconnecting, setDisconnecting] = useState<IntegrationService | null>(
    demo === "confirm-disconnect" ? "github" : null
  );
  const [connectTarget, setConnectTarget] = useState<ConnectTarget | null>(
    null
  );

  // Once per demo value: Strict Mode runs effects twice in development.
  const appliedDemo = useRef<IntegrationsDemo>(undefined);
  useEffect(() => {
    if (!demo || appliedDemo.current === demo) {
      return;
    }
    appliedDemo.current = demo;
    if (demo === "outline-broken") {
      setIntegration("outline", {
        account: OUTLINE.host,
        error: OUTLINE.error,
        errorKind: "unauthorized",
        status: "error",
      });
    } else if (demo === "outline-unreachable") {
      setIntegration("outline", {
        account: OUTLINE.host,
        errorKind: "unreachable",
        lastOkAt: Date.now() - 3 * HOUR_MS,
        status: "connected",
        team: "Pixel Agency",
      });
    } else if (demo === "github-disconnected") {
      disconnectWithUndo("github");
    } else if (demo === "confirm-disconnect") {
      setDisconnecting("github");
    }
  }, [demo]);

  const confirmDisconnect = useCallback(() => {
    if (disconnecting) {
      disconnectWithUndo(disconnecting);
    }
    setDisconnecting(null);
  }, [disconnecting]);

  const handleDisconnectOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setDisconnecting(null);
    }
  }, []);

  const handleConnectOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setConnectTarget(null);
    }
  }, []);

  const connect = useCallback((service: IntegrationService) => {
    setConnectTarget({ reconnect: false, service });
  }, []);

  const reconnect = useCallback((service: IntegrationService) => {
    setConnectTarget({ reconnect: true, service });
  }, []);

  const outlineProjects = useOutlineProjects();
  const disconnectContents = useMemo(
    () => ({ outline: disconnectOutlineContent(outlineProjects) }),
    [outlineProjects]
  );
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async (service: IntegrationService) => {
    setRetrying(true);
    await retryIntegration(service);
    setRetrying(false);
  }, []);

  const changeAccess = useCallback(async (service: IntegrationService) => {
    if (service !== "github") {
      return;
    }
    await openExternal(GITHUB.accessUrl);
    toast.add({
      description: "Выберите репозитории, Grill подхватит их сам",
      title: "Открыли github.com в браузере",
      type: "info",
    });
  }, []);

  return (
    <>
      <IntegrationsSettings
        onChangeAccess={changeAccess}
        onConnect={connect}
        onDisconnect={setDisconnecting}
        onReconnect={reconnect}
        onRetry={retry}
        outlineProjects={outlineProjects}
        retrying={retrying}
        services={services}
      />
      <DisconnectServiceAlertDialog
        contents={disconnectContents}
        onConfirm={confirmDisconnect}
        onOpenChange={handleDisconnectOpenChange}
        service={disconnecting}
      />
      <ConnectServiceDialog
        onOpenChange={handleConnectOpenChange}
        target={connectTarget}
      />
    </>
  );
}
