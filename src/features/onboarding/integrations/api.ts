"use client";

import { toast } from "@/components/ui/toast";
import {
  disconnectIntegration,
  type IntegrationState,
  setIntegration,
} from "@/data/integrations";
import type { IntegrationService } from "@/lib/routes";

import { GITHUB_DEVICE } from "./mock";

/*
 * Fake backend of the onboarding integration steps. Everything that will be
 * a Tauri command lives here: the GitHub device flow, the Outline key check,
 * the ClickUp OAuth round trip, opening the browser and the clipboard.
 *
 * Connections write to the integrations store (`src/data/integrations.ts`),
 * so the list, the service steps and the summary all read the same state.
 * A pending connection belongs to the data layer, not to a screen: leave
 * the GitHub step while Grill waits for Authorize and the list shows
 * "Ждём браузер" until it flips to "Подключено".
 */

/** How long each fake round trip takes. */
export const CONNECT_DELAY_MS = {
  clickup: 2200,
  github: 2500,
  outline: 1200,
} as const satisfies Record<IntegrationService, number>;

/** What the list shows for each service once it is connected. */
export const CONNECTED_ACCOUNTS = {
  clickup: "Workspace «Pixel Agency», 38 списков",
  github: "dima-kapish, доступ к 12 репозиториям",
  outline: "docs.pixel.agency, 14 коллекций",
} as const satisfies Record<IntegrationService, string>;

const pending = new Map<IntegrationService, ReturnType<typeof setTimeout>>();

function schedule(service: IntegrationService, run: () => void) {
  cancelConnect(service);
  pending.set(
    service,
    setTimeout(() => {
      pending.delete(service);
      run();
    }, CONNECT_DELAY_MS[service])
  );
}

/** Stops waiting for a service; its state is left to the caller. */
export function cancelConnect(service: IntegrationService) {
  const timer = pending.get(service);
  if (timer !== undefined) {
    clearTimeout(timer);
    pending.delete(service);
  }
}

/** Every pending connection, e.g. between tests. */
export function cancelAllConnects() {
  for (const service of [...pending.keys()]) {
    cancelConnect(service);
  }
}

function connected(service: IntegrationService): IntegrationState {
  return { account: CONNECTED_ACCOUNTS[service], status: "connected" };
}

/* Browser and clipboard ------------------------------------------------ */

/** Opens a page in the default browser. Simulated: says so in a toast. */
export function openInBrowser(url: string) {
  toast.add({
    description: url,
    title: "Открыли страницу в браузере",
    type: "info",
  });
}

export async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard is unavailable (no focus, no permission): the toast still
    // tells the user what to paste.
  }
  toast.add({ description: text, title: "Код скопирован", type: "success" });
}

/* GitHub: device flow -------------------------------------------------- */

const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const CODE_HALF_LENGTH = 4;

function randomHalf() {
  let half = "";
  for (let index = 0; index < CODE_HALF_LENGTH; index += 1) {
    half += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return half;
}

/** The first code of the step, the one from the design. */
export const INITIAL_DEVICE_CODE = GITHUB_DEVICE.code;

/** Asks GitHub for a fresh device code. Call from an event handler. */
export function requestGitHubDeviceCode() {
  return `${randomHalf()}-${randomHalf()}`;
}

/*
 * The user opened github.com/login/device: Grill polls GitHub until they
 * press Authorize. Simulated: authorized after a short delay.
 */
export function startGitHubAuthorization() {
  setIntegration("github", { status: "connecting" });
  schedule("github", () => setIntegration("github", connected("github")));
}

/* Outline: address and API key ---------------------------------------- */

export type OutlineCheckResult =
  | { ok: true }
  | { field: "url" | "key"; message: string; ok: false };

/** List line of a service whose key was rejected. */
export const OUTLINE_REJECTED_SUMMARY = "Ключ не подошёл, проверьте его";
const OUTLINE_UNREACHABLE_SUMMARY = "Адрес не отвечает, проверьте его";

// Outline keys look like ol_api_ followed by a long token
const OUTLINE_KEY_PATTERN = /^ol_api_[A-Za-z0-9]{20,}$/u;

/*
 * One auth.info request with the key. Simulated: a host without a dot
 * doesn't answer, a key that isn't ol_api_ + 20 characters gets a 401.
 */
export function connectOutline(
  url: string,
  apiKey: string
): Promise<OutlineCheckResult> {
  setIntegration("outline", { status: "connecting" });
  return new Promise((resolve) => {
    schedule("outline", () => {
      const host = new URL(url).hostname;
      if (!host.includes(".")) {
        setIntegration("outline", {
          error: OUTLINE_UNREACHABLE_SUMMARY,
          status: "error",
        });
        resolve({
          field: "url",
          message: `${host} не отвечает. Проверьте адрес.`,
          ok: false,
        });
        return;
      }
      if (!OUTLINE_KEY_PATTERN.test(apiKey)) {
        setIntegration("outline", {
          error: OUTLINE_REJECTED_SUMMARY,
          status: "error",
        });
        resolve({
          field: "key",
          message:
            "Ключ не подошёл. Скопируйте его целиком или создайте новый.",
          ok: false,
        });
        return;
      }
      setIntegration("outline", connected("outline"));
      resolve({ ok: true });
    });
  });
}

/* ClickUp: OAuth in the browser ---------------------------------------- */

/** List line after the browser sign-in failed. */
export const CLICKUP_DENIED_SUMMARY = "Доступ не выдан, попробуйте снова";

/*
 * Opens ClickUp OAuth in the browser and waits for the redirect to the
 * local address. Simulated: the workspace is connected after a delay.
 */
export function startClickUpAuthorization() {
  openInBrowser("app.clickup.com/api");
  setIntegration("clickup", { status: "connecting" });
  schedule("clickup", () => setIntegration("clickup", connected("clickup")));
}

/** "Отменить" while waiting for the browser. */
export function cancelClickUpAuthorization() {
  cancelConnect("clickup");
  disconnectIntegration("clickup");
}
