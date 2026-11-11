"use client";

import { Effect, Exit } from "effect";
import { useMemo } from "react";

import type {
  ConnectorKind,
  ConnectorView,
  ErrorKind,
  Workspace,
} from "@/bindings";
import { appRuntime, inTauri } from "@/effect/runtime";
import type { IntegrationService } from "@/lib/routes";

import { Connectors } from "./services/connectors";
import { mockConnections } from "./services/mock-database";
import { createStore } from "./store";
import {
  backendErrorOf,
  createSyncedStore,
  refreshMockStores,
} from "./synced-store";

/*
 * Connected work services (connectors-outline design.md, decision 7).
 * Onboarding (step 05) and Settings → Интеграции connect them, project
 * pages pick their documents.
 *
 * The connections come from the `Connectors` service: Rust in the app,
 * where Outline (address and API key) and ClickUp (personal token, one
 * workspace) work and GitHub is «скоро» (`available: false`); the
 * in-memory demo in the browser. Every window re-reads on the
 * `DataChanged` of `connections`. The adapter below turns a
 * `ConnectorView` into the `IntegrationState` the screens draw.
 *
 * On top of that sit local states a screen sets for a while: «Проверяем
 * ключ» during a connect, a refused key on the onboarding list, and the
 * GitHub demo flow of the browser (its sign-in lives only in the mocks).
 */

export type IntegrationStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface IntegrationState {
  /** Account or workspace line, e.g. "docs.pixel.agency". */
  account?: string;
  /** `false`: «скоро», it can't be connected yet. Absent: available. */
  available?: boolean;
  /**
   * Problem description when status is "error"; with `connected` and
   * errorKind `other`, why the last check failed (e.g. Keychain refused).
   */
  error?: string;
  /**
   * The last failure: with `connected` and `unreachable` the connection
   * stands but the service did not answer («не удалось обновить»).
   */
  errorKind?: ErrorKind | null;
  /** The service's address, with the scheme (Outline). */
  host?: string;
  /** The last time the service answered, ms since the epoch. */
  lastOkAt?: number | null;
  status: IntegrationStatus;
  /** The workspace the key opens (Outline: the team). */
  team?: string;
  /** Whose key or token it is, as the service names them. */
  user?: string;
}

export type IntegrationsState = Record<IntegrationService, IntegrationState>;

const SERVICES: IntegrationService[] = ["github", "outline", "clickup"];

/* Adapter: ConnectorView → IntegrationState ---------------------------- */

export const KEY_REVOKED = "Ключ больше не подходит: истёк или был отозван";
export const TOKEN_REVOKED = "Токен больше не подходит: истёк или был отозван";
const FORBIDDEN: Record<ConnectorKind, string> = {
  clickup: "Нет доступа: у токена не хватает прав",
  github: "Нет доступа: не хватает прав",
  outline: "Нет доступа: у ключа не хватает прав",
};

/** The connectors connected by a key or a token in the app. */
const KEY_SERVICES: ReadonlySet<IntegrationService> = new Set([
  "outline",
  "clickup",
]);

const SERVICE_LABEL: Record<IntegrationService, string> = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
};

/** "https://docs.pixel.agency" → "docs.pixel.agency". */
export function hostLabel(host: string) {
  try {
    return new URL(host).host;
  } catch {
    return host;
  }
}

function errorText(view: ConnectorView) {
  if (view.errorKind === "unauthorized") {
    return view.kind === "clickup" ? TOKEN_REVOKED : KEY_REVOKED;
  }
  if (view.errorKind === "forbidden") {
    return FORBIDDEN[view.kind];
  }
  return view.error ?? "Не работает";
}

function toIntegration(
  kind: ConnectorKind,
  view: ConnectorView | undefined
): IntegrationState {
  if (!view) {
    // Before the first read: in the app GitHub can't be connected yet.
    return {
      available: KEY_SERVICES.has(kind) || !inTauri,
      status: "disconnected",
    };
  }
  const base: IntegrationState = {
    available: view.available,
    errorKind: view.errorKind,
    lastOkAt: view.lastOkAt,
    status: "disconnected",
  };
  if (!view.available || view.status === "disconnected") {
    return base;
  }
  const host = view.account?.host ?? undefined;
  let error: string | undefined;
  if (view.status === "error") {
    error = errorText(view);
  } else if (view.errorKind === "other") {
    error = view.error ?? undefined;
  }
  return {
    ...base,
    account: host ? hostLabel(host) : view.account?.teamName,
    error,
    host,
    status: view.status,
    team: view.account?.teamName,
    user: view.account?.userName ?? undefined,
  };
}

/* Stores ---------------------------------------------------------------- */

const readConnections = Connectors.use((connectors) => connectors.list);

const connectionsStore = createSyncedStore({
  empty: [] as ConnectorView[],
  live: inTauri,
  onChange: (change) =>
    change.entity === "connections"
      ? { update: Effect.map(readConnections, (list) => () => list) }
      : undefined,
  read: readConnections,
  runtime: appRuntime,
  seed: () => [...mockConnections().values()],
});

/** The browser demo starts with GitHub connected. */
const DEMO_OVERRIDES: Partial<IntegrationsState> = {
  github: {
    account: "dima-kapish, доступ к 12 репозиториям",
    status: "connected",
  },
};

const overridesStore = createStore<Partial<IntegrationsState>>(
  inTauri ? {} : DEMO_OVERRIDES
);

function combine(
  views: ConnectorView[],
  overrides: Partial<IntegrationsState>
): IntegrationsState {
  const state = {} as IntegrationsState;
  for (const service of SERVICES) {
    const backend = toIntegration(
      service,
      views.find((view) => view.kind === service)
    );
    const local = overrides[service];
    // «скоро» wins: nothing local makes it connectable.
    state[service] =
      local && backend.available !== false
        ? { ...local, available: true }
        : backend;
  }
  return state;
}

export function useIntegrations(): IntegrationsState {
  const views = connectionsStore.use();
  const overrides = overridesStore.use();
  return useMemo(() => combine(views, overrides), [overrides, views]);
}

export function useIntegration(service: IntegrationService) {
  return useIntegrations()[service];
}

/** Whether the first read in the app is still running. */
export function useIntegrationsLoading() {
  return connectionsStore.useState().status === "loading";
}

/** Current states outside React (undo snapshots, async callbacks). */
export function getIntegrations() {
  return combine(connectionsStore.get(), overridesStore.get());
}

/**
 * A local state over the backend one: the demo flow of GitHub, the forced
 * `?demo=` states, «Проверяем ключ».
 */
export function setIntegration(
  service: IntegrationService,
  next: IntegrationState
) {
  overridesStore.set((state) => ({ ...state, [service]: next }));
}

/** Back to what the backend says. */
export function clearIntegration(service: IntegrationService) {
  overridesStore.set((state) => {
    const { [service]: _cleared, ...rest } = state;
    return rest;
  });
}

/**
 * Disconnects a service: Outline and ClickUp in the backend (their secret
 * leaves Keychain), the GitHub demo locally. Resolves to whether it
 * worked.
 */
export async function disconnectIntegration(service: IntegrationService) {
  if (!KEY_SERVICES.has(service)) {
    setIntegration(service, { status: "disconnected" });
    return true;
  }
  clearIntegration(service);
  const done = await connectionsStore.mutate(
    Connectors.use((connectors) => connectors.disconnect(service)),
    { error: `Не удалось отключить ${SERVICE_LABEL[service]}` }
  );
  return done !== undefined;
}

/**
 * Onboarding starts from a clean slate: the GitHub demo disconnected, the
 * demo Outline and ClickUp too; in the app a real connection stays.
 */
export function resetIntegrations() {
  overridesStore.set({ github: { status: "disconnected" } });
  if (!inTauri) {
    for (const service of KEY_SERVICES) {
      connectionsStore.mutate(
        Connectors.use((connectors) => connectors.disconnect(service))
      );
    }
  }
}

/** Reads the connections again. */
export function refreshIntegrations() {
  return connectionsStore.refresh();
}

/* Connecting by a key ----------------------------------------------------- */

export type ConnectKeyResult =
  | { ok: true; state: IntegrationState }
  /** The service refused: show `message` at `field`. */
  | { field: "host" | "key"; message: string; ok: false }
  /**
   * The token opens several workspaces (ClickUp): nothing was saved, pick
   * one and connect again with the same token.
   */
  | { field: "workspace"; ok: false; workspaces: Workspace[] }
  /** Not saved for another reason (Keychain refused): a general error. */
  | { field: null; message: string; ok: false };

/**
 * Checks the address (Outline) and the key or token with the service, then
 * saves them (also «Обновить ключ» / «Обновить токен»). `workspace` is the
 * one picked after `chooseWorkspace`. The row shows «Проверяем ключ»
 * meanwhile. A refused key changes nothing that was saved.
 */
export async function connectWithKey(
  service: IntegrationService,
  host: string,
  key: string,
  workspace: string | null = null
): Promise<ConnectKeyResult> {
  // Not cancelable: once the check passed, Rust saves the key whether
  // anyone still waits or not, so nothing may say «Отменено». A screen
  // left meanwhile sees the outcome through the store (DataChanged).
  const previous = getIntegrations()[service];
  setIntegration(service, { ...previous, status: "connecting" });
  const exit = await appRuntime.runPromiseExit(
    Connectors.use((connectors) =>
      connectors.connectApiKey(service, host, key, workspace)
    )
  );
  clearIntegration(service);
  if (Exit.isFailure(exit)) {
    return { field: null, message: backendErrorOf(exit).message, ok: false };
  }
  const outcome = exit.value;
  if (outcome.rejected) {
    return {
      field: outcome.rejected.field,
      message: outcome.rejected.reason,
      ok: false,
    };
  }
  if (outcome.chooseWorkspace) {
    return {
      field: "workspace",
      ok: false,
      workspaces: outcome.chooseWorkspace.workspaces,
    };
  }
  await rereadAfterConnect();
  return { ok: true, state: toIntegration(service, outcome.connected) };
}

/**
 * The mock connect synced the projects' selections too: every mock store
 * reads again. In the app the stores follow `DataChanged`.
 */
async function rereadAfterConnect() {
  if (inTauri) {
    await connectionsStore.refresh();
  } else {
    refreshMockStores();
  }
}

/**
 * «Повторить» after the service did not answer: one request to it. Rust
 * records the answer on the connection either way.
 */
export async function retryIntegration(service: IntegrationService) {
  await appRuntime.runPromiseExit(
    Connectors.use((connectors) => connectors.browse(service, null))
  );
  await connectionsStore.refresh();
}
