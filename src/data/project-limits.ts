/*
 * Limits of a project's free text, the same as Rust's `projects_create` /
 * `projects_update` (counted in characters after trimming; one over the
 * limit is `Invalid`). They keep the brief's fixed part well inside the
 * agent's budget.
 */

/** "Заметки менеджера", characters. */
export const NOTES_MAX_CHARS = 50_000;
/** The project's description, characters. */
export const DESCRIPTION_MAX_CHARS = 5000;

export const NOTES_TOO_LONG = "Заметки длиннее 50 000 символов";
export const DESCRIPTION_TOO_LONG = "Описание длиннее 5 000 символов";
/** Under the description fields. */
export const DESCRIPTION_LIMIT_HINT = "До 5 000 символов";

/** Characters as Rust counts them (code points, not UTF-16 units). */
export function charCount(text: string) {
  return Array.from(text).length;
}
