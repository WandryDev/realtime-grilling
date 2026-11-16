import { openUrl } from "@tauri-apps/plugin-opener";
import { Context, Effect, Layer } from "effect";

import { CONNECT_DELAY_MS, CONNECTED_ACCOUNTS } from "./mock";

/*
 * Backend contract of the onboarding sign-in that is not a key's: the
 * GitHub device flow, and opening the browser. Outline and ClickUp connect
 * through the `Connectors` data service (`src/data/services/connectors.ts`).
 *
 * GitHub is «скоро» in the app (connectors-clickup design.md, decision 6):
 * its flow is a timer in both layers and only the browser demo reaches it.
 * `openUrl` opens the default browser in the app.
 */

const mockFlows = {
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
