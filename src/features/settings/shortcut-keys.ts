/*
 * Turning keyboard events into the key caps of a global shortcut, in the
 * macOS order ⌃ ⌥ ⇧ ⌘ and then the main key.
 */

const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

const NAMED_KEYS: Record<string, string> = {
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  Backspace: "⌫",
  Delete: "⌦",
  Enter: "↩",
  Space: "Space",
  Tab: "⇥",
};

type ModifierState = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export function heldModifiers(event: ModifierState) {
  const keys: string[] = [];
  if (event.ctrlKey) {
    keys.push("⌃");
  }
  if (event.altKey) {
    keys.push("⌥");
  }
  if (event.shiftKey) {
    keys.push("⇧");
  }
  if (event.metaKey) {
    keys.push("⌘");
  }
  return keys;
}

export function isModifierKey(event: Pick<KeyboardEvent, "key">) {
  return MODIFIER_KEYS.has(event.key);
}

/**
 * The main key's cap. Letters and digits come from `code`, so ⌥ (which
 * changes `key` on macOS) and the Russian layout still give "G", not "©"
 * or "П".
 */
export function mainKeyLabel(event: Pick<KeyboardEvent, "code" | "key">) {
  if (event.code.startsWith("Key")) {
    return event.code.slice("Key".length);
  }
  if (event.code.startsWith("Digit")) {
    return event.code.slice("Digit".length);
  }
  const named = NAMED_KEYS[event.key] ?? NAMED_KEYS[event.code];
  if (named) {
    return named;
  }
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

export function sameKeys(a: string[], b: string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}
