"use client";

import { Cause, Exit } from "effect";
import { type MouseEvent, useCallback, useEffect, useState } from "react";

import type { BrowseNode, ConnectorKind, ExternalRef } from "@/bindings";
import { Connectors } from "@/data/services/connectors";
import { backendErrorOf } from "@/data/synced-store";
import { appRuntime, inTauri, runCancelable } from "@/effect/runtime";
import { IntegrationsBackend } from "@/features/onboarding/integrations/backend";

/*
 * React-facing side of the connector screens that don't go through a
 * store: the picker's tree (`connector_browse`) and opening a document of
 * the service in the browser.
 */

export type TreeState =
  | { status: "loading" }
  | { nodes: BrowseNode[]; status: "ready" }
  | { message: string; status: "error" };

async function browse(kind: ConnectorKind, parent: ExternalRef | null) {
  const exit = await appRuntime.runPromiseExit(
    Connectors.use((connectors) => connectors.browse(kind, parent))
  );
  if (Exit.isSuccess(exit)) {
    return { nodes: exit.value, status: "ready" } as const;
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { status: "loading" } as const;
  }
  return { message: backendErrorOf(exit).message, status: "error" } as const;
}

/**
 * The containers of a connected service (`enabled`), read when it mounts;
 * `reload` asks again («Повторить»).
 */
export function useConnectorContainers(kind: ConnectorKind, enabled: boolean) {
  const [state, setState] = useState<TreeState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let current = true;
    setState({ status: "loading" });
    // `attempt` re-runs the read on «Повторить».
    browse(kind, null).then((next) => {
      if (current && attempt >= 0) {
        setState(next);
      }
    });
    return () => {
      current = false;
    };
  }, [attempt, enabled, kind]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { reload, state };
}

/** What is inside a container (Outline: a collection's whole tree). */
export function browseChildren(kind: ConnectorKind, parent: ExternalRef) {
  return browse(kind, parent);
}

/** Opens a page of the service in the default browser. */
export function openServicePage(url: string) {
  runCancelable(IntegrationsBackend.use((backend) => backend.openUrl(url)));
}

/**
 * A link to the service: the app opens it in the default browser, the
 * browser demo follows the `<a target="_blank">` itself.
 */
export function handleServiceLink(event: MouseEvent<HTMLAnchorElement>) {
  if (!inTauri) {
    return;
  }
  event.preventDefault();
  openServicePage(event.currentTarget.href);
}
