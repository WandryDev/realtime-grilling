"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "@/components/ui/toast";
import {
  disconnectIntegration,
  getIntegrations,
  setIntegration,
  useIntegrations,
} from "@/data/integrations";
import type { IntegrationService } from "@/lib/routes";

import { openExternal } from "../api";
import { DisconnectServiceAlertDialog } from "../components/integration-overlays";
import {
  ConnectServiceDialog,
  type ConnectTarget,
} from "../dialogs/connect-service-dialog";
import { GITHUB, OUTLINE, SERVICE_NAMES } from "../mock";
import { IntegrationsSettings } from "../screens/integrations-settings";
import { showUndoToast } from "../toasts";

export type IntegrationsDemo =
  | "outline-broken"
  | "confirm-disconnect"
  | "github-disconnected";

/** Disconnects and offers "Вернуть" with the state from before. */
function disconnectWithUndo(service: IntegrationService) {
  const previous = getIntegrations()[service];
  disconnectIntegration(service);
  showUndoToast(`${SERVICE_NAMES[service]} отключён`, () => {
    setIntegration(service, previous);
  });
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
        status: "error",
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
        services={services}
      />
      <DisconnectServiceAlertDialog
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
