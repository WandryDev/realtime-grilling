import { Context, Effect, Layer, Stream } from "effect";

import { type CallSessionChanged, events } from "@/bindings";
import { BackendError, listen } from "@/effect/tauri";

/*
 * The call in progress, shared between windows. In Tauri the start widget,
 * the overlay and the main window are separate webviews: the widget starts
 * a call, the overlay shows it, the main window builds its summary. Every
 * change goes to every window as `CallSessionChanged`; the browser has one
 * page, so the mock shares nothing.
 */
export class CallSessionEvents extends Context.Service<
  CallSessionEvents,
  {
    /** Changes from every window, this one's included. */
    readonly changes: Stream.Stream<CallSessionChanged, BackendError>;
    /** Sends a change of this window to every window. */
    readonly share: (
      change: CallSessionChanged
    ) => Effect.Effect<void, BackendError>;
  }
>()("grill/data/services/CallSessionEvents") {
  static readonly layerTauri = Layer.succeed(CallSessionEvents, {
    changes: listen(events.callSessionChanged),
    share: (change) =>
      Effect.tryPromise({
        catch: (cause) =>
          new BackendError({
            kind: "Transport",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        try: () => events.callSessionChanged.emit(change),
      }),
  });

  static readonly layerMock = Layer.succeed(CallSessionEvents, {
    changes: Stream.never,
    share: () => Effect.void,
  });
}
