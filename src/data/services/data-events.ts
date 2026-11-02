import { Context, Effect, Layer, type Stream } from "effect";

import { type DataChanged, events } from "@/bindings";
import { type BackendError, listen } from "@/effect/tauri";

import { MockDatabase } from "./mock-database";

/*
 * `DataChanged` notifications: Rust sends one to every window after each
 * committed write (another window's writes included); the mock database
 * sends them after its own writes. The stores re-read on them.
 */
export class DataEvents extends Context.Service<
  DataEvents,
  { readonly changes: Stream.Stream<DataChanged, BackendError> }
>()("grill/data/services/DataEvents") {
  static readonly layerTauri = Layer.succeed(DataEvents, {
    changes: listen(events.dataChanged),
  });

  static readonly layerMock = Layer.effect(
    DataEvents,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      return { changes: database.changes };
    })
  );
}
