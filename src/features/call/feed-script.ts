import {
  CALLS_TOPIC,
  CLICKUP_FINDING,
  CLIENT_AMO,
  CLIENT_APP,
  CLIENT_CONTRACTOR,
  CLIENT_GOODBYE,
  CLIENT_LETS_FINISH,
  CLIENT_OPERATORS,
  CRM_HISTORY,
  CRM_MAIN,
  FINAL_CHECK,
  GITHUB_FINDING,
  ME_ADMIN,
  ME_CRM_DONE,
  ME_OPERATORS,
  OUTLINE_FINDING,
  Q_AMO,
  Q_HISTORY,
  Q_MOBILE,
  Q_PHONE,
  TOPIC_CRM,
} from "./mock";
import type {
  CallFeedEvent,
  ContextItem,
  FeedCheckpoint,
  HistoryEntry,
  MainQuestionData,
  TopicData,
  TranscriptItem,
} from "./types";

/*
 * The scripted Телемедиа call the mock backend plays (`CallBackend.layerMock`):
 * what the recorder and the agent push during a real call, step by step.
 */

export interface FeedStep {
  /** A forced demo state that resumes the feed from this step. */
  checkpoint?: FeedCheckpoint;
  /** Pause before the step, in ms. */
  delay: number;
  events: CallFeedEvent[];
}

const CLIENT_START_DONE: TranscriptItem = {
  id: "client-start",
  kind: "client",
  text: "Да, давайте с них. Сейчас всё идёт на личные телефоны менеджеров, и половину звонков мы теряем.",
};

const CALLS_MAIN: MainQuestionData = {
  description: "«Половину теряем»: похоже, очереди сейчас нет",
  id: "q-busy",
  status: "Новый, только что",
  title: "Что происходит, если все операторы заняты?",
};

const LIVE_CALLS_TOPIC: TopicData = {
  history: { items: [] },
  id: CALLS_TOPIC.id,
  main: CALLS_MAIN,
  meta: "идёт сейчас, с 12:01",
  questions: [],
  title: CALLS_TOPIC.title,
};

const LIVE_CRM_TOPIC: TopicData = {
  history: { items: [] },
  id: "crm",
  meta: "идёт сейчас, с 12:21",
  questions: [],
  title: "Интеграция с CRM",
};

const OPERATORS_ANSWER: HistoryEntry = {
  answer: "«Пятеро. К лету до двадцати»",
  id: "h-operators",
  question: "Сколько операторов будет на старте?",
  status: "answered",
  time: "12:04",
};

function sourcesItem(
  outline: string,
  github: string,
  githubDone = false
): ContextItem {
  return {
    id: "ctx-sources",
    items: [
      {
        done: true,
        id: "outline",
        name: "Outline",
        source: "outline",
        status: outline,
      },
      {
        done: githubDone,
        id: "github",
        name: "GitHub",
        source: "github",
        status: github,
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
  };
}

function searching(text: string): ContextItem {
  return { id: "ctx-searching", kind: "searching", text };
}

function speaking(item: TranscriptItem): TranscriptItem {
  return item.kind === "client"
    ? { ...item, footer: undefined, live: "speaking" }
    : item;
}

function finished(item: TranscriptItem): TranscriptItem {
  return item.kind === "client" ? { ...item, live: undefined } : item;
}

/*
 * The scripted Телемедиа call, from the first minute (the "starting"
 * screen) to Zoom letting go of the microphone. About a minute end to end.
 */
export const CALL_SCRIPT: readonly FeedStep[] = [
  {
    delay: 2200,
    events: [
      { item: CLIENT_START_DONE, type: "transcript" },
      { item: sourcesItem("12 документов", "читаю код"), type: "context" },
    ],
  },
  {
    delay: 2000,
    events: [
      {
        item: {
          id: "topic-unknown",
          kind: "topic",
          time: "12:01",
          title: "Приём звонков",
        },
        type: "transcript",
      },
      { topic: LIVE_CALLS_TOPIC, type: "topic" },
    ],
  },
  {
    delay: 2500,
    events: [
      { item: ME_OPERATORS, type: "transcript" },
      {
        question: CALLS_TOPIC.questions[0],
        topicId: "calls",
        type: "question",
      },
    ],
  },
  {
    delay: 2000,
    events: [{ item: speaking(CLIENT_OPERATORS), type: "transcript" }],
  },
  {
    delay: 1800,
    events: [
      { item: CLIENT_OPERATORS, type: "transcript" },
      { entry: OPERATORS_ANSWER, topicId: "calls", type: "answered" },
    ],
  },
  {
    delay: 2200,
    events: [
      { item: sourcesItem("12 документов", "готово", true), type: "context" },
    ],
  },
  {
    delay: 1500,
    events: [
      {
        description: "найдено по ходу",
        item: CLICKUP_FINDING,
        remove: ["ctx-brief", "ctx-sources"],
        type: "context",
      },
    ],
  },
  {
    delay: 2500,
    events: [
      { item: CLIENT_APP, type: "transcript" },
      { question: Q_MOBILE, topicId: "calls", type: "question" },
    ],
  },
  {
    delay: 2500,
    events: [
      {
        question: CALLS_TOPIC.questions[1],
        topicId: "calls",
        type: "question",
      },
    ],
  },
  {
    delay: 3000,
    events: [
      { item: TOPIC_CRM, type: "transcript" },
      { previousRange: "12:01–12:18", topic: LIVE_CRM_TOPIC, type: "topic" },
    ],
  },
  {
    delay: 2000,
    events: [
      { item: CLIENT_AMO, type: "transcript" },
      { entry: CRM_HISTORY[0], topicId: "crm", type: "answered" },
      { item: searching("Ищу в GitHub «amoCRM»"), type: "context" },
    ],
  },
  {
    delay: 2500,
    events: [
      { item: GITHUB_FINDING, remove: ["ctx-searching"], type: "context" },
      { question: Q_AMO, topicId: "crm", type: "question" },
    ],
  },
  {
    delay: 2000,
    events: [
      { item: ME_ADMIN, type: "transcript" },
      { question: Q_PHONE, topicId: "crm", type: "question" },
    ],
  },
  {
    delay: 2000,
    events: [
      { item: CLIENT_CONTRACTOR, type: "transcript" },
      {
        main: { ...CRM_MAIN, id: "q-crm-record" },
        topicId: "crm",
        type: "main-question",
      },
    ],
  },
  {
    delay: 2500,
    events: [
      { item: OUTLINE_FINDING, type: "context" },
      { item: searching("Ищу в Outline «старший смены»"), type: "context" },
      { question: Q_HISTORY, topicId: "crm", type: "question" },
    ],
  },
  {
    checkpoint: "reference",
    delay: 6000,
    events: [
      { item: finished(CLIENT_CONTRACTOR), type: "transcript" },
      { item: ME_CRM_DONE, type: "transcript" },
    ],
  },
  {
    delay: 2500,
    events: [
      { item: CLIENT_LETS_FINISH, type: "transcript" },
      { finalCheck: FINAL_CHECK, type: "final-check" },
    ],
  },
  {
    checkpoint: "final-check",
    delay: 3000,
    events: [{ item: finished(CLIENT_LETS_FINISH), type: "transcript" }],
  },
  {
    delay: 4000,
    events: [{ item: CLIENT_GOODBYE, type: "transcript" }],
  },
  {
    delay: 2500,
    events: [{ type: "mic-released" }],
  },
];

/** Step a forced demo state resumes the feed from. */
export function feedCheckpoint(checkpoint: FeedCheckpoint) {
  const index = CALL_SCRIPT.findIndex((step) => step.checkpoint === checkpoint);
  return Math.max(index, 0);
}

/** Number of steps; a position equal to it means the feed is over. */
export const FEED_LENGTH = CALL_SCRIPT.length;

/** The finding GitHub returns once it is connected again. */
export const RECONNECTED_GITHUB = GITHUB_FINDING;
