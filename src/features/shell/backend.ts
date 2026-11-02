import { getCurrentWindow } from "@tauri-apps/api/window";
import { Context, Effect, Layer, Stream } from "effect";

import { commands, events, type WindowLabel } from "@/bindings";
import { BackendError, call, listen } from "@/effect/tauri";

/*
 * What the app shell does with the windows and hears from Rust about this
 * one:
 * - the tray's "Настройки" (and the floating windows) send `Navigate` to
 *   the main window, which opens the route;
 * - a floating window hands over to another window instead of loading a
 *   main-window page into itself (`windows_show`, then it hides);
 * - "Повторить" on the storage error screen opens the database again.
 *
 * The browser has one page and no tray: the mock never emits, and the
 * screens navigate within the page themselves.
 */
export class ShellBackend extends Context.Service<
  ShellBackend,
  {
    /** Routes Rust asks this window to open. */
    readonly navigate: Stream.Stream<string, BackendError>;
    /** Shows a window, with `route` opened there (the main window). */
    readonly show: (
      label: WindowLabel,
      route: string | null
    ) => Effect.Effect<void, BackendError>;
    /** Hides this window (the widget's ×). */
    readonly hide: Effect.Effect<void, BackendError>;
    /** Opens the local database again after it failed at start. */
    readonly reopenStorage: Effect.Effect<void, BackendError>;
  }
>()("grill/features/shell/ShellBackend") {
  static readonly layerTauri = Layer.effect(
    ShellBackend,
    Effect.sync(() => {
      const hide = Effect.tryPromise({
        catch: (cause) =>
          new BackendError({
            kind: "Transport",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
        try: () => getCurrentWindow().hide(),
      });
      return ShellBackend.of({
        hide,
        // Scoped to this window: `Navigate` is sent to one window.
        navigate: Stream.suspend(() =>
          listen(events.navigate(getCurrentWindow()))
        ).pipe(Stream.map((event) => event.route)),
        reopenStorage: call(() => commands.storageReopen()),
        show: (label, route) => call(() => commands.windowsShow(label, route)),
      });
    })
  );

  static readonly layerMock = Layer.succeed(ShellBackend, {
    hide: Effect.void,
    navigate: Stream.never,
    reopenStorage: Effect.void,
    show: () => Effect.void,
  });
}
