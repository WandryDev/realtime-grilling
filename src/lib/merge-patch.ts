import type { Value } from "@/bindings";

/*
 * JSON merge patch (RFC 7386), as `calls_patch_summary` applies it in Rust
 * (`src-tauri/src/storage/json.rs`): an object patch merges key by key and
 * `null` removes a key; anything else replaces the target.
 */

type JsonObject = { [key in string]: Value };

function isObject(value: Value | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `target` with `patch` applied; neither is changed. */
export function mergePatch(target: Value, patch: Value): Value {
  if (!isObject(patch)) {
    return patch;
  }
  const result: JsonObject = isObject(target) ? { ...target } : {};
  for (const [key, change] of Object.entries(patch)) {
    if (change === null) {
      delete result[key];
    } else {
      result[key] = mergePatch(result[key] ?? null, change);
    }
  }
  return result;
}

function sameJson(a: Value | undefined, b: Value | undefined) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The merge patch that turns `before` into `after`, touching only what
 * differs: applied to a newer copy, it keeps the keys others changed.
 * `undefined` when nothing differs. Objects are diffed key by key; a key
 * gone from `after` becomes `null`.
 */
export function diffPatch(before: Value, after: Value): Value | undefined {
  if (!(isObject(before) && isObject(after))) {
    return sameJson(before, after) ? undefined : after;
  }
  const patch: JsonObject = {};
  for (const key of Object.keys(before)) {
    if (!(key in after)) {
      patch[key] = null;
    }
  }
  for (const [key, value] of Object.entries(after)) {
    const previous = before[key];
    if (previous === undefined) {
      patch[key] = value;
      continue;
    }
    const change = diffPatch(previous, value);
    if (change !== undefined) {
      patch[key] = change;
    }
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}
