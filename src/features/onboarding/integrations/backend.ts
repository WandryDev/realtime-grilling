import { Context, Effect, Layer, Schema } from "effect";

import { CONNECT_DELAY_MS, CONNECTED_ACCOUNTS } from "./mock";

/*
 * Backend contract of the onboarding integration steps: the GitHub device
 * flow, the Outline key check, the ClickUp OAuth round trip and opening the
 * browser. Each connection resolves with the account line the list shows.
 * `layerMock` fakes the round trips with timers; the Tauri layer will run
 * them in Rust.
 */

/** Outline rejected the address or the key; `field` is the one to fix. */
export class OutlineCheckError extends Schema.TaggedError<OutlineCheckError>()(
  "OutlineCheckError",
  { field: Schema.Literals(["url", "key"]), message: Schema.String }
) {}

// Outline keys look like ol_api_ followed by a long token
const OUTLINE_KEY_PATTERN = /^ol_api_[A-Za-z0-9]{20,}$/u;

export class IntegrationsBackend extends Context.Service<
  IntegrationsBackend,
  {
    /** Polls GitHub until the user presses Authorize; the account. */
    readonly authorizeGitHub: Effect.Effect<string>;
    /** One auth.info request with the key; the workspace. */
    readonly connectOutline: (
      url: string,
      apiKey: string
    ) => Effect.Effect<string, OutlineCheckError>;
    /** Waits for the ClickUp OAuth redirect; the workspace. */
    readonly authorizeClickUp: Effect.Effect<string>;
    /** Opens a page in the default browser. */
    readonly openUrl: (url: string) => Effect.Effect<void>;
  }
>()("grill/features/onboarding/integrations/IntegrationsBackend") {
  /*
   * GitHub and ClickUp are authorized after a delay. Outline: a host
   * without a dot doesn't answer, a key that isn't ol_api_ + 20 characters
   * gets a 401.
   */
  static readonly layerMock = Layer.succeed(IntegrationsBackend, {
    authorizeClickUp: Effect.as(
      Effect.sleep(CONNECT_DELAY_MS.clickup),
      CONNECTED_ACCOUNTS.clickup
    ),
    authorizeGitHub: Effect.as(
      Effect.sleep(CONNECT_DELAY_MS.github),
      CONNECTED_ACCOUNTS.github
    ),
    connectOutline: Effect.fn("IntegrationsBackend.connectOutline")(function* (
      url: string,
      apiKey: string
    ) {
      yield* Effect.sleep(CONNECT_DELAY_MS.outline);
      const host = new URL(url).hostname;
      if (!host.includes(".")) {
        return yield* new OutlineCheckError({
          field: "url",
          message: `${host} не отвечает. Проверьте адрес.`,
        });
      }
      if (!OUTLINE_KEY_PATTERN.test(apiKey)) {
        return yield* new OutlineCheckError({
          field: "key",
          message:
            "Ключ не подошёл. Скопируйте его целиком или создайте новый.",
        });
      }
      return CONNECTED_ACCOUNTS.outline;
    }),
    openUrl: (_url: string) => Effect.void,
  });
}
