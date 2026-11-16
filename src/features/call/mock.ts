import type {
  CallInfo,
  CallScreenData,
  CallScreenState,
  ContextData,
  ContextItem,
  FinalCheckData,
  HistoryEntry,
  MainQuestionData,
  OpenQuestionData,
  QuestionsData,
  TopicAnchorData,
  TopicData,
  TranscriptItem,
} from "./types";

/*
 * Demo data for the call window, verbatim from the Paper page "Звонок":
 * Телемедиа with Olga and Igor, the CRM topic under discussion.
 */

const CALL: CallInfo = {
  endAction: "primary",
  participants: "с Ольгой и Игорем",
  project: "Телемедиа",
  recording: "live",
  time: "24:18",
};

/* Transcript */

const TOPIC_CALLS: TranscriptItem = {
  id: "topic-calls",
  kind: "topic",
  time: "12:01",
  title: "Приём звонков",
};

export const TOPIC_CRM: TranscriptItem = {
  id: "topic-crm",
  kind: "topic",
  time: "12:21",
  title: "Интеграция с CRM",
};

const CLIENT_LOSING_CALLS: TranscriptItem = {
  id: "client-losing-calls",
  kind: "client",
  text: "Сейчас звонки с сайта идут на личные телефоны менеджеров, половину мы теряем. Хотим, чтобы попадали сразу операторам.",
};

export const ME_OPERATORS: TranscriptItem = {
  id: "me-operators",
  kind: "me",
  text: "Сколько операторов будет на старте?",
};

export const CLIENT_OPERATORS: TranscriptItem = {
  footer: { status: "answered", text: "ответ на вопрос" },
  id: "client-operators",
  kind: "client",
  text: "Пятеро. К лету до двадцати, если реклама пойдёт.",
};

export const CLIENT_APP: TranscriptItem = {
  footer: {
    status: "contradiction",
    text: "противоречит сказанному в",
    time: "12:06",
  },
  id: "client-app",
  kind: "client",
  text: "Кстати, из приложения тоже звонят, это половина обращений. Её тоже надо завести.",
};

export const CLIENT_AMO: TranscriptItem = {
  id: "client-amo",
  kind: "client",
  text: "У нас amoCRM. Хотим, чтобы при звонке у оператора сразу открывалась карточка пациента, и звонок туда записывался.",
};

export const ME_ADMIN: TranscriptItem = {
  id: "me-admin",
  kind: "me",
  text: "А кто администрирует amoCRM, свой человек или подрядчик?",
};

const CONTRACTOR_TEXT =
  "Подрядчик, но доступы есть у Игоря. Он сможет выдать ключ, если надо";

export const CLIENT_CONTRACTOR: TranscriptItem = {
  id: "client-contractor",
  kind: "client",
  live: "speaking",
  text: CONTRACTOR_TEXT,
};

const MAIN_TRANSCRIPT: TranscriptItem[] = [
  TOPIC_CALLS,
  CLIENT_LOSING_CALLS,
  ME_OPERATORS,
  CLIENT_OPERATORS,
  CLIENT_APP,
  TOPIC_CRM,
  CLIENT_AMO,
  ME_ADMIN,
  CLIENT_CONTRACTOR,
];

export const ME_CRM_DONE: TranscriptItem = {
  id: "me-crm-done",
  kind: "me",
  text: "По CRM, кажется, всё. Итоги пришлю сегодня.",
};

/** The last minutes of the call, scrolled to the end. */
function closingTranscript(last: TranscriptItem): TranscriptItem[] {
  return [TOPIC_CALLS, CLIENT_APP, TOPIC_CRM, CLIENT_AMO, ME_CRM_DONE, last];
}

export const CLIENT_LETS_FINISH: TranscriptItem = {
  id: "client-lets-finish",
  kind: "client",
  live: "speaking",
  text: "Хорошо, тогда давайте на этом закончим. Если что, Игорь допишет в чат",
};

export const CLIENT_GOODBYE: TranscriptItem = {
  id: "client-goodbye",
  kind: "client",
  text: "Хорошо, тогда на этом закончим. Спасибо, до связи!",
};

/* Questions */

const ANCHORS: TopicAnchorData[] = [
  {
    active: true,
    count: 5,
    countTone: "open",
    id: "crm",
    label: "Интеграция с CRM",
  },
  { count: 2, countTone: "open", id: "calls", label: "Приём звонков" },
  { count: 1, countTone: "neutral", id: "no-topic", label: "Без темы" },
];

const FINAL_CHECK_ANCHORS: TopicAnchorData[] = [
  {
    active: true,
    count: 4,
    countTone: "open",
    id: "final-check",
    label: "Финальная проверка",
  },
  { count: 3, countTone: "open", id: "crm", label: "Интеграция с CRM" },
  { count: 2, countTone: "neutral", id: "calls", label: "Приём звонков" },
];

export const Q_MOBILE: OpenQuestionData = {
  description: "Сначала «не трогаем», потом «тоже надо»",
  id: "q-mobile",
  tag: "contradiction",
  title: "Мобильное приложение входит в первый этап?",
};

export const Q_AMO: OpenQuestionData = {
  description: "В коде уже есть клиент amoCRM для заявок с сайта",
  id: "q-amo",
  tag: "code",
  title: "Используем текущую интеграцию с amoCRM или делаем новую?",
};

export const Q_PHONE: OpenQuestionData = {
  description: "Предполагаю, что номер есть у всех пациентов в базе",
  id: "q-phone",
  tag: "assumption",
  title: "Карточку открывать только по номеру телефона?",
};

export const Q_HISTORY: OpenQuestionData = {
  description: "Андрей ждёт ответ, чтобы оценить задачу",
  id: "q-history",
  tag: "clickup",
  title: "Нужна ли история прошлых звонков в карточке?",
};

export const CRM_HISTORY: HistoryEntry[] = [
  {
    answer: "«amoCRM»",
    id: "h-crm",
    question: "Какая CRM используется?",
    status: "answered",
    time: "12:21",
  },
];

export const CRM_MAIN: MainQuestionData = {
  description: "«Звонок туда записывался» можно понять по-разному",
  status: "Новый, только что",
  title: "Записывать в CRM сам звонок или только факт и длительность?",
};

const CRM_TOPIC: TopicData = {
  history: { items: CRM_HISTORY },
  id: "crm",
  main: CRM_MAIN,
  meta: "идёт сейчас, с 12:21",
  questions: [Q_MOBILE, Q_AMO, Q_PHONE, Q_HISTORY],
  title: "Интеграция с CRM",
};

export const CALLS_TOPIC: TopicData = {
  history: {
    count: 4,
    items: [
      {
        answer: "«Оператор сам, через 15 минут напомнить старшему смены»",
        id: "h-callback",
        note: "Ответ попадёт в итоги для ClickUp",
        question: "Перезванивать на пропущенные автоматически?",
        status: "answered-task",
        time: "12:16",
      },
      {
        id: "h-busy",
        note: "Спросили, но ответа не было",
        question: "Что происходит, если все операторы заняты?",
        status: "unanswered",
      },
      {
        id: "h-budget",
        note: "Вы скрыли",
        question: "Какой бюджет на телефонию в месяц?",
        status: "hidden",
      },
      {
        id: "h-ads",
        note: "Неактуален, клиент сам рассказал в 12:06",
        question: "Звонки из рекламы идут в ту же очередь?",
        status: "irrelevant",
        time: "12:06",
      },
    ],
  },
  id: "calls",
  meta: "12:01–12:18, осталось 2",
  questions: [
    {
      description: "Клиент сказал «наверное»",
      id: "q-queue",
      title: "Очередь с музыкой — это решение или один из вариантов?",
    },
    {
      description: "Про напоминания сказали, канал не назвали",
      id: "q-shift-lead",
      title: "Кто старший смены и как ему приходят напоминания?",
    },
  ],
  title: "Приём звонков",
};

const NO_TOPIC: TopicData = {
  id: "no-topic",
  meta: "ждут удобного момента",
  questions: [
    {
      description: "Спрашивала дизайнер Марта, нужна обратная связь",
      id: "q-prototype",
      tag: "clickup",
      title: "Можно ли показать прототип Игорю до конца месяца?",
    },
  ],
  title: "Без темы",
};

const QUESTIONS: QuestionsData = {
  agent: { state: "listening" },
  anchors: ANCHORS,
  current: CRM_TOPIC,
  noTopic: NO_TOPIC,
  previous: CALLS_TOPIC,
};

/** Frozen copy of the main question when the agent stopped at 12:31. */
const FROZEN_CRM_TOPIC: TopicData = {
  ...CRM_TOPIC,
  main: { ...CRM_MAIN, status: "Заморожено в 12:31" },
};

export const FINAL_CHECK: FinalCheckData = {
  banner: {
    action: "Вернуться к темам",
    description:
      "Ольга предложила закончить в 12:38. Вот что важнее всего спросить, пока все на связи.",
    title: "Похоже, разговор идёт к концу",
  },
  main: {
    description: "Игорь ещё на связи, он знает, как настроен amoCRM",
    status: "Интеграция с CRM, без ответа не оценить задачу",
    title: "Записывать в CRM сам звонок или только факт и длительность?",
  },
  meta: "4 самых важных из 9 открытых",
  questions: [
    { ...Q_MOBILE, id: "fc-mobile", topic: "Приём звонков" },
    {
      description: "Спросили в 12:14, ответа не было",
      id: "fc-busy",
      tag: "empty",
      title: "Что происходит, если все операторы заняты?",
      topic: "Приём звонков",
    },
    { ...Q_HISTORY, id: "fc-history", topic: "Интеграция с CRM" },
  ],
  title: "Финальная проверка",
};

const FINAL_CHECK_QUESTIONS: QuestionsData = {
  agent: { state: "listening" },
  anchors: FINAL_CHECK_ANCHORS,
  current: { ...CRM_TOPIC, main: undefined },
  finalCheck: FINAL_CHECK,
  noTopic: NO_TOPIC,
  previous: CALLS_TOPIC,
};

/* Context */

const SEARCHING: ContextItem = {
  id: "ctx-searching",
  kind: "searching",
  text: "Ищу в Outline «старший смены»",
};

export const GITHUB_FINDING: ContextItem = {
  body: "Клиент amoCRM API v4 уже есть, используется для заявок с сайта",
  code: "integrations/amocrm/client.ts\ncreateLead(), findContact()",
  id: "ctx-github",
  kind: "finding",
  meta: "telemedia/backend",
  metaMono: true,
  questionLink: "к вопросу про текущую интеграцию",
  source: "github",
  time: "12:22",
  title: "GitHub",
};

export const CLICKUP_FINDING: ContextItem = {
  body: "Карточка пациента при входящем звонке",
  bodyStrong: true,
  id: "ctx-clickup",
  kind: "finding",
  meta: "CU-517",
  metaMono: true,
  quote:
    "Не понятно, показывать ли историю прошлых звонков. От этого зависит оценка.",
  quoteMeta: "Андрей, 2 дня назад",
  source: "clickup",
  status: "ждёт клиента",
  title: "ClickUp",
};

export const OUTLINE_FINDING: ContextItem = {
  id: "ctx-outline",
  kind: "finding",
  meta: "Архитектура телефонии",
  questionLink: "к вопросу про запись звонка в CRM",
  quote:
    "Провайдер телефонии Mango Office, записи звонков хранятся у провайдера 90 дней.",
  source: "outline",
  title: "Outline",
};

const CONTEXT: ContextData = {
  description: "найдено по ходу",
  items: [SEARCHING, GITHUB_FINDING, CLICKUP_FINDING, OUTLINE_FINDING],
};

/* Screens */

const MAIN: CallScreenData = {
  call: CALL,
  context: CONTEXT,
  questions: QUESTIONS,
  transcript: { items: MAIN_TRANSCRIPT },
};

const FINAL_CHECK_SCREEN: CallScreenData = {
  call: { ...CALL, time: "38:42" },
  context: CONTEXT,
  questions: FINAL_CHECK_QUESTIONS,
  transcript: { items: closingTranscript(CLIENT_LETS_FINISH) },
};

export const MIC_RELEASED_SCREEN: CallScreenData = {
  call: { ...CALL, endAction: "secondary", time: "39:04" },
  context: CONTEXT,
  micReleased: {
    countdown: "6:48",
    countdownLabel: "Завершу сам через",
    description:
      "Zoom отпустил микрофон в 12:39. Если это пауза, просто продолжайте.",
    progress: 68,
    title: "Микрофон больше не используется. Завершить звонок?",
  },
  questions: {
    ...FINAL_CHECK_QUESTIONS,
    agent: { label: "тишина", state: "listening", tone: "muted" },
  },
  transcript: { items: closingTranscript(CLIENT_GOODBYE) },
};

export const CALL_SCREENS: Record<CallScreenState, CallScreenData> = {
  "agent-timeout": {
    ...MAIN,
    call: { ...CALL, time: "33:10" },
    questions: {
      ...QUESTIONS,
      agent: { label: "вопросы на паузе", state: "listening", tone: "muted" },
      banner: {
        actions: [{ id: "retry", label: "Повторить", variant: "secondary" }],
        description:
          "Вопросы заморожены на 12:31. Запись и расшифровка идут, после восстановления догоню пропущенное.",
        hint: { text: "Сам попробую через", time: "0:40" },
        icon: "claude",
        title: "Claude Code не отвечает уже 2 минуты",
      },
      current: FROZEN_CRM_TOPIC,
      frozen: true,
    },
  },
  "final-check": FINAL_CHECK_SCREEN,
  finishing: {
    ...MIC_RELEASED_SCREEN,
    call: {
      ...MIC_RELEASED_SCREEN.call,
      endAction: "hidden",
      recording: "stopped",
    },
    finishing: {
      description:
        "Телемедиа, 39 минут, три темы. Обычно это до минуты, окно можно закрыть.",
      progress: 45,
      steps: [
        {
          id: "transcript",
          label: "Расшифровка дописана",
          meta: "412 реплик",
          state: "done",
        },
        {
          id: "summary",
          label: "Итоги и короткое резюме по темам",
          meta: "2 из 3",
          state: "active",
        },
        { id: "open", label: "Незакрытые вопросы", state: "pending" },
        {
          id: "brief",
          label: "Что обновить в брифе и профилях",
          state: "pending",
        },
      ],
      title: "Собираю итоги…",
    },
    micReleased: undefined,
  },
  "github-unavailable": {
    ...MAIN,
    context: {
      ...CONTEXT,
      items: [
        SEARCHING,
        {
          action: "Подключить снова",
          body: "Доступ к GitHub закончился в 12:20. Код пока не ищу, вопросы строю по брифу и Outline.",
          id: "ctx-github",
          kind: "unavailable",
          meta: "telemedia/backend",
          note: "Код из браузера, звонок не прервётся. Найденное до 12:20 осталось в вопросах.",
          source: "github",
          status: "нет доступа",
          title: "GitHub",
        },
        CLICKUP_FINDING,
        OUTLINE_FINDING,
      ],
    },
  },
  "limit-reached": {
    ...MAIN,
    call: { ...CALL, time: "33:10" },
    questions: {
      ...QUESTIONS,
      agent: { label: "лимит исчерпан", state: "listening", tone: "muted" },
      banner: {
        actions: [
          { id: "remind", label: "Напомнить в 15:00", variant: "secondary" },
          { id: "subscription", label: "Открыть подписку", variant: "ghost" },
        ],
        description:
          "Новых вопросов не будет, список заморожен на 12:31. Запись и расшифровка идут, итоги соберу, когда лимит обновится.",
        footnote:
          "Лимиты задаёт руководитель. Если часто упираетесь, напишите ему.",
        icon: "claude",
        title: "Лимит подписки Claude исчерпан до 15:00",
      },
      current: FROZEN_CRM_TOPIC,
      frozen: true,
    },
  },
  "mic-released": MIC_RELEASED_SCREEN,
  "no-system-audio": {
    ...MAIN,
    questions: {
      ...QUESTIONS,
      agent: {
        label: "слышу только вас",
        state: "listening",
        tone: "destructive",
      },
      banner: {
        actions: [
          {
            id: "open-settings",
            label: "Открыть настройки",
            variant: "secondary",
          },
        ],
        description:
          "Нет доступа к системному звуку, записывается только канал «Вы». Вопросы строю по вашим репликам и брифу, ответы клиента не учитываю.",
        hint: {
          text: "Конфиденциальность и безопасность → Запись экрана и системного звука → Grill",
        },
        icon: "speaker-off",
        title: "Не слышу собеседников",
      },
      current: {
        ...CRM_TOPIC,
        main: { ...CRM_MAIN, status: "По вашим репликам" },
      },
    },
    transcript: {
      items: [
        TOPIC_CALLS,
        {
          duration: "0:42",
          id: "missing-1",
          kind: "missing",
          label: "Звук клиента не записан",
        },
        ME_OPERATORS,
        TOPIC_CRM,
        {
          duration: "1:15",
          id: "missing-2",
          kind: "missing",
          label: "Звук клиента не записан",
        },
        ME_ADMIN,
        {
          duration: "0:09",
          id: "missing-3",
          kind: "missing",
          label: "Клиент говорит сейчас",
        },
      ],
    },
  },
  "question-hover": {
    ...MAIN,
    questions: { ...QUESTIONS, hoveredId: Q_AMO.id },
  },
  "question-pinned": {
    ...MAIN,
    questions: {
      ...QUESTIONS,
      current: {
        ...CRM_TOPIC,
        pinned: {
          description: "Андрей ждёт ответ в ClickUp, чтобы оценить задачу",
          id: "q-history",
          label: "Закреплён вами в 12:24",
          title: "Нужна ли история прошлых звонков в карточке?",
        },
        questions: [Q_MOBILE, Q_AMO, Q_PHONE],
      },
    },
  },
  reference: MAIN,
  starting: {
    call: { ...CALL, time: "00:48" },
    context: {
      description: "готовлю бриф",
      items: [
        {
          id: "ctx-brief",
          kind: "brief",
          meta: "освежаю, прошлый от 12 окт.",
          title: "Бриф проекта",
        },
        {
          id: "ctx-sources",
          items: [
            {
              id: "outline",
              name: "Outline",
              source: "outline",
              status: "читаю 7 из 12",
            },
            {
              id: "github",
              name: "GitHub",
              source: "github",
              status: "в очереди",
            },
            {
              done: true,
              id: "clickup",
              name: "ClickUp",
              source: "clickup",
              status: "2 вопроса",
            },
          ],
          kind: "sources",
        },
      ],
    },
    questions: {
      agent: { state: "listening" },
      anchors: [
        { count: 2, countTone: "neutral", id: "no-topic", label: "Без темы" },
      ],
      empty: {
        description:
          "Обычно это первые две-три минуты. Пока можно задать вопросы из ClickUp, они ниже.",
        title: "Слушаю. Первые вопросы появятся, когда станет понятна тема",
      },
      noTopic: {
        id: "no-topic",
        meta: "из ClickUp, собрал перед звонком",
        questions: [
          {
            description: "Спрашивала дизайнер Марта, нужна обратная связь",
            id: "q-prototype",
            tag: "clickup",
            title: "Можно ли показать прототип Игорю до конца месяца?",
          },
          {
            description: "Андрей ждёт ответ, чтобы оценить задачу CU-517",
            id: "q-history",
            tag: "clickup",
            title: "Нужна ли история прошлых звонков в карточке пациента?",
          },
        ],
        title: "Без темы",
      },
    },
    transcript: {
      items: [
        {
          id: "topic-unknown",
          kind: "topic",
          time: "12:00",
          title: "Тема ещё не ясна",
        },
        {
          id: "client-hello",
          kind: "client",
          text: "Добрый день! Да, слышно отлично. Игорь тоже подключился, с телефона.",
        },
        {
          id: "me-start",
          kind: "me",
          text: "Отлично. С чего начнём, со звонков с сайта?",
        },
        {
          id: "client-start",
          kind: "client",
          live: "speaking",
          text: "Да, давайте с них. Сейчас всё идёт на личные телефоны менеджеров, и половину",
        },
      ],
    },
  },
  "transcript-collapsed": {
    ...MAIN,
    transcript: { collapsed: true, items: MAIN_TRANSCRIPT },
  },
  "transcript-lag": {
    ...MAIN,
    call: { ...CALL, time: "31:52" },
    questions: {
      ...QUESTIONS,
      agent: { label: "вопросы по 12:30", state: "listening" },
    },
    transcript: {
      items: [
        TOPIC_CALLS,
        CLIENT_APP,
        TOPIC_CRM,
        CLIENT_AMO,
        ME_ADMIN,
        { ...CLIENT_CONTRACTOR, live: "transcribing" },
      ],
      notice: {
        description:
          "Компьютер нагружен, звук пишется полностью. Догоню, вопросы обновятся следом.",
        title: "Расшифровка отстаёт на 40 секунд",
      },
    },
  },
};
