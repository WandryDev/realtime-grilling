import type { AgentStatus, CallState } from "@/bindings";
import { plural } from "@/lib/plural";
import { routes } from "@/lib/routes";

import {
  AGENT_LISTENING,
  toAgentQuestions,
  toAgentStatusView,
  withFooters,
} from "./agent-state";
import { SUMMARY_STAGES } from "./backend";
import { FINAL_CHECK_TOPIC_ID } from "./components/call-questions";
import { CALL_SCREENS } from "./mock";
import type {
  CallFeedEvent,
  CallScreenData,
  ContextItem,
  FinishingData,
  FinishingStep,
  HistoryEntry,
  OpenQuestionData,
  QuestionQuickAction,
  QuestionsData,
  TopicAnchorData,
  TopicData,
  TranscriptData,
  TranscriptItem,
  TranscriptionState,
  TranscriptUnavailableData,
} from "./types";

/*
 * State of the live call window and everything that changes it: feed events
 * from ./api, your clicks, the clock. Pure, so the reducer is easy to test;
 * `toScreenData` turns it into the props of <CallScreen>.
 *
 * Two sources of questions. The demo script (browser, tests) sends them as
 * feed events and the clicks change them here, with `stash` for «Вернуть».
 * In Tauri the backend keeps them (`backend`): every read of its call state
 * replaces the topics through ./agent-state.ts, the clicks go to the
 * backend and nothing is stashed.
 */

/** The backend's questions and agent (Tauri). */
export interface BackendQuestions {
  /** When the recording started, ms since the epoch: footer times. */
  startedAt?: number;
  /** The last call state read; null before the first. */
  state: CallState | null;
  /**
   * The agent's last status from the backend; null before the first. A
   * «Повторить» the backend refused goes back to it.
   */
  status: AgentStatus | null;
  /** Call second the agent started thinking; null while it doesn't. */
  thinkingSince: number | null;
}

export interface LiveCallState {
  /** Seconds before the agent retries by itself ("Сам попробую через"). */
  agentRetryIn: number | null;
  /** Tauri: the questions are the backend's; null: the demo script's. */
  backend: BackendQuestions | null;
  /** What the screen draws, minus the ticking numbers. */
  data: CallScreenData;
  /** Call length in seconds. */
  elapsed: number;
  /** Seconds before the call ends by itself after the mic was released. */
  micLeft: number | null;
  /** The whole countdown in seconds, for the panel's bar. */
  micTotal: number;
  /**
   * Questions taken out of the list (pinned, asked, hidden), by pinned
   * question id or history entry id, so "Вернуть" restores them whole.
   */
  stash: Record<string, OpenQuestionData>;
}

export type LiveCallAction =
  | { event: CallFeedEvent; type: "feed" }
  | { type: "tick" }
  | {
      action: QuestionQuickAction;
      questionId: string;
      topicId: string;
      type: "question";
    }
  | { entryId: string; topicId: string; type: "restore" }
  | { topicId: string; type: "unpin" }
  | { type: "toggle-transcript" }
  | { type: "leave-final-check" }
  | { type: "return-final-check" }
  | {
      /** The agent's state read with it, unless a newer status came. */
      agent?: AgentStatus;
      /** Now, ms since the epoch. */
      now: number;
      /** When the recording started, ms since the epoch. */
      startedAt?: number;
      state: CallState;
      type: "call-state";
    }
  | { now: number; status: AgentStatus; type: "agent-status" }
  | {
      /** The app that let the microphone go, if known. */
      app: string | null;
      /** Now, ms since the epoch. */
      now: number;
      /** When it let go, ms since the epoch. */
      releasedAt: number;
      /** The auto end in seconds; null: never. */
      timeout: number | null;
      type: "mic-released";
    }
  | { type: "mic-continue" }
  | { project: string; type: "finish-start" }
  | { stage: number; type: "finish-stage" }
  | { type: "finish-cancel" }
  | { type: "agent-retrying" }
  /** The backend refused «Повторить» (the live pass is over, say). */
  | { now: number; type: "agent-retry-failed" }
  | { type: "agent-recovered" }
  | { itemId: string; type: "reconnect-start" }
  | { item: ContextItem; type: "reconnect-done" }
  | { type: "audio-restored" }
  | { type: "transcript-caught-up" };

/** Mic panel timeout of the demo states: the bar is full at 10 minutes. */
export const MIC_TIMEOUT = 600;

const MIC_RELEASED_TITLE = "Микрофон больше не используется. Завершить звонок?";
const MIC_COUNTDOWN_LABEL = "Завершу сам через";

const NEW_QUESTION_STATUS = "Новый, только что";

/** Thinking this long reads "думаю дольше обычного", not an error. */
export const SLOW_THINKING_SECONDS = 25;

/* Time */

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

/** "24:18" for the title bar. */
export function formatCallTime(seconds: number) {
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

/** "6:48" for countdowns. */
export function formatCountdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;
}

/** "24:18" or "6:48" back to seconds. */
export function parseTime(value: string | undefined) {
  if (!value) {
    return null;
  }
  const [minutes = 0, seconds = 0] = value.split(":").map(Number);
  return minutes * 60 + seconds;
}

/** Wall clock of the demo call: it started at 12:00. */
const START_MINUTES = 12 * 60;

export function clockAt(elapsed: number) {
  const minutes = START_MINUTES + Math.floor(elapsed / 60);
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;
}

/** "12:39": local wall clock of a moment, ms since the epoch. */
function wallClock(at: number) {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* Initial state */

export function createLiveCall(data: CallScreenData): LiveCallState {
  const { banner } = data.questions;
  return {
    agentRetryIn: parseTime(banner?.hint?.time),
    backend: null,
    data,
    elapsed: parseTime(data.call.time) ?? 0,
    micLeft: data.micReleased ? parseTime(data.micReleased.countdown) : null,
    micTotal: MIC_TIMEOUT,
    stash: {},
  };
}

/** The call as it starts: the agent listens, the brief is being read. */
export function startingCall() {
  return createLiveCall(CALL_SCREENS.starting);
}

/**
 * The call as it starts in Tauri: the transcript is the recognizer's, the
 * questions the backend's, so none of the demo's yet.
 */
export function backendCall(): LiveCallState {
  const starting = startingCall();
  return {
    ...starting,
    backend: { state: null, status: null, thinkingSince: null },
    data: {
      ...starting.data,
      questions: { agent: LIVE_AGENT, anchors: [], empty: AGENT_LISTENING },
      transcript: { ...starting.data.transcript, items: [] },
    },
  };
}

/* Questions */

function openCount(topic: TopicData) {
  return topic.questions.length + (topic.main ? 1 : 0) + (topic.pinned ? 1 : 0);
}

/** Anchors follow the topics: final check, current, previous, "Без темы". */
function withAnchors(questions: QuestionsData): QuestionsData {
  const anchors: TopicAnchorData[] = [];
  const { current, earlier = [], finalCheck, noTopic, previous } = questions;

  if (finalCheck) {
    anchors.push({
      active: true,
      count: finalCheck.questions.length + 1,
      countTone: "open",
      id: FINAL_CHECK_TOPIC_ID,
      label: finalCheck.title,
    });
  }
  for (const topic of [current, previous, ...earlier]) {
    if (topic) {
      const count = openCount(topic);
      anchors.push({
        active: topic === current && !finalCheck,
        count,
        countTone: count > 0 ? "open" : "neutral",
        id: topic.id,
        label: topic.title,
      });
    }
  }
  // The final check leaves no room for "Без темы", as in Paper
  if (noTopic && !finalCheck) {
    anchors.push({
      count: openCount(noTopic),
      countTone: "neutral",
      id: noTopic.id,
      label: noTopic.title,
    });
  }
  return { ...questions, anchors };
}

type TopicSlot = "current" | "previous" | "noTopic";
const TOPIC_SLOTS: TopicSlot[] = ["current", "previous", "noTopic"];

function mapTopic(
  questions: QuestionsData,
  topicId: string,
  update: (topic: TopicData) => TopicData
): QuestionsData {
  const next = { ...questions };
  for (const slot of TOPIC_SLOTS) {
    const topic = next[slot];
    if (topic?.id === topicId) {
      next[slot] = update(topic);
    }
  }
  return next;
}

function findTopic(questions: QuestionsData, topicId: string) {
  return TOPIC_SLOTS.map((slot) => questions[slot]).find(
    (topic) => topic?.id === topicId
  );
}

function withoutQuestion(topic: TopicData, questionId: string): TopicData {
  return {
    ...topic,
    questions: topic.questions.filter((question) => question.id !== questionId),
  };
}

function addHistory(topic: TopicData, entry: HistoryEntry): TopicData {
  const history = topic.history ?? { items: [] };
  const items = [...history.items, entry];
  return {
    ...topic,
    history: {
      count: history.count === undefined ? undefined : items.length,
      items,
    },
  };
}

function removeHistory(topic: TopicData, entryId: string): TopicData {
  if (!topic.history) {
    return topic;
  }
  const items = topic.history.items.filter((entry) => entry.id !== entryId);
  return {
    ...topic,
    history: {
      count: topic.history.count === undefined ? undefined : items.length,
      items,
    },
  };
}

/** The main question as a plain row, when a newer one takes its place. */
function demoteMain(topic: TopicData): TopicData {
  if (!topic.main) {
    return topic;
  }
  const { description, id, title } = topic.main;
  return {
    ...topic,
    main: undefined,
    questions: [
      { description, id: id ?? `${topic.id}-main`, title },
      ...topic.questions,
    ],
  };
}

const HISTORY_NOTES: Record<
  "asked" | "hide",
  Pick<HistoryEntry, "note" | "status">
> = {
  asked: { note: "Вы отметили, что спросили", status: "unanswered" },
  hide: { note: "Вы скрыли", status: "hidden" },
};

function questionAction(
  state: LiveCallState,
  topicId: string,
  questionId: string,
  action: QuestionQuickAction
): LiveCallState {
  const { questions } = state.data;

  if (topicId === FINAL_CHECK_TOPIC_ID) {
    const { finalCheck } = questions;
    if (!finalCheck || action === "pin") {
      return state;
    }
    return withQuestions(state, {
      ...questions,
      finalCheck: {
        ...finalCheck,
        questions: finalCheck.questions.filter(
          (item) => item.id !== questionId
        ),
      },
    });
  }

  const topic = findTopic(questions, topicId);
  const question = topic?.questions.find((item) => item.id === questionId);
  if (!(topic && question)) {
    return state;
  }

  if (action === "pin") {
    let next = withoutQuestion(topic, questionId);
    if (next.pinned) {
      next = unpinTopic(next, state.stash);
    }
    next = {
      ...next,
      pinned: {
        description: question.description,
        id: question.id,
        label: `Закреплён вами в ${clockAt(state.elapsed)}`,
        title: question.title,
      },
    };
    return {
      ...withQuestions(
        state,
        mapTopic(questions, topicId, () => next)
      ),
      stash: { ...state.stash, [question.id]: question },
    };
  }

  const entryId = `${action}-${question.id}`;
  const entry: HistoryEntry = {
    id: entryId,
    question: question.title,
    ...HISTORY_NOTES[action],
  };
  return {
    ...withQuestions(
      state,
      mapTopic(questions, topicId, (current) =>
        addHistory(withoutQuestion(current, questionId), entry)
      )
    ),
    stash: { ...state.stash, [entryId]: question },
  };
}

function unpinTopic(
  topic: TopicData,
  stash: LiveCallState["stash"]
): TopicData {
  if (!topic.pinned) {
    return topic;
  }
  const { description, id, title } = topic.pinned;
  const question = stash[id] ?? { description, id, title };
  return {
    ...topic,
    pinned: undefined,
    questions: [question, ...topic.questions],
  };
}

function restoreQuestion(
  state: LiveCallState,
  topicId: string,
  entryId: string
): LiveCallState {
  const { questions } = state.data;
  const entry = findTopic(questions, topicId)?.history?.items.find(
    (item) => item.id === entryId
  );
  if (!entry) {
    return state;
  }
  const question: OpenQuestionData = state.stash[entryId] ?? {
    description: entry.note ?? "",
    id: entry.id,
    title: entry.question,
  };
  return withQuestions(
    state,
    mapTopic(questions, topicId, (topic) => {
      const next = removeHistory(topic, entryId);
      return { ...next, questions: [question, ...next.questions] };
    })
  );
}

function withQuestions(
  state: LiveCallState,
  questions: QuestionsData
): LiveCallState {
  return {
    ...state,
    data: { ...state.data, questions: withAnchors(questions) },
  };
}

/* Feed */

function upsertTranscript(items: TranscriptItem[], item: TranscriptItem) {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    return [...items, item];
  }
  return items.map((existing) => (existing.id === item.id ? item : existing));
}

const LAG_DESCRIPTION =
  "Компьютер нагружен, звук пишется полностью. Догоню, вопросы обновятся следом.";

/** "Расшифровка отстаёт на 40 секунд". */
export function lagNotice(seconds: number) {
  const rounded = Math.round(seconds);
  return {
    description: LAG_DESCRIPTION,
    title: `Расшифровка отстаёт на ${rounded} ${plural(rounded, "секунду", "секунды", "секунд")}`,
  };
}

const UNAVAILABLE: Record<
  Exclude<TranscriptionState, "ok">,
  TranscriptUnavailableData
> = {
  modelFailed: {
    description:
      "Модель распознавания не запустилась. Звонок записывается, расшифровка появится, когда модель заработает. Скачайте её заново в настройках.",
    settingsHref: routes.settings("audio"),
    title: "Расшифровка не работает",
  },
  noModel: {
    description:
      "Звонок записывается, а расшифровки не будет, пока нет модели. Её можно скачать в настройках.",
    settingsHref: routes.settings("audio"),
    title: "Модель распознавания не установлена",
  },
  segmentationUnavailable: {
    description:
      "Не получается разделить звук на фразы. Звонок записывается целиком, расшифровка появится после звонка.",
    title: "Расшифровка недоступна",
  },
};

function withTranscript(
  state: LiveCallState,
  update: (transcript: TranscriptData) => TranscriptData
): LiveCallState {
  return {
    ...state,
    data: { ...state.data, transcript: update(state.data.transcript) },
  };
}

function upsertContext(items: ContextItem[], item: ContextItem) {
  if (items.some((existing) => existing.id === item.id)) {
    return items.map((existing) => (existing.id === item.id ? item : existing));
  }
  if (item.kind === "searching") {
    return [item, ...items];
  }
  // Fresh findings go first, under what is still being searched
  const firstFound = items.findIndex(
    (existing) => existing.kind !== "searching"
  );
  const at = firstFound === -1 ? items.length : firstFound;
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/** Drops a question from every topic, before it shows up elsewhere. */
function withoutQuestionAnywhere(
  questions: QuestionsData,
  questionId: string
): QuestionsData {
  const next = { ...questions };
  for (const slot of TOPIC_SLOTS) {
    const topic = next[slot];
    if (topic) {
      next[slot] = withoutQuestion(topic, questionId);
    }
  }
  return next;
}

function applyFeed(state: LiveCallState, event: CallFeedEvent): LiveCallState {
  const { data } = state;
  const { questions } = data;

  switch (event.type) {
    case "transcript":
      return withTranscript(state, (transcript) => ({
        ...transcript,
        items: upsertTranscript(transcript.items, event.item),
      }));
    case "transcript-pending":
      return data.transcript.items.some((item) => item.id === event.item.id)
        ? state
        : withTranscript(state, (transcript) => ({
            ...transcript,
            items: [...transcript.items, event.item],
          }));
    case "transcript-remove":
      return withTranscript(state, (transcript) => ({
        ...transcript,
        items: transcript.items.filter((item) => item.id !== event.id),
      }));
    case "transcript-lag":
      return withTranscript(state, (transcript) => ({
        ...transcript,
        notice: event.seconds > 0 ? lagNotice(event.seconds) : undefined,
      }));
    case "transcription":
      return withTranscript(state, (transcript) => ({
        ...transcript,
        unavailable:
          event.state === "ok" ? undefined : UNAVAILABLE[event.state],
      }));
    case "context": {
      const removed = new Set(event.remove);
      let items = data.context.items.filter((item) => !removed.has(item.id));
      if (event.item) {
        items = upsertContext(items, event.item);
      }
      return {
        ...state,
        data: {
          ...data,
          context: {
            description: event.description ?? data.context.description,
            items,
          },
        },
      };
    }
    case "topic": {
      let { previous } = questions;
      if (questions.current && questions.current.id !== event.topic.id) {
        const demoted = demoteMain(unpinTopic(questions.current, state.stash));
        const left = demoted.questions.length;
        previous = {
          ...demoted,
          meta: event.previousRange
            ? `${event.previousRange}, осталось ${left}`
            : demoted.meta,
        };
      }
      return withQuestions(state, {
        ...questions,
        current: event.topic,
        empty: undefined,
        previous,
      });
    }
    case "question": {
      const cleared = withoutQuestionAnywhere(questions, event.question.id);
      return withQuestions(
        state,
        mapTopic(cleared, event.topicId, (topic) => ({
          ...topic,
          questions: [...topic.questions, event.question],
        }))
      );
    }
    case "main-question":
      return withQuestions(
        state,
        mapTopic(questions, event.topicId, (topic) => ({
          ...demoteMain(topic),
          main: event.main,
        }))
      );
    case "answered":
      return withQuestions(
        state,
        mapTopic(questions, event.topicId, (topic) => {
          const next = event.questionId
            ? withoutQuestion(topic, event.questionId)
            : topic;
          return addHistory(next, event.entry);
        })
      );
    case "final-check":
      return withQuestions(state, {
        ...questions,
        current: questions.current
          ? demoteMain(questions.current)
          : questions.current,
        finalCheck: event.finalCheck,
      });
    default:
      // "mic-released": the page hands it to the microphone watch, which
      // answers with the `mic-released` action.
      return state;
  }
}

/** "Zoom отпустил микрофон в 12:39." */
function releasedBy(app: string | null, at: string) {
  return app
    ? `${app} отпустил микрофон в ${at}.`
    : `Микрофон освободился в ${at}.`;
}

/** The meeting app let the microphone go: offer to end the call. */
function releaseMic(
  state: LiveCallState,
  action: Extract<LiveCallAction, { type: "mic-released" }>
): LiveCallState {
  const { data } = state;
  const passed = Math.max(
    0,
    Math.floor((action.now - action.releasedAt) / 1000)
  );
  return {
    ...state,
    data: {
      ...data,
      call: { ...data.call, endAction: "secondary" },
      micReleased: {
        countdownLabel: MIC_COUNTDOWN_LABEL,
        description: `${releasedBy(action.app, wallClock(action.releasedAt))} Если это пауза, просто продолжайте.`,
        progress: 100,
        title: MIC_RELEASED_TITLE,
      },
      questions: {
        ...data.questions,
        agent: { label: "тишина", state: "listening", tone: "muted" },
      },
    },
    micLeft:
      action.timeout === null ? null : Math.max(0, action.timeout - passed),
    micTotal: action.timeout ?? MIC_TIMEOUT,
  };
}

/* Finishing */

const SUMMARY_STEPS: Omit<FinishingStep, "state">[] = [
  { id: "transcript", label: "Расшифровка дописана" },
  { id: "summary", label: "Итоги и короткое резюме по темам" },
  { id: "open", label: "Незакрытые вопросы" },
  { id: "brief", label: "Что обновить в брифе и профилях" },
];

/** The finishing card after `stage` finished stages. */
function finishingAt(
  stage: number,
  base: Pick<FinishingData, "description">
): FinishingData {
  return {
    description: base.description,
    progress: Math.round((stage / SUMMARY_STAGES) * 100),
    steps: SUMMARY_STEPS.map((step, index) => {
      let stepState: FinishingStep["state"] = "pending";
      if (index < stage) {
        stepState = "done";
      } else if (index === stage) {
        stepState = "active";
      }
      return { ...step, state: stepState };
    }),
    title: "Собираю итоги…",
  };
}

function finishDescription(state: LiveCallState, project: string) {
  const minutes = Math.max(1, Math.round(state.elapsed / 60));
  const { current, previous } = state.data.questions;
  const topics = [current, previous].filter(Boolean).length;
  const parts = [
    project,
    `${minutes} ${plural(minutes, "минута", "минуты", "минут")}`,
  ];
  if (topics > 0) {
    parts.push(`${topics} ${plural(topics, "тема", "темы", "тем")}`);
  }
  return `${parts.join(", ")}. Обычно это до минуты, окно можно закрыть.`;
}

/* The backend's questions (Tauri) */

/** The agent's footers on the transcript, after it changed. */
function withAgentFooters(state: LiveCallState): LiveCallState {
  const read = state.backend?.state;
  if (!read) {
    return state;
  }
  const { transcript } = state.data;
  return {
    ...state,
    data: {
      ...state.data,
      transcript: {
        ...transcript,
        items: withFooters(
          transcript.items,
          read.questions,
          state.backend?.startedAt
        ),
      },
    },
  };
}

/**
 * A read of the backend's call state replaces the topics, the final check
 * (kept aside while you are back at the topics) and the footers.
 */
function applyCallState(
  before: LiveCallState,
  action: Extract<LiveCallAction, { type: "call-state" }>
): LiveCallState {
  const state = action.agent
    ? applyAgentStatus(before, action.agent, action.now)
    : before;
  const view = toAgentQuestions(action.state, { now: action.now });
  const { questions } = state.data;
  const parked = questions.parkedFinalCheck !== undefined;
  const next: QuestionsData = {
    ...questions,
    current: view.current,
    earlier: view.earlier,
    empty: view.empty,
    finalCheck: parked ? undefined : view.finalCheck,
    noTopic: view.noTopic,
    parkedFinalCheck: parked ? view.finalCheck : undefined,
    previous: view.previous,
  };
  return withAgentFooters({
    ...withQuestions(state, next),
    backend: {
      startedAt: action.startedAt,
      state: action.state,
      status: state.backend?.status ?? null,
      thinkingSince: state.backend?.thinkingSince ?? null,
    },
  });
}

/**
 * "Вернуться к темам" puts the final check aside, "К финальной проверке"
 * brings it back.
 */
function parkFinalCheck(state: LiveCallState, park: boolean): LiveCallState {
  const { questions } = state.data;
  const finalCheck = questions.finalCheck ?? questions.parkedFinalCheck;
  return withQuestions(state, {
    ...questions,
    finalCheck: park ? undefined : finalCheck,
    parkedFinalCheck: park ? finalCheck : undefined,
  });
}

/** The agent's state: the status, its banner and the retry countdown. */
function applyAgentStatus(
  state: LiveCallState,
  status: AgentStatus,
  now: number
): LiveCallState {
  const view = toAgentStatusView(status, now);
  const backend = state.backend ?? {
    state: null,
    status: null,
    thinkingSince: null,
  };
  const { questions } = state.data;
  return {
    ...state,
    agentRetryIn: view.retryIn,
    backend: {
      ...backend,
      status,
      thinkingSince: view.thinking
        ? (backend.thinkingSince ?? state.elapsed)
        : null,
    },
    data: {
      ...state.data,
      questions: {
        ...questions,
        agent: view.agent,
        banner: view.banner,
        frozen: view.frozen,
        usage: view.usage,
      },
    },
  };
}

/* Reducer */

const LIVE_AGENT = { state: "listening" } as const;

export function liveCallReducer(
  state: LiveCallState,
  action: LiveCallAction
): LiveCallState {
  const { data } = state;
  const { questions } = data;

  switch (action.type) {
    case "feed":
      return withAgentFooters(applyFeed(state, action.event));
    case "tick":
      return {
        ...state,
        agentRetryIn:
          state.agentRetryIn === null
            ? null
            : Math.max(0, state.agentRetryIn - 1),
        elapsed: data.finishing ? state.elapsed : state.elapsed + 1,
        micLeft: state.micLeft === null ? null : Math.max(0, state.micLeft - 1),
      };
    case "question":
      return questionAction(
        state,
        action.topicId,
        action.questionId,
        action.action
      );
    case "restore":
      return restoreQuestion(state, action.topicId, action.entryId);
    case "unpin":
      return withQuestions(
        state,
        mapTopic(questions, action.topicId, (topic) =>
          unpinTopic(topic, state.stash)
        )
      );
    case "toggle-transcript":
      return {
        ...state,
        data: {
          ...data,
          transcript: {
            ...data.transcript,
            collapsed: !data.transcript.collapsed,
          },
        },
      };
    case "leave-final-check":
      return parkFinalCheck(state, true);
    case "return-final-check":
      return parkFinalCheck(state, false);
    case "call-state":
      return applyCallState(state, action);
    case "agent-status":
      return applyAgentStatus(state, action.status, action.now);
    case "mic-released":
      return data.finishing ? state : releaseMic(state, action);
    case "mic-continue":
      if (!data.micReleased) {
        return state;
      }
      return {
        ...state,
        data: {
          ...data,
          call: { ...data.call, endAction: "primary" },
          micReleased: undefined,
          questions: { ...questions, agent: LIVE_AGENT },
        },
        micLeft: null,
      };
    case "finish-start":
      return {
        ...state,
        data: {
          ...data,
          call: { ...data.call, endAction: "hidden", recording: "stopped" },
          finishing: finishingAt(1, {
            description: finishDescription(state, action.project),
          }),
          micReleased: undefined,
        },
        micLeft: null,
      };
    case "finish-stage":
      return data.finishing
        ? {
            ...state,
            data: {
              ...data,
              finishing: {
                ...finishingAt(action.stage, data.finishing),
                cancelDisabled: action.stage >= SUMMARY_STAGES,
              },
            },
          }
        : state;
    case "finish-cancel":
      return {
        ...state,
        data: {
          ...data,
          call: { ...data.call, endAction: "primary", recording: "live" },
          finishing: undefined,
          questions: { ...questions, agent: LIVE_AGENT },
        },
      };
    case "agent-retrying":
      return {
        ...state,
        agentRetryIn: null,
        data: {
          ...data,
          questions: {
            ...questions,
            agent: { label: "переподключаюсь", state: "thinking" },
          },
        },
      };
    case "agent-retry-failed": {
      // No status will come: back to the last one, «переподключаюсь» gone.
      const last = state.backend?.status;
      if (last) {
        return applyAgentStatus(state, last, action.now);
      }
      return {
        ...state,
        data: { ...data, questions: { ...questions, agent: LIVE_AGENT } },
      };
    }
    case "agent-recovered":
      return withQuestions(state, {
        ...questions,
        agent: LIVE_AGENT,
        banner: undefined,
        current: questions.current?.main
          ? {
              ...questions.current,
              main: { ...questions.current.main, status: NEW_QUESTION_STATUS },
            }
          : questions.current,
        frozen: false,
      });
    case "reconnect-start":
      return {
        ...state,
        data: {
          ...data,
          context: {
            ...data.context,
            items: data.context.items.map((item) =>
              item.id === action.itemId && item.kind === "unavailable"
                ? { ...item, pending: true }
                : item
            ),
          },
        },
      };
    case "reconnect-done":
      return {
        ...state,
        data: {
          ...data,
          context: {
            ...data.context,
            items: data.context.items.map((item) =>
              item.id === action.item.id ? action.item : item
            ),
          },
        },
      };
    case "audio-restored":
      return {
        ...withQuestions(state, {
          ...questions,
          agent: LIVE_AGENT,
          banner: undefined,
          current: questions.current?.main
            ? {
                ...questions.current,
                main: {
                  ...questions.current.main,
                  status: NEW_QUESTION_STATUS,
                },
              }
            : questions.current,
        }),
      };
    default:
      return {
        ...state,
        data: {
          ...data,
          questions: { ...questions, agent: LIVE_AGENT },
          transcript: {
            ...data.transcript,
            items: data.transcript.items.map((item) =>
              item.kind === "client" && item.live === "transcribing"
                ? { ...item, live: "speaking" }
                : item
            ),
            notice: undefined,
          },
        },
      };
  }
}

/** The agent's status, calm when it thinks longer than usual. */
function agentNow(state: LiveCallState): QuestionsData {
  const since = state.backend?.thinkingSince;
  const { questions } = state.data;
  if (
    since === null ||
    since === undefined ||
    questions.agent.state !== "thinking" ||
    state.elapsed - since < SLOW_THINKING_SECONDS
  ) {
    return questions;
  }
  return {
    ...questions,
    agent: { ...questions.agent, label: "думаю дольше обычного" },
  };
}

/** Props of <CallScreen>: the state plus the ticking numbers. */
export function toScreenData(state: LiveCallState): CallScreenData {
  const { agentRetryIn, data, elapsed, micLeft, micTotal } = state;
  const { banner } = data.questions;
  const questions = agentNow(state);

  return {
    ...data,
    call: { ...data.call, time: formatCallTime(elapsed) },
    micReleased:
      data.micReleased && micLeft !== null
        ? {
            ...data.micReleased,
            countdown: formatCountdown(micLeft),
            progress: Math.round((micLeft / micTotal) * 100),
          }
        : data.micReleased,
    questions:
      banner?.hint?.time && agentRetryIn !== null
        ? {
            ...questions,
            banner: {
              ...banner,
              hint: { ...banner.hint, time: formatCountdown(agentRetryIn) },
            },
          }
        : questions,
  };
}
