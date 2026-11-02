/*
 * Turns the stored entities (projects, people) into what the project screens
 * draw. The demo project "Телемедиа" has full data from Paper; other
 * projects get what can be derived plus the demo brief as a placeholder.
 * When the backend arrives this becomes queries for the project's brief,
 * calls and sources.
 */

import type { ClientPerson } from "@/data/people";
import type { MockProject } from "@/features/mock/projects";

import type { ScaleValue } from "./components/person-profile";
import type { BriefState } from "./components/project-sections";
import {
  BRIEF,
  BRIEF_STATUS,
  type CallSummary,
  DELETE_PROJECT,
  HOME_PROJECTS,
  type HomeProject,
  PERSON,
  type PersonSummary,
  PROJECT,
  PROJECT_ANCHORS,
  PROJECT_CALLS,
  PROJECT_CALLS_SUMMARY,
  PROJECT_PEOPLE,
  PROJECT_SOURCES,
  PROPOSALS,
  RECENT_CALLS,
  SOURCES_STATUS,
  SOURCES_STATUS_OUTDATED,
  type SourceKind,
  type SourceStatusItem,
} from "./mock";

/** The project with the full demo data. */
export const DEMO_PROJECT_ID = PROJECT.id;

const SOURCE_NAMES: Record<SourceKind, string> = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
};

/* ------------------------------------------------------------------ Home */

/**
 * Row of the home table. Seed projects keep their demo row; a project made
 * in the wizard was built from the demo sources and has no calls yet.
 */
export function toHomeProject(project: MockProject): HomeProject {
  const demo = HOME_PROJECTS.find((item) => item.id === project.id);
  if (demo) {
    return {
      ...demo,
      description: project.description,
      initial: project.initial,
      name: project.name,
    };
  }
  return {
    description: project.description,
    id: project.id,
    initial: project.initial,
    lastCall: null,
    name: project.name,
    open: project.openQuestions ? { count: project.openQuestions } : null,
    sources: HOME_PROJECTS[0]?.sources ?? [],
  };
}

/** Recent calls of the projects that still exist, with current names. */
export function recentCalls(projects: MockProject[]): CallSummary[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return RECENT_CALLS.flatMap((call) => {
    const project = call.projectId ? byId.get(call.projectId) : undefined;
    return project ? [{ ...call, project: project.name }] : [];
  });
}

/* ---------------------------------------------------------- Project page */

export interface ProjectPageData {
  anchors: typeof PROJECT_ANCHORS;
  brief: typeof BRIEF;
  briefStatus: typeof BRIEF_STATUS;
  calls: CallSummary[];
  callsSummary: typeof PROJECT_CALLS_SUMMARY;
  deleteContents: typeof DELETE_PROJECT.contents;
  people: PersonSummary[];
  proposals: typeof PROPOSALS | null;
  sources: typeof PROJECT_SOURCES;
  sourcesStatus: SourceStatusItem[];
  synced: string;
}

const SYNCED_FRESH = "синхронизировано в 12:41";
const SYNCED_OUTDATED = "синхронизировано 9 дней назад";

/** "Outline, коллекция Лапа" → "коллекция Лапа". */
function hintDetail(hint: string) {
  const [, ...rest] = hint.split(", ");
  return rest.join(", ") || hint;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function projectSources(projectId: string) {
  const demo = HOME_PROJECTS.find((item) => item.id === projectId);
  if (!demo || projectId === DEMO_PROJECT_ID) {
    return { sources: PROJECT_SOURCES, status: SOURCES_STATUS };
  }
  return {
    sources: demo.sources.map((source) => ({
      description: capitalize(hintDetail(source.hint)),
      kind: source.kind,
      name: SOURCE_NAMES[source.kind],
      status: SYNCED_FRESH,
    })),
    status: demo.sources.map(
      (source): SourceStatusItem => ({
        detail: capitalize(hintDetail(source.hint)),
        health: "ok",
        kind: source.kind,
        name: SOURCE_NAMES[source.kind],
      })
    ),
  };
}

/** 1 человек, 2 человека, 5 человек. */
export function peopleCount(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const isFew = mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14);
  const word = isFew ? "человека" : "человек";
  return `${count} ${word}`;
}

/** 1 звонок, 2 звонка, 5 звонков. */
function callsCount(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} звонок`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} звонка`;
  }
  return `${count} звонков`;
}

const PENDING_EDIT = "1 правка";

export function toPersonSummary(person: ClientPerson): PersonSummary {
  return {
    edits: person.suggestion === "pending" ? PENDING_EDIT : undefined,
    howToAsk: person.howToAsk,
    id: person.id,
    initials: person.initials,
    name: person.name,
    project: person.project,
    role: person.role,
    tech: person.tech,
  };
}

/** Everything the project page draws for one project. */
export function projectPageData(
  project: Pick<MockProject, "id">,
  people: ClientPerson[],
  briefState: BriefState = "fresh"
): ProjectPageData {
  const isDemo = project.id === DEMO_PROJECT_ID;
  const isOutdated = briefState === "outdated";
  const { sources, status } = projectSources(project.id);

  const calls = isDemo
    ? PROJECT_CALLS
    : RECENT_CALLS.filter((call) => call.projectId === project.id).map(
        (call) => ({ ...call, project: undefined })
      );
  const hidden = isDemo ? PROJECT_CALLS_SUMMARY.hidden : 0;
  const callsSummary = isDemo
    ? PROJECT_CALLS_SUMMARY
    : {
        hidden,
        summary: calls.length > 0 ? callsCount(calls.length) : "пока пусто",
      };
  const totalCalls = calls.length + hidden;

  const anchorCounts: Record<string, number | undefined> = {
    calls: totalCalls,
    people: people.length,
    sources: sources.length,
  };
  // "Заметки" has no section on the page yet, so the app leaves it out.
  const anchors = PROJECT_ANCHORS.filter((anchor) => anchor.id !== "notes").map(
    (anchor) =>
      anchor.id in anchorCounts
        ? { ...anchor, count: anchorCounts[anchor.id] }
        : anchor
  );

  return {
    anchors,
    brief: BRIEF,
    briefStatus: BRIEF_STATUS,
    calls,
    callsSummary,
    deleteContents: isDemo
      ? DELETE_PROJECT.contents
      : [
          {
            label: "Звонки с расшифровками и итогами",
            mono: true,
            value: String(totalCalls),
          },
          {
            label: "Аудиозаписи",
            mono: true,
            value: totalCalls > 0 ? `${totalCalls * 17} МБ` : "0 МБ",
          },
          {
            label: "Бриф, заметки и профили людей",
            value: peopleCount(people.length),
          },
        ],
    people: people.map(toPersonSummary),
    proposals: isDemo ? PROPOSALS : null,
    sources,
    sourcesStatus: isOutdated && isDemo ? SOURCES_STATUS_OUTDATED : status,
    synced: isOutdated ? SYNCED_OUTDATED : SYNCED_FRESH,
  };
}

/** The demo page as drawn in Paper (the /dev/screens previews). */
export function demoProjectPageData(briefState: BriefState = "fresh") {
  return {
    ...projectPageData(PROJECT, [], briefState),
    anchors: PROJECT_ANCHORS,
    people: PROJECT_PEOPLE,
  };
}

/* ---------------------------------------------------------------- Person */

type DemoPerson = typeof PERSON;

export interface PersonProfile
  extends Omit<
    DemoPerson,
    "askExample" | "calls" | "firstName" | "scales" | "suggestion" | "whom"
  > {
  askExample?: DemoPerson["askExample"];
  calls: DemoPerson["calls"];
  /** "Звонки с Ольгой"; without it the side says "Звонки". */
  firstName?: string;
  scales: { project: ScaleValue; tech: ScaleValue };
  suggestion?: DemoPerson["suggestion"];
  /** "для Ольги" after "Как формулировать вопросы". */
  whom?: string;
}

export const TECH_LEVEL_LABELS = [
  "не разбирается",
  "базово",
  "средне",
  "уверенно",
  "технарь",
] as const;

export const PROJECT_LEVEL_LABELS = [
  "впервые слышит",
  "слышал о целях",
  "цели знает, детали нет",
  "знает детали",
  "в деталях",
] as const;

function levelLabel(labels: readonly string[], level: number) {
  return labels[Math.min(Math.max(level, 1), labels.length) - 1] ?? "";
}

/** Level of a choice in "Новый человек" or the wizard, on the 1–5 scale. */
export const LEVEL_BY_CHOICE: Record<string, number> = {
  basic: 2,
  confident: 4,
  details: 5,
  goals: 3,
  medium: 3,
  new: 1,
  none: 1,
  tech: 5,
};

/** What the agent does by default, from the technical level. */
export function defaultHowToAsk(tech: number) {
  if (tech <= 2) {
    return "Простым языком, через последствия для бизнеса: деньги, сроки, клиенты. Без терминов.";
  }
  if (tech === 3) {
    return "Можно упоминать технику, но объяснять, зачем это бизнесу.";
  }
  return "Можно сразу про API, поля и форматы. Конкретно и по делу.";
}

const PORTRAIT_LABELS = [
  "Роль в бизнесе",
  "Темперамент",
  "Характер",
  "Чего ждёт от проекта",
];
const EMPTY_VALUE = "Пока не заполнено";

function applyEdits(profile: PersonProfile, person: ClientPerson) {
  const portrait = profile.portrait.map((row) => {
    const edited = person.portrait?.[row.label];
    return edited === undefined ? row : { ...row, edited, value: edited };
  });
  const askStyle = person.askStyle ?? profile.askStyle;
  return {
    ...profile,
    askStyle,
    askStyleEdited:
      person.askStyle === undefined ? profile.askStyleEdited : askStyle,
    portrait,
    // Saving the profile writes the portrait; until then keep its own role.
    role: person.portrait ? person.role || profile.role : profile.role,
  };
}

/** The profile page of a person: the demo profile for Ольга, else derived. */
/** The two scales of a person from the stored levels. */
export function personScales(
  person: Pick<ClientPerson, "project" | "tech">
): PersonProfile["scales"] {
  return {
    project: {
      label: "Понимание проекта",
      level: person.project,
      value: levelLabel(PROJECT_LEVEL_LABELS, person.project),
    },
    tech: {
      label: "В технике",
      level: person.tech,
      value: levelLabel(TECH_LEVEL_LABELS, person.tech),
    },
  };
}

export function toPersonProfile(person: ClientPerson): PersonProfile {
  const isDemo = person.projectId === DEMO_PROJECT_ID && person.id === "olga";

  if (isDemo) {
    const accepted = person.suggestion === "accepted";
    const base: PersonProfile = {
      ...PERSON,
      askStyle: accepted ? PERSON.askStyleEdited : PERSON.askStyle,
      origin: accepted
        ? "Ваши заметки и 3 звонка. Последняя правка сегодня, принята вами"
        : PERSON.origin,
      portrait: PERSON.portrait.map((row) =>
        accepted && row.edited ? { ...row, value: row.edited } : row
      ),
      role: PERSON.role,
      scales: personScales(person),
      suggestion:
        person.suggestion === "pending" ? PERSON.suggestion : undefined,
    };
    return applyEdits(base, person);
  }

  const askStyle = person.askStyle ?? person.howToAsk;
  const base: PersonProfile = {
    askStyle,
    askStyleEdited: askStyle,
    calls: [],
    initials: person.initials,
    name: person.name,
    origin: person.notes
      ? `Ваши заметки: ${person.notes}`
      : "Добавлен вами, агент дополнит профиль после звонков",
    portrait: PORTRAIT_LABELS.map((label) => ({
      label,
      value:
        label === "Роль в бизнесе" && person.role ? person.role : EMPTY_VALUE,
    })),
    role: person.role,
    scales: personScales(person),
  };
  return applyEdits(base, person);
}
