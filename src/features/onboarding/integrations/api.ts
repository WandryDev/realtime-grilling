"use client";

import { Effect } from "effect";

import { toast } from "@/components/ui/toast";
import {
  disconnectIntegration,
  type IntegrationState,
  setIntegration,
} from "@/data/integrations";
import { type AppServices, appRuntime, runCancelable } from "@/effect/runtime";
import { OnboardingBackend } from "@/features/onboarding/backend";
import type { IntegrationService } from "@/lib/routes";

import { IntegrationsBackend } from "./backend";
import { GITHUB_DEVICE } from "./mock";

/*
 * React-facing side of the onboarding integration steps. The round trips
 * live in the IntegrationsBackend Effect service (`./backend.ts`), the
 * clipboard in OnboardingBackend; this module runs them through the app
 * runtime.
 *
 * Connections write to the integrations store (`src/data/integrations.ts`),
 * so the list, the service steps and the summary all read the same state.
 * A pending connection belongs to the data layer, not to a screen: leave
 * the GitHub step while Grill waits for Authorize and the list shows
 * "Ждём браузер" until it flips to "Подключено".
 */

const pending = new Map<IntegrationService, () => void>();

/** Runs the connection of `service`, replacing the one already pending. */
function schedule(
  service: IntegrationService,
  connect: Effect.Effect<void, never, AppServices>
) {
  cancelConnect(service);
  const cancel = runCancelable(
    connect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (pending.get(service) === cancel) {
            pending.delete(service);
          }
        })
      )
    )
  );
  pending.set(service, cancel);
}

/** Stops waiting for a service; its state is left to the caller. */
export function cancelConnect(service: IntegrationService) {
  const cancel = pending.get(service);
  if (cancel) {
    pending.delete(service);
    cancel();
  }
}

/** Every pending connection, e.g. between tests. */
export function cancelAllConnects() {
  for (const service of [...pending.keys()]) {
    cancelConnect(service);
  }
}

function connected(account: string): IntegrationState {
  return { account, status: "connected" };
}

/* Browser and clipboard ------------------------------------------------ */

/** Opens a page in the default browser and says so in a toast. */
export function openInBrowser(url: string) {
  runCancelable(IntegrationsBackend.use((backend) => backend.openUrl(url)));
  toast.add({
    description: url,
    title: "Открыли страницу в браузере",
    type: "info",
  });
}

export function copyToClipboard(text: string): Promise<void> {
  return appRuntime.runPromise(
    OnboardingBackend.use((backend) => backend.copyText(text)).pipe(
      // Clipboard is unavailable (no focus, no permission): the toast still
      // tells the user what to paste.
      Effect.ignore,
      Effect.andThen(
        Effect.sync(() => {
          toast.add({
            description: text,
            title: "Код скопирован",
            type: "success",
          });
        })
      )
    )
  );
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
 * press Authorize.
 */
export function startGitHubAuthorization() {
  setIntegration("github", { status: "connecting" });
  schedule(
    "github",
    IntegrationsBackend.use((backend) => backend.authorizeGitHub).pipe(
      Effect.map((account) => setIntegration("github", connected(account)))
    )
  );
}

/* Outline: address and API key ---------------------------------------- */

export type OutlineCheckResult =
  | { ok: true }
  | { field: "url" | "key"; message: string; ok: false };

/** List line of a service whose key was rejected. */
export const OUTLINE_REJECTED_SUMMARY = "Ключ не подошёл, проверьте его";
const OUTLINE_UNREACHABLE_SUMMARY = "Адрес не отвечает, проверьте его";

/*
 * One auth.info request with the key: a 401 marks the key, an address that
 * doesn't answer marks the address. Never resolves when cancelled.
 */
export function connectOutline(
  url: string,
  apiKey: string
): Promise<OutlineCheckResult> {
  setIntegration("outline", { status: "connecting" });
  return new Promise((resolve) => {
    schedule(
      "outline",
      IntegrationsBackend.use((backend) =>
        backend.connectOutline(url, apiKey)
      ).pipe(
        Effect.map((account): OutlineCheckResult => {
          setIntegration("outline", connected(account));
          return { ok: true };
        }),
        Effect.catchTag("OutlineCheckError", ({ field, message }) =>
          Effect.sync((): OutlineCheckResult => {
            setIntegration("outline", {
              error:
                field === "url"
                  ? OUTLINE_UNREACHABLE_SUMMARY
                  : OUTLINE_REJECTED_SUMMARY,
              status: "error",
            });
            return { field, message, ok: false };
          })
        ),
        Effect.map(resolve)
      )
    );
  });
}

/* ClickUp: OAuth in the browser ---------------------------------------- */

/** List line after the browser sign-in failed. */
export const CLICKUP_DENIED_SUMMARY = "Доступ не выдан, попробуйте снова";

/*
 * Opens ClickUp OAuth in the browser and waits for the redirect to the
 * local address.
 */
export function startClickUpAuthorization() {
  openInBrowser("app.clickup.com/api");
  setIntegration("clickup", { status: "connecting" });
  schedule(
    "clickup",
    IntegrationsBackend.use((backend) => backend.authorizeClickUp).pipe(
      Effect.map((account) => setIntegration("clickup", connected(account)))
    )
  );
}

/** "Отменить" while waiting for the browser. */
export function cancelClickUpAuthorization() {
  cancelConnect("clickup");
  disconnectIntegration("clickup");
}
