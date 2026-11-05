import type { Proposal } from "@/bindings";

/*
 * The fields a proposal of the summary updates (`knowledge-proposals`), as
 * the review and the person's page name them: the brief's `product`,
 * `stack`, `modules`, `glossary`; a person's `role`, `tech`, `project`,
 * `howToAsk`, `notes` and `portrait:<label>`.
 */

const BRIEF_FIELDS: Record<string, string> = {
  glossary: "Глоссарий",
  modules: "Модули",
  product: "Продукт",
  stack: "Стек",
};

const PERSON_FIELDS: Record<string, string> = {
  howToAsk: "Как формулировать вопросы",
  notes: "Заметки",
  project: "Понимание проекта",
  role: "Роль",
  tech: "Технический уровень",
};

const PORTRAIT = "portrait:";
const LEVELS = new Set(["tech", "project"]);

/** «Раздел «Глоссарий»» of the brief, «Технический уровень» of a person. */
export function proposalSection(proposal: Pick<Proposal, "field" | "target">) {
  const { field } = proposal;
  if (proposal.target === "brief") {
    return `Раздел «${BRIEF_FIELDS[field] ?? field}»`;
  }
  if (field.startsWith(PORTRAIT)) {
    return field.slice(PORTRAIT.length);
  }
  return PERSON_FIELDS[field] ?? field;
}

/** A value as the screens show it: a level 1–5 reads «4 из 5». */
export function proposalValue(field: string, value: string): string;
export function proposalValue(
  field: string,
  value: string | null
): string | null;
export function proposalValue(field: string, value: string | null) {
  if (value === null) {
    return null;
  }
  return LEVELS.has(field) ? `${value} из 5` : value;
}

/** What accepting writes: the manager's text of «Изменить», else the agent's. */
export function proposalText(proposal: Pick<Proposal, "after" | "edited">) {
  return proposal.edited ?? proposal.after;
}

const LEVEL = /[1-5]/u;

/**
 * The manager's text of «Изменить» as it is stored: a level keeps its
 * digit («4 из 5» → `4`), anything else as typed.
 */
export function proposalEdited(field: string, text: string) {
  return LEVELS.has(field) ? (LEVEL.exec(text)?.[0] ?? text) : text;
}
