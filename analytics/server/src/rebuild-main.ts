// `bun run rebuild`: the projections of `DATABASE_URL` made again from its
// log.

import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { layerPostgres } from "./db";
import { rebuild } from "./rebuild";

rebuild.pipe(
  Effect.tap((count) =>
    Effect.log(`rebuilt the projections from ${count} events`)
  ),
  Effect.provide(layerPostgres),
  BunRuntime.runMain
);
