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
