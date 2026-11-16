"use client";

import { Effect } from "effect";

import { toast } from "@/components/ui/toast";
import { type IntegrationState, setIntegration } from "@/data/integrations";
import { type AppServices, appRuntime, runCancelable } from "@/effect/runtime";
import { OnboardingBackend } from "@/features/onboarding/backend";
import type { IntegrationService } from "@/lib/routes";

import { IntegrationsBackend } from "./backend";
import { GITHUB_DEVICE } from "./mock";

/*
 * React-facing side of the onboarding integration steps. The GitHub round
 * trip lives in the IntegrationsBackend Effect service
 * (`./backend.ts`), the clipboard in OnboardingBackend; this module runs
 * them through the app runtime.
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

/* Settings: the browser sign-in of the demo -------------------------- */

/**
 * GitHub from Settings in the browser demo: the row shows «Подключаем…»
 * until the (simulated) sign-in answers. It is «скоро» in the app, which
 * never gets here.
 */
export function connectDemoService(service: "github") {
  setIntegration(service, { status: "connecting" });
  return new Promise<void>((resolve) => {
    schedule(
      service,
      IntegrationsBackend.use((backend) => backend.authorizeGitHub).pipe(
        Effect.andThen((account) =>
          Effect.sync(() => {
            setIntegration(service, connected(account));
            resolve();
          })
        )
      )
    );
  });
}

/* Outline: address and API key ---------------------------------------- */

/*
 * Outline connects through `connectWithKey` (`src/data/integrations.ts`).
 * A refused key leaves this line on the onboarding list, «Исправить».
 */
export const OUTLINE_REJECTED_SUMMARY = "Ключ не подошёл, проверьте его";
export const OUTLINE_UNREACHABLE_SUMMARY = "Адрес не отвечает, проверьте его";

/* ClickUp: personal token --------------------------------------------- */

/*
 * ClickUp connects through `connectWithKey` too, with the workspace picked
 * when the token opens several. A refused token leaves this line on the
 * onboarding list, «Исправить».
 */
export const CLICKUP_REJECTED_SUMMARY = "Токен не подошёл, проверьте его";
