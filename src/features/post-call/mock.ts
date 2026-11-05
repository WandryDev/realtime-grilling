/*
 * Demo data of the after-call flow ("После звонка" in Paper): the Телемедиа
 * call of 19 October, its summary, task cards, proposals, transcript, and
 * the call history. Text is verbatim from the artboards; screens take it as
 * prop defaults.
 */

import { PROJECTS } from "@/features/mock/projects";
import { CARD_LENS_LABELS } from "@/lib/card-lens";

/* ------------------------------------------------------------ Звонок */

export const CALL = {
  dateLabel: "19 октября, 12:01",
  duration: "40:12",
  participants: "Ольга Демченко, Игорь Савчук",
  project: "Телемедиа",
  subtitle: "звонок 19 октября",
  taskCards: 2,
} as const;

export interface CallFact {
  label: string;
  value: string;
}

export const CALL_FACTS: CallFact[] = [
  { label: "Когда", value: "19 октября, 12:01–12:41" },
  { label: "Участники", value: "Ольга Демченко, Игорь Савчук и вы" },
  { label: "Запись", value: "Opus, 2 канала, 13 МБ" },
];

/* ------------------------------------------------- 01 Сборка итогов */

export type ProcessingStepStatus = "done" | "active" | "waiting";

export interface ProcessingStepData {
  description: string;
  id: string;
  /** Duration of a finished step or progress of the active one. */
  meta?: string;
  /** Percent of the active step. */
  progress?: number;
  status: ProcessingStepStatus;
  title: string;
}

export const PROCESSING_STEPS: ProcessingStepData[] = [
  {
    description: "412 реплик, 2 темы, вы и клиент по отдельным каналам",
    id: "transcript",
    meta: "0:08",
    status: "done",
    title: "Расшифровка готова",
  },
  {
    description: "«Приём звонков» готова, сейчас «Интеграция с CRM»",
    id: "task-cards",
    meta: "1 из 2",
    progress: 55,
    status: "active",
    title: "Собираю карточки задач",
  },
  {
    description: "Сверю с 3 задачами, где ждали клиента",
    id: "clickup",
    status: "waiting",
    title: "Ответы для ClickUp",
  },
  {
    description: "Ничего не применю без вашего подтверждения",
    id: "proposals",
    status: "waiting",
    title: "Предложения обновить бриф и профили",
  },
];

/* --------------------------------------------------- 02 Итоги звонка */

export type FactStatus = "confirmed" | "assumption" | "contradiction" | "empty";

export const SUMMARY_TLDR = {
  chips: [
    { id: "topics", label: "2 темы" },
    { id: "closed", label: "11 вопросов закрыто" },
    { accent: true, id: "missed", label: "4 не успели спросить" },
  ],
  text: "Звонки с сайта уводим с личных телефонов менеджеров на пятерых операторов через Mango Office. При входящем звонке оператор сразу видит карточку пациента из amoCRM. Открытым остался главный вопрос: что именно записывать в CRM, сам звонок или только факт и длительность.",
};

export interface SummaryPointData {
  id: string;
  /** `?moment=` of the transcript link; the time code when absent. */
  moment?: string;
  /** Note under the point, colored by the status. */
  note?: string;
  status?: Extract<FactStatus, "assumption" | "contradiction">;
  text: string;
  time: string;
}

export interface SummaryTopic {
  id: string;
  points: SummaryPointData[];
  range: string;
  title: string;
}

export const SUMMARY_TOPICS: SummaryTopic[] = [
  {
    id: "calls",
    points: [
      {
        id: "queue",
        text: "Сейчас звонки с сайта уходят на личные телефоны менеджеров, теряется около половины. Нужна общая очередь на операторов.",
        time: "12:01",
      },
      {
        id: "operators",
        text: "На старте пять операторов, к лету до двадцати, если пойдёт реклама. Пропущенные перезванивает оператор сам, через 15 минут напоминание старшему смены.",
        time: "12:04",
      },
      {
        id: "mobile",
        note: "Противоречие, уточнить у Ольги",
        status: "contradiction",
        text: "Звонки из мобильного приложения: сначала «не трогаем», позже «тоже надо завести».",
        time: "12:11",
      },
    ],
    range: "12:01–12:18",
    title: "Приём звонков",
  },
  {
    id: "crm",
    points: [
      {
        id: "card",
        text: "CRM у клиента amoCRM. При входящем звонке у оператора должна сразу открываться карточка пациента.",
        time: "12:21",
      },
      {
        id: "admin",
        text: "amoCRM администрирует подрядчик, доступы есть у Игоря, он выдаст API-ключ. В коде уже есть клиент amoCRM для заявок с сайта.",
        time: "12:24",
      },
      {
        id: "phone",
        note: "Допущение агента, номер есть у всех пациентов",
        status: "assumption",
        text: "Карточку ищем по номеру телефона. Что делать с неизвестным номером, не обсуждали.",
        time: "12:30",
      },
    ],
    range: "12:21–12:41",
    title: "Интеграция с CRM",
  },
];

export interface UnaskedQuestion {
  id: string;
  note: string;
  question: string;
}

export const UNASKED_QUESTIONS: UnaskedQuestion[] = [
  {
    id: "record",
    note: "Интеграция с CRM, самый важный",
    question: "Записывать в CRM сам звонок или только факт и длительность?",
  },
  {
    id: "busy",
    note: "Приём звонков, спросили, но ответа не было",
    question: "Что происходит, если все операторы заняты?",
  },
  {
    id: "shift",
    note: "Приём звонков, канал не назвали",
    question: "Кто старший смены и как ему приходят напоминания?",
  },
  {
    id: "prototype",
    note: "Без темы, спрашивала дизайнер Марта",
    question: "Можно ли показать прототип Игорю до конца месяца?",
  },
];

export interface ClickUpAnswer {
  /** The client's answer; without it the question was not asked. */
  answer?: string;
  id: string;
  missedNote?: string;
  question: string;
  taskId: string;
  time?: string;
  title: string;
}

export const CLICKUP_ANSWERS: ClickUpAnswer[] = [
  {
    answer: "«Оператор сам, через 15 минут напомнить старшему смены»",
    id: "cu-503",
    question: "Андрей: перезванивать на пропущенные автоматически?",
    taskId: "CU-503",
    time: "12:16",
    title: "Очередь входящих и пропущенные",
  },
  {
    answer: "«Да, последние пять звонков, с датой и кто из операторов говорил»",
    id: "cu-517",
    question: "Андрей: показывать ли историю прошлых звонков в карточке?",
    taskId: "CU-517",
    time: "12:33",
    title: "Карточка пациента при входящем звонке",
  },
  {
    id: "cu-529",
    missedNote: "Не спросили на этом звонке",
    question: "Марта: можно ли показать прототип Игорю до конца месяца?",
    taskId: "CU-529",
    title: "Прототип интерфейса оператора",
  },
];

/** What the proposals would update: the brief or a client's profile. */
export interface KnowledgeTarget {
  count: number;
  id: string;
  /** Letter of a person; the brief has a document icon instead. */
  initial?: string;
  name: string;
}

export const KNOWLEDGE_TARGETS: KnowledgeTarget[] = [
  { count: 3, id: "brief", name: "Бриф проекта" },
  { count: 2, id: "olga", initial: "О", name: "Ольга Демченко" },
  { count: 2, id: "igor", initial: "И", name: "Игорь Савчук" },
];

export interface TaskCardOverview {
  caption: string;
  id: string;
  segments: { count: number; status: FactStatus }[];
  title: string;
}

export const TASK_CARD_OVERVIEW: TaskCardOverview[] = [
  {
    caption: "4 подтверждено, 1 допущение, 1 противоречие, 1 пусто",
    id: "calls",
    segments: [
      { count: 4, status: "confirmed" },
      { count: 1, status: "assumption" },
      { count: 1, status: "contradiction" },
      { count: 1, status: "empty" },
    ],
    title: "Приём звонков",
  },
  {
    caption: "3 подтверждено, 2 допущения, 2 пусто",
    id: "crm",
    segments: [
      { count: 3, status: "confirmed" },
      { count: 2, status: "assumption" },
      { count: 2, status: "empty" },
    ],
    title: "Интеграция с CRM",
  },
];

/* --------------------------------------------------- 03 Карточки задач */

export const TASK_TOPICS = [
  { count: 7, id: "calls", title: "Приём звонков" },
  { count: 7, id: "crm", title: "Интеграция с CRM" },
];

/** Where a fact came from: said on the call, docs, the agent's guess. */
export type FactSourceKind = "said" | "docs" | "agent" | "none";

export interface TaskFactData {
  id: string;
  /**
   * The phrase from the transcript the fact was taken from; `moment` is
   * the `?moment=` of its link, the time code when absent.
   */
  quote?: { initial: string; moment?: string; text: string; time: string };
  source: { kind: FactSourceKind; text: string };
  status: FactStatus;
  text: string;
}

export interface TaskCardFieldData {
  facts: TaskFactData[];
  id: string;
  label: string;
}

export interface TaskCardData {
  discussed: string;
  fields: TaskCardFieldData[];
  /** Topic of the card, matches TASK_TOPICS. */
  id: string;
  title: string;
}

export const TASK_CARD: TaskCardData = {
  discussed: "обсуждали 12:01–12:18",
  fields: [
    {
      facts: [
        {
          id: "goal",
          source: { kind: "said", text: "сказал клиент, 12:01" },
          status: "confirmed",
          text: "Не терять звонки с сайта. Сейчас они идут на личные телефоны менеджеров, теряется около половины.",
        },
      ],
      id: "goal",
      label: CARD_LENS_LABELS.goal,
    },
    {
      facts: [
        {
          id: "operators",
          source: { kind: "said", text: "сказал клиент, 12:04" },
          status: "confirmed",
          text: "Операторы колл-центра: пятеро на старте, к лету до двадцати.",
        },
        {
          id: "shift",
          source: {
            kind: "agent",
            text: "допущение агента, роль упомянули вскользь",
          },
          status: "assumption",
          text: "Старший смены видит пропущенные и получает напоминания.",
        },
      ],
      id: "users",
      label: CARD_LENS_LABELS.users,
    },
    {
      facts: [
        {
          id: "queue",
          quote: {
            initial: "К",
            text: "Сейчас звонки с сайта идут на личные телефоны менеджеров, половину мы теряем. Хотим, чтобы попадали сразу операторам, кто свободен, тот и берёт.",
            time: "12:02:14",
          },
          source: { kind: "said", text: "сказала Ольга, 12:02" },
          status: "confirmed",
          text: "Звонок с сайта попадает в общую очередь, берёт первый свободный оператор. Личные номера менеджеров убираем с сайта.",
        },
      ],
      id: "scenario",
      label: CARD_LENS_LABELS.scenarios,
    },
    {
      facts: [
        {
          id: "missed",
          source: { kind: "said", text: "сказал Игорь, 12:16" },
          status: "confirmed",
          text: "Пропущенный звонок: оператор перезванивает сам, через 15 минут напоминание старшему смены.",
        },
        {
          id: "busy",
          source: { kind: "none", text: "Спросили в 12:14, ответа не было" },
          status: "empty",
          text: "Все операторы заняты: очередь с музыкой, автоответ или переадресация?",
        },
      ],
      id: "edge-cases",
      label: CARD_LENS_LABELS.edgeCases,
    },
    {
      facts: [
        {
          id: "mango",
          source: {
            kind: "docs",
            text: "из доков, Outline «Архитектура телефонии»",
          },
          status: "confirmed",
          text: "Телефония Mango Office, записи звонков хранятся у провайдера 90 дней.",
        },
        {
          id: "mobile",
          source: { kind: "said", text: "сказала Ольга, дважды по-разному" },
          status: "contradiction",
          text: "Звонки из мобильного приложения: в 12:06 «не трогаем», в 12:11 «тоже надо завести».",
        },
      ],
      id: "integrations",
      label: CARD_LENS_LABELS.integrations,
    },
    {
      facts: [
        {
          id: "budget",
          source: {
            kind: "none",
            text: "Агент предложит вопрос на следующий звонок",
          },
          status: "empty",
          text: "Бюджет на телефонию и сроки запуска не обсуждали",
        },
      ],
      id: "constraints",
      label: CARD_LENS_LABELS.constraints,
    },
    {
      facts: [
        {
          id: "done",
          source: {
            kind: "agent",
            text: "допущение агента, собрано из сказанного",
          },
          status: "assumption",
          text: "Ни один звонок с сайта не уходит на личные номера, пропущенные видны старшему смены в течение 15 минут.",
        },
      ],
      id: "done-criteria",
      label: CARD_LENS_LABELS.acceptance,
    },
  ],
  id: "calls",
  title: "Приём звонков",
};

/* The second card of the call; the app stacks both under the topic pills. */
export const TASK_CARD_CRM: TaskCardData = {
  discussed: "обсуждали 12:21–12:41",
  fields: [
    {
      facts: [
        {
          id: "crm-goal",
          quote: {
            initial: "К",
            text: "У нас amoCRM. Хотим, чтобы при звонке у оператора сразу открывалась карточка пациента, и звонок туда записывался.",
            time: "12:21:08",
          },
          source: { kind: "said", text: "сказала Ольга, 12:21" },
          status: "confirmed",
          text: "При входящем звонке у оператора сразу открывается карточка пациента из amoCRM.",
        },
      ],
      id: "goal",
      label: CARD_LENS_LABELS.goal,
    },
    {
      facts: [
        {
          id: "crm-users",
          source: {
            kind: "agent",
            text: "допущение агента, из темы «Приём звонков»",
          },
          status: "assumption",
          text: "Карточкой пользуются те же операторы, что принимают звонки.",
        },
      ],
      id: "users",
      label: CARD_LENS_LABELS.users,
    },
    {
      facts: [
        {
          id: "crm-phone",
          quote: {
            initial: "К",
            text: "Да, по номеру. Почти у всех есть, кроме тех, кто записывался через регистратуру давно.",
            time: "12:30:20",
          },
          source: { kind: "agent", text: "допущение агента по 12:30" },
          status: "assumption",
          text: "Карточку ищем по номеру телефона, номер есть у всех пациентов.",
        },
      ],
      id: "scenario",
      label: CARD_LENS_LABELS.scenarios,
    },
    {
      facts: [
        {
          id: "crm-unknown",
          source: { kind: "none", text: "Не обсуждали" },
          status: "empty",
          text: "Неизвестный номер: создать карточку, показать пустую или ничего не открывать?",
        },
      ],
      id: "edge-cases",
      label: CARD_LENS_LABELS.edgeCases,
    },
    {
      facts: [
        {
          id: "crm-access",
          quote: {
            initial: "К",
            text: "Подрядчик, но доступы есть у Игоря. Он сможет выдать ключ, если надо.",
            time: "12:22:51",
          },
          source: { kind: "said", text: "сказал Игорь, 12:22" },
          status: "confirmed",
          text: "amoCRM администрирует подрядчик, API-ключ выдаёт Игорь Савчук.",
        },
      ],
      id: "integrations",
      label: CARD_LENS_LABELS.integrations,
    },
    {
      facts: [
        {
          id: "crm-client",
          source: { kind: "docs", text: "из доков, Outline «Интеграции»" },
          status: "confirmed",
          text: "В коде уже есть клиент amoCRM для заявок с сайта, его и расширяем.",
        },
      ],
      id: "constraints",
      label: CARD_LENS_LABELS.constraints,
    },
    {
      facts: [
        {
          id: "crm-record",
          source: {
            kind: "none",
            text: "Агент предложит вопрос на следующий звонок",
          },
          status: "empty",
          text: "Что записывать в CRM, сам звонок или только факт и длительность, не решили.",
        },
      ],
      id: "done-criteria",
      label: CARD_LENS_LABELS.acceptance,
    },
  ],
  id: "crm",
  title: "Интеграция с CRM",
};

export const TASK_CARDS: TaskCardData[] = [TASK_CARD, TASK_CARD_CRM];

export interface NextQuestion {
  id: string;
  label: string;
  origin: Exclude<FactStatus, "confirmed">;
  question: string;
}

export const NEXT_QUESTIONS: NextQuestion[] = [
  {
    id: "mobile",
    label: "из противоречия",
    origin: "contradiction",
    question:
      "Ольга, звонки из мобильного приложения заводим в первом этапе или позже?",
  },
  {
    id: "busy",
    label: "из пустого поля",
    origin: "empty",
    question: "Что слышит клиент, когда все операторы заняты?",
  },
  {
    id: "shift",
    label: "проверить допущение",
    origin: "assumption",
    question: "Кто такой старший смены и куда ему слать напоминания?",
  },
];

/* ---------------------------------------------- 04 Ревью предложений */

export type ProposalState = "pending" | "editing" | "accepted" | "rejected";

export interface ProposalData {
  /** Text now; null when the field was empty. */
  before: string | null;
  id: string;
  /** Short line of a decided proposal. */
  resolved?: string;
  section: string;
  source: { kind: FactSourceKind; text: string };
  state: ProposalState;
  suggestion: string;
}

export interface ProposalGroupData {
  count?: number;
  id: string;
  initial?: string;
  proposals: ProposalData[];
  role?: string;
  title: string;
}

export const PROPOSAL_GROUPS: ProposalGroupData[] = [
  {
    count: 3,
    id: "brief",
    proposals: [
      {
        before: null,
        id: "operators",
        resolved: "Операторы: 5 на старте, до 20 к лету",
        section: "Раздел «Команда клиента»",
        source: { kind: "said", text: "сказал клиент, 12:04" },
        state: "accepted",
        suggestion: "Операторы: 5 на старте, до 20 к лету",
      },
      {
        before: "Входящие звонки только с сайта.",
        id: "channels",
        section: "Раздел «Каналы входящих»",
        source: { kind: "said", text: "сказала Ольга, 12:11" },
        state: "pending",
        suggestion:
          "Входящие звонки с сайта и из мобильного приложения. Этап для приложения не согласован.",
      },
      {
        before: "amoCRM, доступ через менеджера Телемедиа.",
        id: "crm",
        section: "Раздел «CRM»",
        source: { kind: "said", text: "сказал Игорь, 12:24" },
        state: "editing",
        suggestion:
          "amoCRM, администрирует подрядчик «Интегратор Плюс». API-ключ выдаёт Игорь Савчук",
      },
    ],
    title: "Бриф проекта",
  },
  {
    id: "olga",
    initial: "О",
    proposals: [
      {
        before: "Знает, чего хочет от проекта в целом.",
        id: "understanding",
        section: "Понимание проекта",
        source: { kind: "agent", text: "вывод агента по 12:06 и 12:11" },
        state: "pending",
        suggestion:
          "Цель видит чётко, а объём первого этапа меняет по ходу разговора. Решения по объёму лучше подтверждать письмом.",
      },
      {
        before: null,
        id: "temper",
        resolved: "Темперамент: нетерпеливая, перебивает",
        section: "Темперамент",
        source: { kind: "agent", text: "вывод агента" },
        state: "rejected",
        suggestion: "Нетерпеливая, перебивает",
      },
    ],
    role: "CEO",
    title: "Ольга Демченко",
  },
  {
    id: "igor",
    initial: "И",
    proposals: [
      {
        before: null,
        id: "role",
        resolved: "Роль: держит доступы к amoCRM, выдаёт ключи",
        section: "Роль",
        source: { kind: "said", text: "сказал Игорь, 12:24" },
        state: "accepted",
        suggestion: "Держит доступы к amoCRM, выдаёт ключи",
      },
      {
        before: null,
        id: "tech",
        section: "Технический уровень",
        source: { kind: "said", text: "сказал Игорь, 12:24" },
        state: "pending",
        suggestion:
          "Высокий. Знает API amoCRM v4, говорит по существу, вопросы можно задавать технически.",
      },
    ],
    role: "техлид клиента",
    title: "Игорь Савчук",
  },
];

export interface ReviewTotals {
  accepted: number;
  pending: number;
  rejected: number;
}

export const REVIEW_TOTALS = {
  done: { accepted: 5, pending: 0, rejected: 2 },
  partial: { accepted: 2, pending: 4, rejected: 1 },
} satisfies Record<string, ReviewTotals>;

export const REVIEW_SHORTCUTS = [
  { key: "A", label: "Принять" },
  { key: "E", label: "Изменить" },
  { key: "X", label: "Отклонить" },
  { key: "J / K", label: "Следующее" },
];

export const REVIEW_RESULT: (KnowledgeTarget & { note: string })[] = [
  { count: 3, id: "brief", name: "Бриф проекта", note: "3 изменения" },
  {
    count: 0,
    id: "olga",
    initial: "О",
    name: "Ольга Демченко",
    note: "без изменений",
  },
  {
    count: 2,
    id: "igor",
    initial: "И",
    name: "Игорь Савчук",
    note: "2 изменения",
  },
];

/* ------------------------------------------------- 05 История звонков */

/** Calls per project, the counts in the history sidebar. */
export const CALL_COUNTS: Record<string, number> = {
  lapa: 5,
  "logistic-pro": 14,
  rhythm: 0,
  telemedia: 6,
};

export const TOTAL_CALLS = 25;

export const HISTORY_PROJECTS = PROJECTS.map((project) => ({
  calls: CALL_COUNTS[project.id] ?? 0,
  id: project.id,
  name: project.name,
}));

export interface HistoryCall {
  date: string;
  duration: string;
  id: string;
  openCount: number;
  participants: string;
  /** Proposals still waiting for review. */
  proposals?: number;
  time: string;
  title: string;
}

export interface HistoryMonth {
  calls: HistoryCall[];
  month: string;
}

export const PROJECT_HISTORY: Record<string, HistoryMonth[]> = {
  telemedia: [
    {
      calls: [
        {
          date: "19 окт",
          duration: "40:12",
          id: "oct-19",
          openCount: 4,
          participants: "Ольга Демченко, Игорь Савчук",
          proposals: 4,
          time: "12:01",
          title: "Приём звонков, Интеграция с CRM",
        },
        {
          date: "14 окт",
          duration: "18:40",
          id: "oct-14",
          openCount: 1,
          participants: "Игорь Савчук",
          time: "12:30",
          title: "Запись звонков и сроки хранения",
        },
        {
          date: "9 окт",
          duration: "52:05",
          id: "oct-9",
          openCount: 0,
          participants: "Ольга Демченко, Игорь Савчук",
          time: "12:00",
          title: "Старт проекта, роли и сроки",
        },
        {
          date: "2 окт",
          duration: "24:31",
          id: "oct-2",
          openCount: 0,
          participants: "Ольга Демченко",
          time: "12:15",
          title: "Аудит текущей телефонии",
        },
      ],
      month: "Октябрь",
    },
    {
      calls: [
        {
          date: "25 сен",
          duration: "31:08",
          id: "sep-25",
          openCount: 2,
          participants: "Ольга Демченко",
          time: "12:20",
          title: "Знакомство, цели на квартал",
        },
        {
          date: "18 сен",
          duration: "22:47",
          id: "sep-18",
          openCount: 0,
          participants: "Ольга Демченко, аудио удалено",
          time: "12:40",
          title: "Первый созвон, бюджет и команда",
        },
      ],
      month: "Сентябрь",
    },
  ],
};

/** Filters of a project's history; the first one is selected. */
export const PROJECT_FILTERS = [
  { count: 6, id: "all", label: "Все" },
  { accent: true, count: 3, id: "open", label: "С открытыми вопросами" },
  { id: "olga", label: "Ольга Демченко" },
  { id: "igor", label: "Игорь Савчук" },
];

export interface SearchResult {
  /** Call the result opens; the preview links every row to one frame. */
  callId?: string;
  date: string;
  duration: string;
  id: string;
  /** Found text exactly as written; the query by default. */
  match: { after: string; before: string; meta: string; text?: string };
  /** Transcript moment of the phrase, see `routes.callTranscript`. */
  moment?: string;
  openCount: number;
  project: string;
  time: string;
  title: string;
}

export const SEARCH = {
  filters: [
    { count: 4, id: "all", label: "Все проекты" },
    { count: 3, id: "telemedia", label: "Телемедиа" },
    { count: 1, id: "lapa", label: "Ветклиника Лапа" },
    { count: 0, id: "logistic-pro", label: "Логистик Про" },
  ],
  hint: "ищу в расшифровках и итогах",
  query: "amoCRM",
  results: [
    {
      date: "19 окт",
      duration: "40:12",
      id: "oct-19",
      match: {
        after:
          ". Хотим, чтобы при звонке у оператора сразу открывалась карточка пациента»",
        before: "«У нас ",
        meta: "Клиент, 12:21, и ещё 5 совпадений",
      },
      openCount: 4,
      project: "Телемедиа",
      time: "12:01",
      title: "Приём звонков, Интеграция с CRM",
    },
    {
      date: "14 окт",
      duration: "18:40",
      id: "oct-14",
      match: {
        after: ", сам файл пусть живёт у Mango»",
        before: "«Ссылку на запись можно класть в ",
        meta: "Клиент, 12:38",
      },
      openCount: 1,
      project: "Телемедиа",
      time: "12:30",
      title: "Запись звонков и сроки хранения",
    },
    {
      date: "8 окт",
      duration: "27:15",
      id: "oct-8",
      match: {
        after: ", сейчас всё в таблицах, переезжать пока не хотим»",
        before: "«Раньше сидели на ",
        meta: "Клиент, 12:24",
      },
      openCount: 0,
      project: "Ветклиника Лапа",
      time: "12:10",
      title: "Онлайн-запись и напоминания",
    },
    {
      date: "9 окт",
      duration: "52:05",
      id: "oct-9",
      match: {
        after: " у подрядчика, ключ выдаст Игорь»",
        before: "Итоги: «Доступы к ",
        meta: "в итогах звонка",
      },
      openCount: 0,
      project: "Телемедиа",
      time: "12:00",
      title: "Старт проекта, роли и сроки",
    },
  ] satisfies SearchResult[],
  summary: "4 звонка, 9 совпадений",
};

export type ReadinessStatus = "done" | "open";

export const PROJECT_READINESS: {
  action?: string;
  id: string;
  label: string;
  meta?: string;
  status: ReadinessStatus;
}[] = [
  { id: "brief", label: "Бриф проекта собран", meta: "вчера", status: "done" },
  {
    id: "outline",
    label: "Outline подключён",
    meta: "коллекция «Школа Ритм»",
    status: "done",
  },
  {
    action: "Добавить",
    id: "people",
    label: "Люди клиента не добавлены",
    status: "open",
  },
];

/* --------------------------------------------------- 06 Детали звонка */

export const TRANSCRIPT_TOPICS = [
  { id: "calls", time: "12:01", title: "Приём звонков" },
  { id: "crm", time: "12:21", title: "Интеграция с CRM" },
];

export interface TranscriptTurnData {
  id: string;
  speaker: "client" | "you";
  text: string;
  time: string;
}

export const TRANSCRIPT_TURNS: TranscriptTurnData[] = [
  {
    id: "t-122108",
    speaker: "client",
    text: "У нас amoCRM. Хотим, чтобы при звонке у оператора сразу открывалась карточка пациента, и звонок туда записывался.",
    time: "12:21:08",
  },
  {
    id: "t-122240",
    speaker: "you",
    text: "А кто администрирует amoCRM, свой человек или подрядчик?",
    time: "12:22:40",
  },
  {
    id: "t-122251",
    speaker: "client",
    text: "Подрядчик, но доступы есть у Игоря. Он сможет выдать ключ, если надо.",
    time: "12:22:51",
  },
  {
    id: "t-123012",
    speaker: "you",
    text: "Карточку ищем по номеру телефона, правильно? У всех пациентов он есть в базе?",
    time: "12:30:12",
  },
  {
    id: "t-123020",
    speaker: "client",
    text: "Да, по номеру. Почти у всех есть, кроме тех, кто записывался через регистратуру давно.",
    time: "12:30:20",
  },
];

/* The first topic of the call. The preview shows only the second one. */
export const TRANSCRIPT_CALLS_TURNS: TranscriptTurnData[] = [
  {
    id: "t-120105",
    speaker: "you",
    text: "Расскажите, как сейчас устроен приём звонков с сайта?",
    time: "12:01:05",
  },
  {
    id: "t-120214",
    speaker: "client",
    text: "Сейчас звонки с сайта идут на личные телефоны менеджеров, половину мы теряем. Хотим, чтобы попадали сразу операторам, кто свободен, тот и берёт.",
    time: "12:02:14",
  },
  {
    id: "t-120402",
    speaker: "you",
    text: "Сколько операторов будет на старте?",
    time: "12:04:02",
  },
  {
    id: "t-120415",
    speaker: "client",
    text: "Пятеро. К лету до двадцати, если пойдёт реклама.",
    time: "12:04:15",
  },
  {
    id: "t-120630",
    speaker: "client",
    text: "Мобильное приложение пока не трогаем, это потом.",
    time: "12:06:30",
  },
  {
    id: "t-121105",
    speaker: "client",
    text: "Хотя звонки из приложения тоже надо завести, иначе половина опять мимо.",
    time: "12:11:05",
  },
  {
    id: "t-121410",
    speaker: "you",
    text: "Что происходит, если все операторы заняты?",
    time: "12:14:10",
  },
  {
    id: "t-121422",
    speaker: "client",
    text: "Хороший вопрос. Давайте я уточню и вернусь к вам.",
    time: "12:14:22",
  },
  {
    id: "t-121600",
    speaker: "you",
    text: "Перезванивать на пропущенные автоматически?",
    time: "12:16:00",
  },
  {
    id: "t-121612",
    speaker: "client",
    text: "Оператор сам, через 15 минут напомнить старшему смены.",
    time: "12:16:12",
  },
];

export interface TranscriptSection {
  topic: (typeof TRANSCRIPT_TOPICS)[number];
  turns: TranscriptTurnData[];
}

/** The whole transcript by topic, as the app shows it. */
export const TRANSCRIPT_SECTIONS: TranscriptSection[] = TRANSCRIPT_TOPICS.map(
  (topic) => ({
    topic,
    turns: topic.id === "calls" ? TRANSCRIPT_CALLS_TURNS : TRANSCRIPT_TURNS,
  })
);

export type CallQuestionStatus = "answered" | "open" | "assumption";

export interface CallQuestion {
  id: string;
  /** First turn of the moment the question was asked. */
  momentTurnId?: string;
  /** Player position at that moment. */
  position?: string;
  status: CallQuestionStatus;
  text: string;
  time: string;
}

export const CALL_QUESTIONS: CallQuestion[] = [
  {
    id: "operators",
    momentTurnId: "t-120402",
    position: "3:02",
    status: "answered",
    text: "Сколько операторов будет на старте?",
    time: "12:04",
  },
  {
    id: "busy",
    momentTurnId: "t-121410",
    position: "13:10",
    status: "open",
    text: "Что происходит, если все операторы заняты?",
    time: "12:14",
  },
  {
    id: "callback",
    momentTurnId: "t-121600",
    position: "15:00",
    status: "answered",
    text: "Перезванивать на пропущенные автоматически?",
    time: "12:16",
  },
  {
    id: "admin",
    momentTurnId: "t-122240",
    position: "21:40",
    status: "answered",
    text: "Кто администрирует amoCRM?",
    time: "12:22",
  },
  {
    id: "phone",
    momentTurnId: "t-123012",
    position: "29:12",
    status: "assumption",
    text: "Карточку открывать только по номеру телефона?",
    time: "12:30",
  },
];

export const RECORDING = {
  description: "Opus, 2 канала, 13 МБ. В облако не выгружается.",
  position: "21:42",
  speed: "1,5×",
  title: "Запись на этом компьютере",
};

export const DELETE_RECORDING = {
  description:
    "Аудио 19 октября, 40 минут, 13 МБ, удалится с этого компьютера. Вернуть его не получится.",
  keeps: ["Расшифровка и итоги", "Карточки задач и принятые изменения"],
  title: "Удалить запись звонка?",
};

/**
 * Bars of the player waveform, [y, height] in the 574×28 box of the
 * Paper artboard, one bar every 6px.
 */
export const WAVEFORM: [number, number][] = [
  [10, 7],
  [8, 11],
  [5, 18],
  [5, 18],
  [3, 22],
  [4, 19],
  [6, 15],
  [8, 13],
  [10, 8],
  [10, 8],
  [9, 10],
  [9, 10],
  [9, 10],
  [10, 9],
  [10, 7],
  [10, 7],
  [10, 8],
  [10, 7],
  [10, 9],
  [8, 12],
  [5, 18],
  [6, 15],
  [4, 21],
  [6, 16],
  [8, 13],
  [10, 9],
  [10, 9],
  [6, 17],
  [5, 18],
  [2, 23],
  [2, 24],
  [4, 20],
  [6, 17],
  [8, 11],
  [10, 7],
  [8, 11],
  [6, 15],
  [6, 15],
  [7, 14],
  [8, 13],
  [9, 10],
  [10, 8],
  [10, 7],
  [10, 7],
  [10, 8],
  [9, 10],
  [8, 12],
  [6, 15],
  [6, 15],
  [8, 13],
  [8, 12],
  [10, 7],
  [8, 12],
  [5, 18],
  [5, 18],
  [2, 23],
  [4, 19],
  [4, 21],
  [6, 16],
  [10, 9],
  [9, 10],
  [7, 14],
  [4, 19],
  [4, 20],
  [4, 19],
  [6, 16],
  [7, 14],
  [9, 10],
  [10, 7],
  [10, 8],
  [10, 8],
  [10, 7],
  [10, 8],
  [9, 10],
  [8, 11],
  [10, 9],
  [10, 8],
  [10, 9],
  [8, 11],
  [6, 16],
  [5, 18],
  [5, 18],
  [6, 17],
  [5, 18],
  [8, 11],
  [10, 7],
  [8, 13],
  [4, 20],
  [5, 18],
  [3, 22],
  [4, 21],
  [4, 19],
  [7, 14],
  [10, 9],
  [10, 9],
  [8, 11],
];

/*
 * Where the links of the flow lead. In /dev/screens they point at the
 * frames of the preview page; the app swaps them for routes.
 */
export const HREF = {
  call: "#summary-ready",
  details: "#details",
  history: "#history-project",
  project: "#history-project",
  proposals: "#proposals-partial",
  summary: "#summary-ready",
  tasks: "#task-cards",
} as const;
