import { openUrl } from "@tauri-apps/plugin-opener";
import { Context, Effect, Layer } from "effect";

import { CONNECT_DELAY_MS, CONNECTED_ACCOUNTS } from "./mock";

/*
 * Backend contract of the onboarding sign-ins that are not Outline's: the
 * GitHub device flow, the ClickUp OAuth round trip, and opening the
 * browser. Outline connects through the `Connectors` data service
 * (`src/data/services/connectors.ts`).
 *
 * GitHub and ClickUp are «скоро» in the app (connectors-outline design.md,
 * decision 7): their flows are timers in both layers and only the browser
 * demo reaches them. `openUrl` opens the default browser in the app.
 */

const mockFlows = {
  authorizeClickUp: Effect.as(
    Effect.sleep(CONNECT_DELAY_MS.clickup),
    CONNECTED_ACCOUNTS.clickup
  ),
  authorizeGitHub: Effect.as(
    Effect.sleep(CONNECT_DELAY_MS.github),
    CONNECTED_ACCOUNTS.github
  ),
};

export class IntegrationsBackend extends Context.Service<
  IntegrationsBackend,
  {
    /** Polls GitHub until the user presses Authorize; the account. */
    readonly authorizeGitHub: Effect.Effect<string>;
    /** Waits for the ClickUp OAuth redirect; the workspace. */
    readonly authorizeClickUp: Effect.Effect<string>;
    /** Opens a page in the default browser. */
    readonly openUrl: (url: string) => Effect.Effect<void>;
  }
>()("grill/features/onboarding/integrations/IntegrationsBackend") {
  static readonly layerMock = Layer.succeed(IntegrationsBackend, {
    ...mockFlows,
    openUrl: (_url: string) => Effect.void,
  });

  static readonly layerTauri = Layer.succeed(IntegrationsBackend, {
    ...mockFlows,
    // A browser that doesn't open has nothing to report back.
    openUrl: (url: string) =>
      Effect.ignore(Effect.tryPromise(() => openUrl(url))),
  });
}
