"use client";

import { Cause, Exit } from "effect";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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

/** A read that was interrupted: nothing came, «Повторить» asks again. */
const BROWSE_INTERRUPTED = "Загрузка прервалась";

async function browse(
  kind: ConnectorKind,
  parent: ExternalRef | null
): Promise<Exclude<TreeState, { status: "loading" }>> {
  const exit = await appRuntime.runPromiseExit(
    Connectors.use((connectors) => connectors.browse(kind, parent))
  );
  if (Exit.isSuccess(exit)) {
    return { nodes: exit.value, status: "ready" };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) {
    return { message: BROWSE_INTERRUPTED, status: "error" };
  }
  return { message: backendErrorOf(exit).message, status: "error" };
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

/** The containers the picker opened, loaded on demand. */
export interface LazyTree {
  /** Why a container's children did not load, by its id. */
  readonly errors: ReadonlyMap<string, string>;
  /**
   * Loads what is inside a container, once: a load already running or
   * done is not asked again; a failed one is, by calling it again
   * («Повторить»).
   */
  readonly load: (container: BrowseNode) => void;
  /** The children each container loaded, by its id. */
  readonly trees: ReadonlyMap<string, readonly BrowseNode[]>;
}

/**
 * The picker's tree below the top level (connectors-clickup design.md,
 * decision 2): any container loads its children through
 * `browseChildren` when asked, each one at most once at a time.
 */
export function useLazyTree(kind: ConnectorKind): LazyTree {
  const [trees, setTrees] = useState<ReadonlyMap<string, BrowseNode[]>>(
    () => new Map()
  );
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  // Refs, not state: an effect or a quick second click in the same render
  // must already see a load that started.
  const running = useRef(new Set<string>());
  const loaded = useRef(new Set<string>());

  const load = useCallback(
    (container: BrowseNode) => {
      const { id } = container;
      if (running.current.has(id) || loaded.current.has(id)) {
        return;
      }
      running.current.add(id);
      setErrors((current) => withoutKey(current, id));
      browse(kind, { id, kind: "container" }).then((result) => {
        running.current.delete(id);
        // After the picker closed, React drops these updates.
        if (result.status === "ready") {
          loaded.current.add(id);
          setTrees((current) => new Map(current).set(id, result.nodes));
        } else {
          setErrors((current) => new Map(current).set(id, result.message));
        }
      });
    },
    [kind]
  );

  return { errors, load, trees };
}

function withoutKey<V>(map: ReadonlyMap<string, V>, key: string) {
  if (!map.has(key)) {
    return map;
  }
  const next = new Map(map);
  next.delete(key);
  return next;
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
