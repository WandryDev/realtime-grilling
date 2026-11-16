import type { CardLens } from "@/bindings";

/**
 * The seven lenses of a task card (`docs/concept.md`): the backend's ids
 * (`cardField` of a question, `field` of a card field) as the screens show
 * them.
 */
export const CARD_LENS_LABELS: Record<CardLens, string> = {
  acceptance: "Критерии готовности",
  constraints: "Ограничения",
  edgeCases: "Крайние случаи",
  goal: "Цель",
  integrations: "Интеграции",
  scenarios: "Основной сценарий",
  users: "Кто пользуется",
};

/**
 * The lenses as the agent's rules and the brief's «Неясно до звонка» name
 * them (`CardLens::label` in Rust).
 */
export const CARD_LENS_NAMES: Record<CardLens, string> = {
  acceptance: "критерии готовности",
  constraints: "ограничения",
  edgeCases: "крайние случаи",
  goal: "цель",
  integrations: "интеграции",
  scenarios: "сценарии",
  users: "пользователи",
};

/** Whether `value` is the id of a lens: a stored brief is read loosely. */
export function isCardLens(value: string): value is CardLens {
  return Object.hasOwn(CARD_LENS_NAMES, value);
}
