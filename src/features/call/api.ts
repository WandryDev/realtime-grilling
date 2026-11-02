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
  ContextItem,
  FinalCheckData,
  HistoryEntry,
  MainQuestionData,
  OpenQuestionData,
  TopicData,
  TranscriptItem,
} from "./types";

/*
 * The fake backend of the call window. Everything the agent and the
 * recorder would push in a real call lives here, so the backend replaces
 * this one module:
 *
 * - `subscribeToCallFeed`: transcript phrases, topics, questions and
 *   context findings, as a stream of events (later: a Tauri event channel).
 * - `collectSummary`, `retryAgent`, `reconnectSource`,
 *   `requestSystemAudio`, `waitForTranscript`: one-off async operations
 *   (later: Tauri commands).
 *
 * Each function returns a cleanup that cancels the pending timers.
 */

/* Feed */

export type CallFeedEvent =
  /** Adds a phrase or replaces the one with the same id (speech finished). */
  | { item: TranscriptItem; type: "transcript" }
  /**
   * A new topic under discussion. The current one moves down as the
   * previous topic, `previousRange` becomes its time range.
   */
  | { previousRange?: string; topic: TopicData; type: "topic" }
  /** A new open question; moves it if another topic already has it. */
  | { question: OpenQuestionData; topicId: string; type: "question" }
  /** A new main question; the old main joins the open questions. */
  | { main: MainQuestionData; topicId: string; type: "main-question" }
  /** The agent heard an answer: a row in "Обсудили в этой теме". */
  | {
      entry: HistoryEntry;
      /** Open question the answer closes. */
      questionId?: string;
      topicId: string;
      type: "answered";
    }
  /** Adds or replaces a context card, removes the listed ones. */
  | {
      description?: string;
      item?: ContextItem;
      remove?: string[];
      type: "context";
    }
  /** The agent hears the call wind down. */
  | { finalCheck: FinalCheckData; type: "final-check" }
  /** Nobody but us holds the microphone any more. */
  | { type: "mic-released" };

interface FeedStep {
  /** A forced demo state that resumes the feed from this step. */
  checkpoint?: FeedCheckpoint;
  /** Pause before the step, in ms. */
  delay: number;
  events: CallFeedEvent[];
}

export type FeedCheckpoint = "reference" | "final-check";

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
const SCRIPT: FeedStep[] = [
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
  const index = SCRIPT.findIndex((step) => step.checkpoint === checkpoint);
  return Math.max(index, 0);
}

/** Number of steps; a position equal to it means the feed is over. */
export const FEED_LENGTH = SCRIPT.length;

/**
 * Plays the call from step `from`. `onStep` gets the position after each
 * step so the caller can resume where it paused.
 */
export function subscribeToCallFeed(
  onEvent: (event: CallFeedEvent) => void,
  { from = 0, onStep }: { from?: number; onStep?: (next: number) => void } = {}
): () => void {
  let index = from;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = () => {
    const step = SCRIPT[index];
    if (!step) {
      return;
    }
    timer = setTimeout(() => {
      index += 1;
      for (const event of step.events) {
        onEvent(event);
      }
      onStep?.(index);
      scheduleNext();
    }, step.delay);
  };

  scheduleNext();
  return () => clearTimeout(timer);
}

/* One-off operations */

/** Stages of the summary: transcript, summary, open questions, brief. */
export const SUMMARY_STAGES = 4;
const SUMMARY_STAGE_MS = 1500;

/**
 * "Собираю итоги": reports each finished stage, then `onDone`. The first
 * stage (the transcript) is ready right away.
 */
export function collectSummary(
  onStage: (stage: number) => void,
  onDone: () => void
): () => void {
  let stage = 1;
  const timer = setInterval(() => {
    stage += 1;
    if (stage >= SUMMARY_STAGES) {
      clearInterval(timer);
      onStage(SUMMARY_STAGES);
      onDone();
      return;
    }
    onStage(stage);
  }, SUMMARY_STAGE_MS);
  return () => clearInterval(timer);
}

function after(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

/** Restarts the agent session after it stopped answering. */
export function retryAgent(onRecovered: () => void) {
  return after(1500, onRecovered);
}

/** Reconnects an integration that lost its access (GitHub). */
export function reconnectSource(onConnected: () => void) {
  return after(1500, onConnected);
}

/**
 * Opens the system privacy settings and waits for the permission. Here the
 * user "grants" it after a moment.
 */
export function requestSystemAudio(onGranted: () => void) {
  return after(2500, onGranted);
}

/** The lagging transcript catches up on its own. */
export function waitForTranscript(onCaughtUp: () => void) {
  return after(4000, onCaughtUp);
}

/** The finding GitHub returns once it is connected again. */
export const RECONNECTED_GITHUB = GITHUB_FINDING;
