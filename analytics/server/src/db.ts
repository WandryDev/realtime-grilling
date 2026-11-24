// The database (`DATABASE_URL`), migrated before anything reads it.

import { PgClient } from "@effect/sql-pg";
import { Config, Layer, Redacted } from "effect";
import { migrate } from "./migrations";

const Migrated = Layer.effectDiscard(migrate);

/** Postgres from `DATABASE_URL`. */
export const layerPostgres = Migrated.pipe(
  Layer.provideMerge(
    PgClient.layerConfig({ url: Config.Redacted("DATABASE_URL") })
  )
);

/** Postgres at `url` (the tests, `rebuild`). */
export const layerPostgresAt = (url: string) =>
  Migrated.pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))
  );
