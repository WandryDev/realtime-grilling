"use client";

// The server's API with its own types (`@grill/analytics-server/api`): the
// web reads, it never writes (spec «Без входа и только чтение»).

import { AnalyticsApi } from "@grill/analytics-server/api";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

/** Where the API is: the page's own origin unless set for development. */
export const apiBase = (): string =>
  process.env.NEXT_PUBLIC_ANALYTICS_API ??
  (typeof window === "undefined" ? "http://localhost" : window.location.origin);

const client = Effect.suspend(() =>
  HttpApiClient.make(AnalyticsApi, { baseUrl: apiBase() })
);

export type Client = Effect.Success<typeof client>;

/** Runs a read with the client. */
export const read = <A, E>(
  load: (api: Client) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    client.pipe(Effect.flatMap(load), Effect.provide(FetchHttpClient.layer))
  );

/** Whether a failed read was a «not found». */
export const isNotFound = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { _tag: unknown })._tag === "NotFound";
