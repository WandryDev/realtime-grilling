"use client";

import type { IntegrationService } from "@/lib/routes";

import { createStore } from "./store";

/*
 * Connected work services. Onboarding (step 05) connects them, Settings →
 * Integrations shows and disconnects them, project pages list them as
 * sources.
 */

export type IntegrationStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface IntegrationState {
  /** Account or workspace line, e.g. "dima-kapish, доступ к 12 репозиториям". */
  account?: string;
  /** Problem description when status is "error". */
  error?: string;
  status: IntegrationStatus;
}

export type IntegrationsState = Record<IntegrationService, IntegrationState>;

const INITIAL: IntegrationsState = {
  clickup: { account: "Workspace «Wandry»", status: "connected" },
  github: {
    account: "dima-kapish, доступ к 12 репозиториям",
    status: "connected",
  },
  outline: { account: "wandry.getoutline.com", status: "connected" },
};

const integrationsStore = createStore<IntegrationsState>(INITIAL);

export function useIntegrations() {
  return integrationsStore.use();
}

export function useIntegration(service: IntegrationService) {
  return integrationsStore.use()[service];
}

/** Current states outside React (undo snapshots, async callbacks). */
export function getIntegrations() {
  return integrationsStore.get();
}

export function setIntegration(
  service: IntegrationService,
  next: IntegrationState
) {
  integrationsStore.set((state) => ({ ...state, [service]: next }));
}

export function disconnectIntegration(service: IntegrationService) {
  setIntegration(service, { status: "disconnected" });
}

/** Onboarding starts from a clean slate. */
export function resetIntegrations() {
  integrationsStore.set({
    clickup: { status: "disconnected" },
    github: { status: "disconnected" },
    outline: { status: "disconnected" },
  });
}
