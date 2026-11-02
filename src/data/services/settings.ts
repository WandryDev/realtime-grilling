import { Context, Effect, Layer, Option, Predicate, Schema } from "effect";

import {
  commands,
  type SettingsUpdateResult,
  type ShortcutError,
  type Value,
} from "@/bindings";
import { type BackendError, call } from "@/effect/tauri";
import { SHORTCUTS } from "@/features/settings/mock";

import { invalid, MOCK_SETTINGS_KEY, MockDatabase } from "./mock-database";

/*
 * App preferences, key → JSON value. Rust acts on `onboardingCompleted`,
 * `launchAtLogin`, `hideOnShare` and `shortcuts` and stores the other keys
 * as given; the frontend merges what it gets over its own defaults.
 */

export type SettingsMap = { [key in string]: Value };

export class SettingsData extends Context.Service<
  SettingsData,
  {
    readonly get: Effect.Effect<SettingsMap, BackendError>;
    /**
     * Writes the given keys and applies their effects. `shortcuts` changes
     * only the actions it names. A shortcut the OS refused keeps its
     * previous keys and comes back in `shortcutErrors`.
     */
    readonly update: (
      patch: SettingsMap
    ) => Effect.Effect<SettingsUpdateResult, BackendError>;
    /** "Готово" in onboarding: Rust also swaps onboarding for the main window. */
    readonly completeOnboarding: Effect.Effect<void, BackendError>;
  }
>()("grill/data/services/SettingsData") {
  static readonly layerTauri = Layer.succeed(SettingsData, {
    completeOnboarding: Effect.asVoid(
      call(() => commands.onboardingComplete())
    ),
    get: call(() => commands.settingsGet()),
    update: (patch) => call(() => commands.settingsUpdate(patch)),
  });

  /*
   * Keeps the values in the mock database and, in the browser, in
   * localStorage, so `bun run dev` remembers them across reloads. "⌘ Space"
   * stands for a shortcut another app holds (Spotlight): it is refused.
   */
  static readonly layerMock = Layer.effect(
    SettingsData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const read = () => ({
        ...MOCK_DEFAULTS,
        ...Object.fromEntries(tables.settings),
      });

      const update = Effect.fnUntraced(function* (patch: SettingsMap) {
        yield* validate(patch);
        const shortcutErrors: ShortcutError[] = [];
        const accepted: SettingsMap = { ...patch };
        if (patch.shortcuts !== undefined) {
          const current = decodeShortcuts(read().shortcuts).pipe(
            Option.getOrElse((): ShortcutKeys => ({}))
          );
          // Like Rust: the patch changes only the actions it names.
          const requested: ShortcutKeys = {
            ...current,
            ...decodeShortcuts(patch.shortcuts).pipe(
              Option.getOrElse((): ShortcutKeys => ({}))
            ),
          };
          const effective: ShortcutKeys = {};
          for (const [action, keys] of Object.entries(requested)) {
            if (keys.join(" ") === TAKEN_BY_SYSTEM) {
              shortcutErrors.push({ action, keys, message: TAKEN_MESSAGE });
              effective[action] = current[action] ?? [];
            } else {
              effective[action] = keys;
            }
          }
          accepted.shortcuts = effective;
        }
        for (const [key, value] of Object.entries(accepted)) {
          tables.settings.set(key, value);
        }
        persist(tables.settings);
        if (Object.keys(patch).length > 0) {
          yield* database.emit("settings", "settings", null, "updated");
        }
        return {
          launchAtLoginError: null,
          settings: read(),
          shortcutErrors,
        } satisfies SettingsUpdateResult;
      });

      return SettingsData.of({
        completeOnboarding: Effect.asVoid(
          update({ [ONBOARDING_COMPLETED]: true })
        ),
        get: Effect.sync(read),
        update,
      });
    })
  );
}

export const ONBOARDING_COMPLETED = "onboardingCompleted";

const BOOLEAN_KEYS = [ONBOARDING_COMPLETED, "launchAtLogin", "hideOnShare"];

/** Defaults of the keys Rust acts on, as `settings_get` returns them. */
const MOCK_DEFAULTS: SettingsMap = {
  [ONBOARDING_COMPLETED]: false,
  hideOnShare: true,
  launchAtLogin: true,
  shortcuts: Object.fromEntries(
    SHORTCUTS.map((shortcut) => [shortcut.id, shortcut.keys])
  ),
};

const TAKEN_BY_SYSTEM = "⌘ Space";
const TAKEN_MESSAGE =
  "Система не дала зарегистрировать сочетание, его занимает другое приложение (Spotlight)";

const Shortcuts = Schema.Record(Schema.String, Schema.Array(Schema.String));
const decodeShortcutsOption = Schema.decodeUnknownOption(Shortcuts);
interface ShortcutKeys {
  [action: string]: string[];
}

const decodeShortcuts = (value: unknown): Option.Option<ShortcutKeys> =>
  Option.map(decodeShortcutsOption(value), (shortcuts) =>
    Object.fromEntries(
      Object.entries(shortcuts).map(([action, keys]) => [action, [...keys]])
    )
  );

/** The type checks of `settings::validate` in Rust. */
const validate = Effect.fnUntraced(function* (patch: SettingsMap) {
  for (const [key, value] of Object.entries(patch)) {
    if (!key.trim()) {
      return yield* invalid("Пустой ключ настройки");
    }
    const valid = BOOLEAN_KEYS.includes(key)
      ? Predicate.isBoolean(value)
      : key !== "shortcuts" || Option.isSome(decodeShortcuts(value));
    if (!valid) {
      return yield* invalid(
        `Неверное значение настройки ${key}: ${JSON.stringify(value)}`
      );
    }
  }
});

function persist(settings: Map<string, Value>) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      MOCK_SETTINGS_KEY,
      JSON.stringify(Object.fromEntries(settings))
    );
  } catch {
    // Storage is unavailable (private mode): values live until reload.
  }
}
