/*
 * Demo data of the project screens: home, the new project wizard, the project
 * page and the people of the client. Text is verbatim from Paper, page
 * "Проекты и настройки".
 */

import { type MockProject, PROJECTS } from "@/features/mock/projects";

export type SourceKind = "outline" | "github" | "clickup";

/* ------------------------------------------------------------------ Home */

export interface HomeProject {
  description: string;
  id: string;
  initial: string;
  /** Last call: when and with whom. Null when there were no calls yet. */
  lastCall: { people: string; when: string } | null;
  name: string;
  /** Open questions. `fresh`: new ones appeared after the last call. */
  open: { count: number; fresh?: boolean; note?: string } | null;
  /** Connected sources with the hover hint, "Outline, коллекция Телемедиа". */
  sources: { hint: string; kind: SourceKind }[];
}

export const HOME_PROJECTS: HomeProject[] = [
  {
    description: "Приём звонков для сети клиник, интеграция с amoCRM",
    id: "telemedia",
    initial: "Т",
    lastCall: { people: "с Ольгой и Игорем", when: "Сегодня, 12:00–12:40" },
    name: "Телемедиа",
    open: { count: 7, fresh: true, note: "из них 2 новых" },
    sources: [
      { hint: "Outline, коллекция Телемедиа", kind: "outline" },
      { hint: "GitHub, 2 репозитория", kind: "github" },
      { hint: "ClickUp, список «Телемедиа, этап 1»", kind: "clickup" },
    ],
  },
  {
    description: "Онлайн-запись и напоминания владельцам питомцев",
    id: "lapa",
    initial: "В",
    lastCall: { people: "с Натальей", when: "Вчера, 16:30–17:05" },
    name: "Ветклиника Лапа",
    open: { count: 3 },
    sources: [
      { hint: "Outline, коллекция Лапа", kind: "outline" },
      { hint: "GitHub, 1 репозиторий", kind: "github" },
    ],
  },
  {
    description: "Кабинет водителя и трекинг рейсов",
    id: "logistic-pro",
    initial: "Л",
    lastCall: { people: "с Сергеем и Ниной", when: "14 октября, 11:00–11:50" },
    name: "Логистик Про",
    open: null,
    sources: [{ hint: "ClickUp, список «Логистик Про»", kind: "clickup" }],
  },
  {
    description: "Расписание танцевальной школы и абонементы",
    id: "rhythm",
    initial: "Ш",
    lastCall: null,
    name: "Школа Ритм",
    open: { count: 1, note: "из ClickUp" },
    sources: [
      { hint: "Outline, коллекция Школа Ритм", kind: "outline" },
      { hint: "ClickUp, список «Школа Ритм»", kind: "clickup" },
    ],
  },
];

export type CallStatus =
  /** Unreviewed suggestions: an orange pill. */
  | { kind: "proposals"; label: string }
  /** Suggestions wait, as plain accent text. */
  | { kind: "waiting"; label: string }
  | { kind: "muted"; label: string };

export interface CallSummary {
  duration: string;
  /** Unreviewed suggestions: the row is highlighted. */
  highlighted?: boolean;
  /** Where the row leads instead of `callHref` (a live call: its screen). */
  href?: string;
  id: string;
  people: string;
  project?: string;
  /** Project of the call on home, to hide calls of deleted projects. */
  projectId?: string;
  status: CallStatus;
  topic: string;
  /** Mono date and time, "сегодня 12:00". */
  when: string;
}

export const RECENT_CALLS: CallSummary[] = [
  {
    duration: "40:12",
    highlighted: true,
    // The call the demo records (CURRENT_CALL_ID): post-call has its data.
    id: "telemedia-19-oct",
    people: "Ольга, Игорь",
    project: "Телемедиа",
    projectId: "telemedia",
    status: { kind: "proposals", label: "3 предложения к брифу" },
    topic: "Приём звонков, интеграция с CRM",
    when: "сегодня 12:00",
  },
  {
    duration: "34:50",
    id: "lapa-yesterday",
    people: "Наталья",
    project: "Ветклиника Лапа",
    projectId: "lapa",
    status: { kind: "muted", label: "разобран" },
    topic: "Напоминания о прививках",
    when: "вчера 16:30",
  },
  {
    duration: "51:03",
    id: "logistic-oct-14",
    people: "Сергей, Нина",
    project: "Логистик Про",
    projectId: "logistic-pro",
    status: { kind: "muted", label: "разобран" },
    topic: "Кабинет водителя, путевые листы",
    when: "14 окт 11:00",
  },
];

export const FIRST_RUN_STEPS: {
  description: string;
  sources?: SourceKind[];
  title: string;
}[] = [
  {
    description: "Outline, GitHub, ClickUp. Всё по желанию, можно без них.",
    sources: ["outline", "github", "clickup"],
    title: "Название и источники",
  },
  {
    description:
      "Кто на звонках и насколько он в теме. От этого зависит, как звучат вопросы.",
    title: "Люди клиента",
  },
  {
    description:
      "Включите Zoom или Meet как обычно. Grill появится сам, печатать ничего не нужно.",
    title: "Звонок",
  },
];

/* ---------------------------------------------------------------- Wizard */

export const WIZARD_STEPS = [
  { description: "Название и описание", id: "project", title: "Проект" },
  {
    description: "Outline, GitHub, ClickUp",
    id: "sources",
    title: "Источники",
  },
  { description: "Кто будет на звонках", id: "people", title: "Люди клиента" },
  {
    description: "То, чего нет в документах",
    id: "notes",
    title: "Заметки менеджера",
  },
  { description: "Агент собирает сам", id: "brief", title: "Бриф" },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]["id"];

/** Sidebar while the wizard runs: the new project isn't in the list yet. */
export const WIZARD_SIDEBAR_PROJECTS: MockProject[] = PROJECTS.filter(
  (project) => project.id !== "telemedia"
);

/** Sidebar once the brief is ready: the project is saved, no questions yet. */
export const READY_SIDEBAR_PROJECTS: MockProject[] = [
  ...WIZARD_SIDEBAR_PROJECTS,
  {
    description: "Приём звонков для сети клиник, интеграция с amoCRM",
    id: "telemedia",
    initial: "Т",
    name: "Телемедиа",
    openQuestions: 0,
  },
];

export const NEW_PROJECT_DRAFT = {
  description:
    "Сеть частных клиник в Киеве и Львове. Делаем систему приёма звонков от пациентов: очередь операторов, карточка пациента при входящем звонке, запись звонков в amoCRM. Первый этап до конца ноября.",
  name: "Телемедиа",
};

export const WIZARD_REPOS = [
  {
    checked: true,
    meta: "TypeScript, обновлён вчера",
    name: "telemedia/backend",
  },
  { checked: true, meta: "Vue, обновлён 3 дня назад", name: "telemedia/web" },
  { checked: false, meta: "Kotlin, архив", name: "telemedia/mobile" },
  {
    checked: false,
    meta: "Terraform, обновлён месяц назад",
    name: "telemedia/infra",
  },
];

export type TechLevel = "none" | "medium" | "tech";

export const WIZARD_PEOPLE = [
  {
    initials: "ОД",
    name: "Ольга Демченко",
    role: "CEO, принимает решения по бюджету и срокам",
    tag: "не технарь",
  },
  {
    initials: "ИС",
    name: "Игорь Савчук",
    role: "Техлид, отвечает за amoCRM и телефонию",
    tag: "технарь",
  },
];

export const QUICK_TECH_LEVELS = [
  { label: "не разбирается", value: "none" },
  { label: "средне", value: "medium" },
  { label: "технарь", value: "tech" },
];

export const MANAGER_NOTES = [
  "Ольга торопится с запуском, к 1 декабря обещала инвесторам демо.",
  "Бюджет на телефонию отдельно не обсуждали, тема чувствительная.",
  "Решения по amoCRM принимает Игорь, у подрядчика доступы только через него.",
  "В прошлом проекте их обожгли сроки, поэтому любые оценки лучше давать с запасом.",
  "Мобильное приложение пока не трогаем, хотя Ольга периодически к нему возвращается.",
].join("\n");

export const NOTE_HINTS = [
  "Кто реально принимает решения",
  "О чём лучше не спрашивать",
  "Сроки и дедлайны",
];

export type BriefTaskState = "done" | "working" | "pending";

export const BRIEF_TASKS: {
  detail: string;
  /** The detail is a path, set in mono. */
  mono?: boolean;
  source?: SourceKind;
  state: BriefTaskState;
  title: string;
}[] = [
  {
    detail: "2 человека, 5 заметок",
    state: "done",
    title: "Прочитал описание, заметки и людей",
  },
  {
    detail: "48 документов, 11 взял в бриф",
    source: "outline",
    state: "done",
    title: "Outline, коллекция Телемедиа",
  },
  {
    detail: "telemedia/backend/src/integrations/amocrm",
    mono: true,
    source: "github",
    state: "working",
    title: "GitHub, читаю код",
  },
  {
    detail: "36 задач в списке «Телемедиа, этап 1»",
    source: "clickup",
    state: "pending",
    title: "ClickUp, ищу вопросы к клиенту",
  },
  {
    detail: "Продукт, модули, стек, глоссарий, ключевые документы",
    state: "pending",
    title: "Пишу бриф",
  },
];

export const BRIEF_READY = {
  assumption: {
    detail: "Взял ваш срок. Агент спросит об этом на ближайшем звонке",
    title: "В заметках срок 1 декабря, в Outline «Роадмап» 15 декабря",
  },
  facts: [
    {
      label: "Продукт",
      value:
        "Приём звонков от пациентов сети клиник: очередь операторов, карточка пациента, запись в amoCRM",
    },
    {
      label: "Стек",
      value:
        "Node.js, NestJS, PostgreSQL, Vue 3, Mango Office API, amoCRM API v4",
    },
    { label: "Сроки", value: "Первый этап до 1 декабря" },
  ],
  stats: [
    { label: "документов Outline", value: "11" },
    { label: "репозитория", value: "2" },
    { label: "вопроса ждут клиента", value: "4" },
  ],
};

/* ---------------------------------------------------------- Project page */

export type SourceHealth = "ok" | "error";

export interface SourceStatusItem {
  detail: string;
  health: SourceHealth;
  /** An integration, or the documents from the computer (`file`). */
  kind: SourceKind | "file";
  name: string;
}

export const PROJECT = {
  description:
    "Приём звонков для сети клиник: очередь операторов, карточка пациента, запись в amoCRM",
  id: "telemedia",
  name: "Телемедиа",
};

export const SOURCES_STATUS: SourceStatusItem[] = [
  {
    detail: "Телемедиа, 48 документов",
    health: "ok",
    kind: "outline",
    name: "Outline",
  },
  { detail: "2 репозитория", health: "ok", kind: "github", name: "GitHub" },
  {
    detail: "Телемедиа, этап 1",
    health: "ok",
    kind: "clickup",
    name: "ClickUp",
  },
];

export const SOURCES_STATUS_OUTDATED: SourceStatusItem[] = [
  SOURCES_STATUS[0],
  {
    detail: "нет доступа к telemedia/web",
    health: "error",
    kind: "github",
    name: "GitHub",
  },
  SOURCES_STATUS[2],
];

export const PROPOSALS = {
  /** The call the suggestions come from; "Разобрать" opens its review. */
  callId: "telemedia-19-oct",
  detail:
    "3 правки брифа и 1 правка профиля Ольги. Без вашего подтверждения ничего не меняется",
  title: "4 предложения после звонка сегодня в 12:00",
};

export const PROJECT_ANCHORS = [
  { id: "brief", label: "Бриф" },
  { count: 2, id: "people", label: "Люди" },
  { count: 6, id: "calls", label: "Звонки" },
  { count: 3, id: "sources", label: "Источники" },
  { id: "notes", label: "Заметки" },
];

export const BRIEF = {
  glossary: [
    {
      definition:
        "Оператор, который получает напоминания о пропущенных и раздаёт перезвоны",
      term: "Старший смены",
    },
    {
      definition: "Пациент без карты в клинике, звонит впервые",
      term: "Первичка",
    },
    { definition: "Запись на приём в amoCRM, а не продажа", term: "Сделка" },
  ],
  keyDocuments: [
    {
      kind: "outline" as SourceKind,
      meta: "Outline, обновлён 3 дня назад",
      title: "Архитектура телефонии",
    },
    {
      kind: "outline" as SourceKind,
      meta: "Outline, обновлён неделю назад",
      title: "Роадмап, этап 1",
    },
    {
      kind: "outline" as SourceKind,
      meta: "Outline, обновлён 2 недели назад",
      title: "Сценарии оператора",
    },
    {
      kind: "github" as SourceKind,
      meta: "telemedia/backend",
      mono: true,
      title: "integrations/amocrm",
    },
    {
      kind: "clickup" as SourceKind,
      meta: "CU-517",
      metaMono: true,
      title: "Карточка пациента при входящем",
    },
  ],
  keyDocumentsNote:
    "Агент выбрал 11 из 48 документов. Остальные ищет по ходу звонка.",
  modules: [
    { name: "Очередь операторов", stage: "этап 1" },
    { name: "Карточка пациента при входящем", stage: "этап 1" },
    { name: "Интеграция с amoCRM", stage: "этап 1" },
    { conflict: "противоречие, уточнить", name: "Мобильное приложение" },
  ],
  product:
    "Сеть частных клиник «Телемедиа» теряет до половины звонков пациентов: звонки с сайта уходят на личные телефоны менеджеров. Делаем единую систему приёма: очередь операторов, карточку пациента при входящем звонке и запись звонков в amoCRM. Запуск первого этапа к 1 декабря.",
  stack: ["NestJS", "PostgreSQL", "Vue 3", "amoCRM API v4", "Mango Office"],
};

export const BRIEF_STATUS = {
  fresh: "Обновлён 2 ч назад, перед звонком",
  outdated: "Обновлён 9 дней назад",
  outdatedNotice: {
    detail:
      "С тех пор изменились 7 документов в Outline, 2 задачи в ClickUp и было 23 коммита. Перед ближайшим звонком агент освежит бриф сам, но лучше сделать это заранее.",
    title: "Бриф мог устареть",
  },
  updating: "Обновляю: 3 изменённых документа в Outline и 14 новых коммитов",
  updatingProgress: 38,
};

export interface PersonSummary {
  /** Unreviewed edits of the profile, "1 правка". */
  edits?: string;
  howToAsk: string;
  id: string;
  initials: string;
  name: string;
  /** Understanding of the project, 1–5; `null`: not set. */
  project: number | null;
  role: string;
  /** Technical level, 1–5; `null`: not set. */
  tech: number | null;
}

export const PROJECT_PEOPLE: PersonSummary[] = [
  {
    edits: "1 правка",
    howToAsk:
      "Спрашивать через последствия для бизнеса: деньги, пациенты, сроки. Без терминов.",
    id: "olga",
    initials: "ОД",
    name: "Ольга Демченко",
    project: 3,
    role: "CEO, решает по срокам и бюджету",
    tech: 1,
  },
  {
    howToAsk:
      "Можно сразу про API, поля и форматы. Любит конкретику, не любит «потом решим».",
    id: "igor",
    initials: "ИС",
    name: "Игорь Савчук",
    project: 4,
    role: "Техлид, amoCRM и телефония",
    tech: 5,
  },
];

export const PROJECT_CALLS: CallSummary[] = [
  {
    duration: "40:12",
    highlighted: true,
    id: "telemedia-19-oct",
    people: "Ольга, Игорь",
    status: { kind: "waiting", label: "4 предложения ждут" },
    topic: "Приём звонков, интеграция с CRM",
    when: "сегодня 12:00",
  },
  {
    duration: "28:40",
    id: "telemedia-16-oct",
    people: "Игорь",
    status: { kind: "muted", label: "2 вопроса открыты" },
    topic: "Карточка пациента, что показывать оператору",
    when: "16 окт 12:00",
  },
  {
    duration: "52:05",
    id: "telemedia-9-oct",
    people: "Ольга",
    status: { kind: "muted", label: "разобран" },
    topic: "Знакомство, цели первого этапа",
    when: "9 окт 12:10",
  },
];

export const PROJECT_CALLS_SUMMARY = {
  hidden: 3,
  summary: "6 звонков, 7 открытых вопросов",
};

export const PROJECT_SOURCES: {
  description: string;
  kind: SourceKind;
  mono?: boolean;
  name: string;
  status: string;
}[] = [
  {
    description: "Коллекция «Телемедиа», 48 документов",
    kind: "outline",
    name: "Outline",
    status: "синхронизировано в 12:41",
  },
  {
    description: "telemedia/backend, telemedia/web",
    kind: "github",
    mono: true,
    name: "GitHub",
    status: "синхронизировано в 12:41",
  },
  {
    description: "Клиенты, список «Телемедиа, этап 1»",
    kind: "clickup",
    name: "ClickUp",
    status: "4 вопроса ждут клиента",
  },
];

export const DELETE_PROJECT = {
  contents: [
    { label: "Звонки с расшифровками и итогами", mono: true, value: "6" },
    { label: "Аудиозаписи", mono: true, value: "104 МБ" },
    { label: "Бриф, заметки и профили людей", value: "2 человека" },
  ],
  description:
    "Удаляется только то, что хранится в Grill на этом компьютере. Документы в Outline, код в GitHub и задачи в ClickUp не пострадают.",
};

export const ADD_PERSON = {
  name: "Марина Ковальчук",
  role: "Старший смены",
  tech: "basic",
  techLevels: [
    { label: "не разбирается", value: "none" },
    { label: "базово", value: "basic" },
    { label: "уверенно", value: "confident" },
    { label: "технарь", value: "tech" },
  ],
  understanding: "goals",
  understandingLevels: [
    { label: "впервые слышит", value: "new" },
    { label: "знает цели", value: "goals" },
    { label: "в деталях", value: "details" },
  ],
};

/* ---------------------------------------------------------------- Person */

export const PERSON = {
  askExample: {
    asks: "Звонок должен появиться в CRM сразу или достаточно раз в час?",
    instead: "Нужен ли webhook на событие завершения звонка?",
  },
  askStyle:
    "Простым языком, через последствия для бизнеса: деньги, пациенты, сроки. Без терминов и аббревиатур. Один вопрос за раз, с вариантами ответа.",
  askStyleEdited:
    "Простым языком, через последствия для бизнеса: деньги, пациенты, сроки. Без терминов и аббревиатур. Один вопрос за раз, с вариантами ответа. Про amoCRM и телефонию спрашивать Игоря",
  calls: [
    {
      answered: "Ответила на 5 из 7 вопросов",
      duration: "40:12",
      id: "telemedia-19-oct",
      topic: "Приём звонков, интеграция с CRM",
      when: "сегодня 12:00",
    },
    {
      answered: "Ответила на 9 из 11 вопросов",
      duration: "52:05",
      id: "telemedia-9-oct",
      topic: "Знакомство, цели первого этапа",
      when: "9 окт 12:10",
    },
    {
      answered: "Ответила на 3 из 4 вопросов",
      duration: "18:44",
      id: "telemedia-2-oct",
      topic: "Первый созвон, бюджет",
      when: "2 окт 12:30",
    },
  ],
  firstName: "Ольгой",
  initials: "ОД",
  name: "Ольга Демченко",
  origin: "Ваши заметки и 3 звонка. Последняя правка 9 окт, принята вами",
  portrait: [
    {
      label: "Роль в бизнесе",
      value:
        "Основательница сети, финальное слово по срокам, бюджету и подрядчикам",
    },
    {
      label: "Темперамент",
      value: "Быстрая, эмоциональная, перебивает. Решения принимает на ходу",
    },
    {
      edited:
        "Ценит конкретные сроки и цифры. Раздражается, когда «уходим в технику». Технические решения отдаёт Игорю",
      label: "Характер",
      value:
        "Ценит конкретные сроки и цифры. Раздражается, когда «уходим в технику»",
    },
    {
      label: "Чего ждёт от проекта",
      value: "Перестать терять звонки и показать инвесторам демо к 1 декабря",
    },
  ],
  role: "CEO «Телемедиа», решает по срокам и бюджету",
  scales: {
    project: {
      label: "Понимание проекта",
      level: 3,
      value: "цели знает, детали нет",
    },
    tech: {
      label: "В технике",
      level: 1,
      next: { level: 2, value: "базово" },
      value: "не разбирается",
    },
  },
  suggestion: {
    changes: [
      {
        field: "Характер",
        text: "+ Технические решения отдаёт Игорю, сама в них не вникает",
      },
      {
        field: "Как спрашивать",
        text: "+ Вопросы про amoCRM и телефонию адресовать Игорю, Ольгу спрашивать только про сроки и деньги",
      },
    ],
    quote:
      "«Пусть Игорь решает по amoCRM, я в этом всё равно не разбираюсь», 12:14",
    title: "Предложение после звонка сегодня",
  },
  whom: "Ольги",
};
