/*
 * Turns the stored entities (projects, people, documents) into what the
 * project screens draw. The demo projects exist only in the mock layer
 * (their ids are readable, never a UUID): they keep the Paper brief, calls
 * and integrations. A project made in the app shows what is stored: its
 * brief with its state, its documents, and empty calls and proposals until
 * those come from the backend (tasks 9 and 10).
 */

import type { Brief, ProjectSource } from "@/bindings";
import type { ClientPerson } from "@/data/people";
import type { ProjectRecord } from "@/data/projects";
import type { MockProject } from "@/features/mock/projects";

import type { BriefView } from "./components/brief-section";
import { documentRowId } from "./components/documents-block";
import type { ScaleValue } from "./components/person-profile";
import type { PersonFormValues } from "./components/project-dialogs";
import type {
  BriefState,
  BriefStatusView,
} from "./components/project-sections";
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

/** A demo project of the mock layer: it keeps the Paper data. */
export function isDemoProject(id: string) {
  return HOME_PROJECTS.some((project) => project.id === id);
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const WHEN = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "long",
});

/** "только что", "5 мин назад", "3 ч назад", "4 ноября, 12:00". */
export function relativeTime(at: number, now: number = Date.now()) {
  const minutes = Math.floor((now - at) / MS_PER_MINUTE);
  if (minutes < 1) {
    return "только что";
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `${minutes} мин назад`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${hours} ч назад`;
  }
  return WHEN.format(at);
}

const SOURCE_NAMES: Record<SourceKind, string> = {
  clickup: "ClickUp",
  github: "GitHub",
  outline: "Outline",
};

/* ------------------------------------------------------------------ Home */

/**
 * Row of the home table. Demo projects keep their demo row; any other shows
 * the open questions and the last recording of `projects_overview`.
 */
export function toHomeProject(
  project: MockProject & Partial<Pick<ProjectRecord, "recordings">>
): HomeProject {
  const demo = HOME_PROJECTS.find((item) => item.id === project.id);
  if (demo) {
    return {
      ...demo,
      description: project.description,
      initial: project.initial,
      name: project.name,
    };
  }
  const { recordings } = project;
  const open = recordings?.openQuestions ?? project.openQuestions;
  const lastAt = recordings?.lastAt ?? null;
  return {
    description: project.description,
    id: project.id,
    initial: project.initial,
    lastCall:
      lastAt === null
        ? null
        : { people: "последняя запись", when: WHEN.format(lastAt) },
    name: project.name,
    open: open ? { count: open } : null,
    sources: [],
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
  /** `null`: nothing built yet. */
  brief: BriefView | null;
  briefStatus: BriefStatusView;
  calls: CallSummary[];
  callsSummary: typeof PROJECT_CALLS_SUMMARY;
  deleteContents: typeof DELETE_PROJECT.contents;
  /** The demo projects: Paper data, integrations connected. */
  demo: boolean;
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

/** 1 документ, 2 документа, 5 документов. */
function documentsCount(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) {
    return `${count} документ`;
  }
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} документа`;
  }
  return `${count} документов`;
}

const OUTDATED_NOTICE = {
  detail:
    "После сборки изменились описание, заметки, люди или документы проекта. Перед ближайшим звонком агент обновит бриф сам, но лучше сделать это заранее.",
  title: "Бриф мог устареть",
};

const TRUNCATED_NOTE =
  "Собран по сокращённым материалам: документы не поместились целиком, агент читал их начало.";

const EXTENSION = /\.[^.]+$/u;

/** A stored brief in the shape the brief section draws. */
export function toBriefView(
  brief: Brief,
  documents: ProjectSource[]
): BriefView {
  const byId = new Map(documents.map((source) => [source.id, source]));
  const keyDocuments = brief.keyDocuments.map((document) => {
    const source = byId.get(document.sourceId);
    return {
      href: source ? `#${documentRowId(source.id)}` : undefined,
      kind: "file" as const,
      meta: source?.name ?? "документ удалён из проекта",
      title: document.title || (source?.name.replace(EXTENSION, "") ?? ""),
    };
  });
  const ready = documents.filter((source) => source.status === "ready");
  let keyDocumentsNote =
    "Документов в проекте нет, бриф собран по описанию, заметкам и людям.";
  if (ready.length > 0) {
    keyDocumentsNote = `Агент выбрал ${keyDocuments.length} из ${documentsCount(ready.length)}.`;
  }
  return {
    glossary: brief.glossary,
    keyDocuments,
    keyDocumentsNote,
    modules: brief.modules.map((module) => ({
      description: module.description || undefined,
      name: module.name,
    })),
    product: brief.product,
    stack: brief.stack,
  };
}

/** The brief state the page shows: a build running wins. */
export function pageBriefState(
  project: Pick<ProjectRecord, "brief" | "briefState">,
  building: boolean
): BriefState {
  if (building || project.briefState === "building") {
    return "updating";
  }
  if (project.briefState === "none" || project.brief === null) {
    return "none";
  }
  return project.briefState;
}

export interface ProjectPageInput {
  /** Finished stages of the build that runs, 0…`stages`. */
  buildStage?: number;
  /** The documents of the project. */
  documents?: ProjectSource[];
  now?: number;
  stages?: number;
}

type PageProject = Pick<MockProject, "id"> &
  Partial<Pick<ProjectRecord, "brief" | "briefBuiltAt" | "briefTruncated">>;

/** Calls of a demo project; a project made in the app has none yet. */
function demoCalls(projectId: string) {
  if (projectId === DEMO_PROJECT_ID) {
    return { calls: PROJECT_CALLS, summary: PROJECT_CALLS_SUMMARY };
  }
  if (!isDemoProject(projectId)) {
    return { calls: [], summary: { hidden: 0, summary: "пока пусто" } };
  }
  const calls = RECENT_CALLS.filter((call) => call.projectId === projectId).map(
    (call) => ({ ...call, project: undefined })
  );
  return {
    calls,
    summary: {
      hidden: 0,
      summary: calls.length > 0 ? callsCount(calls.length) : "пока пусто",
    },
  };
}

/** The head of the brief for a stored project. */
function storedBriefStatus(
  project: PageProject,
  input: ProjectPageInput
): BriefStatusView {
  const stages = input.stages ?? 5;
  const stage = Math.min((input.buildStage ?? 0) + 1, stages);
  const builtAt = project.briefBuiltAt ?? null;
  const built = builtAt === null ? "" : relativeTime(builtAt, input.now);
  return {
    fresh: `Обновлён ${built}`,
    outdated: `Обновлён ${built}`,
    outdatedNotice: OUTDATED_NOTICE,
    truncated: project.briefTruncated ? TRUNCATED_NOTE : undefined,
    updating: `Собираю бриф: этап ${stage} из ${stages}`,
    updatingProgress: Math.round(((stage - 1) / stages) * 100),
  };
}

/** The line under the header: the documents and how many could be read. */
function documentsStatus(documents: ProjectSource[]): SourceStatusItem[] {
  if (documents.length === 0) {
    return [];
  }
  const ready = documents.filter((source) => source.status === "ready");
  return [
    {
      detail: `${documentsCount(documents.length)}, прочитано ${ready.length}`,
      health: ready.length === documents.length ? "ok" : "error",
      kind: "file",
      name: "Документы",
    },
  ];
}

function deleteContentsOf(
  totalCalls: number,
  documents: number,
  people: number
): typeof DELETE_PROJECT.contents {
  return [
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
      label: "Документы с компьютера, их копии",
      mono: true,
      value: String(documents),
    },
    { label: "Бриф, заметки и профили людей", value: peopleCount(people) },
  ];
}

/** The Paper parts of a demo project's page. */
function demoParts(projectId: string, briefState: BriefState) {
  const { sources, status } = projectSources(projectId);
  const isTelemedia = projectId === DEMO_PROJECT_ID;
  const isOutdated = briefState === "outdated";
  return {
    brief: BRIEF,
    briefStatus: BRIEF_STATUS,
    sources,
    sourcesStatus: isOutdated && isTelemedia ? SOURCES_STATUS_OUTDATED : status,
    synced: isOutdated ? SYNCED_OUTDATED : SYNCED_FRESH,
  };
}

/** Everything the project page draws for one project. */
export function projectPageData(
  project: PageProject,
  people: ClientPerson[],
  briefState: BriefState = "fresh",
  input: ProjectPageInput = {}
): ProjectPageData {
  const demo = isDemoProject(project.id);
  const isTelemedia = project.id === DEMO_PROJECT_ID;
  const documents = input.documents ?? [];
  const { calls, summary: callsSummary } = demoCalls(project.id);
  const totalCalls = calls.length + callsSummary.hidden;

  const parts = demo
    ? demoParts(project.id, briefState)
    : {
        brief: project.brief ? toBriefView(project.brief, documents) : null,
        briefStatus: storedBriefStatus(project, input),
        sources: [],
        sourcesStatus: documentsStatus(documents),
        synced: "",
      };

  const anchorCounts: Record<string, number | undefined> = {
    calls: totalCalls,
    people: people.length,
    sources: parts.sources.length + documents.length,
  };
  const anchors = PROJECT_ANCHORS.map((anchor) =>
    anchor.id in anchorCounts
      ? { ...anchor, count: anchorCounts[anchor.id] }
      : anchor
  );

  return {
    ...parts,
    anchors,
    calls,
    callsSummary,
    deleteContents: isTelemedia
      ? DELETE_PROJECT.contents
      : deleteContentsOf(totalCalls, documents.length, people.length),
    demo,
    people: people.map(toPersonSummary),
    proposals: isTelemedia ? PROPOSALS : null,
  };
}

/** The demo page as drawn in Paper (the /dev/screens previews). */
export function demoProjectPageData(briefState: BriefState = "fresh") {
  return {
    ...projectPageData(PROJECT, [], briefState),
    anchors: PROJECT_ANCHORS.filter((anchor) => anchor.id !== "notes"),
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
  /** The manager's notes; the demo profile has none to show. */
  notes?: string;
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

/** What an unset level reads as. */
export const LEVEL_NOT_SET = "не указано";

/** The name of a level on its scale; "не указано" without one. */
export function levelLabel(labels: readonly string[], level: number | null) {
  if (!level) {
    return LEVEL_NOT_SET;
  }
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
export function defaultHowToAsk(tech: number | null) {
  if (!tech) {
    return "";
  }
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
      level: person.project ?? 0,
      value: levelLabel(PROJECT_LEVEL_LABELS, person.project),
    },
    tech: {
      label: "В технике",
      level: person.tech ?? 0,
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
    notes: person.notes ?? "",
    origin: "Добавлен вами, агент дополнит профиль после звонков",
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

/* -------------------------------------------------- Person dialogs */

const TEMPERAMENT = "Темперамент";
const CHARACTER = "Характер";

/** A person as the fields of "Изменить человека". */
export function personFormValues(person: ClientPerson): PersonFormValues {
  return {
    askStyle: person.askStyle ?? person.howToAsk,
    character: person.portrait?.[CHARACTER] ?? "",
    name: person.name,
    notes: person.notes ?? "",
    project: person.project,
    role: person.role,
    tech: person.tech,
    temperament: person.portrait?.[TEMPERAMENT] ?? "",
  };
}

/**
 * What the person dialogs save. The card's "how to ask" follows the level
 * until the manager writes their own; the portrait keeps its other rows.
 */
export function personFromForm(
  values: PersonFormValues,
  current?: ClientPerson
): Omit<ClientPerson, "id" | "initials" | "projectId"> {
  const portrait: Record<string, string> = { ...current?.portrait };
  for (const [label, value] of [
    [TEMPERAMENT, values.temperament],
    [CHARACTER, values.character],
  ] as const) {
    if (value) {
      portrait[label] = value;
    } else {
      delete portrait[label];
    }
  }
  return {
    askStyle: values.askStyle || undefined,
    howToAsk: values.askStyle || defaultHowToAsk(values.tech),
    name: values.name,
    notes: values.notes || undefined,
    portrait: Object.keys(portrait).length > 0 ? portrait : undefined,
    project: values.project,
    role: values.role,
    suggestion: current?.suggestion,
    tech: values.tech,
  };
}
