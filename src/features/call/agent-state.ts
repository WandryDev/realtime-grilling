import type {
  AgentStatus,
  CallState,
  ContextFinding,
  Evidence,
  FindingSourceKind,
  GapType,
  LimitHit,
  Question,
  Topic,
} from "@/bindings";
import { hitLine, resetLine } from "@/lib/agent-limit";
import { plural } from "@/lib/plural";
import { routes } from "@/lib/routes";

import type {
  AgentBannerData,
  AgentStatusData,
  ContextData,
  ContextItem,
  FinalCheckData,
  HistoryEntry,
  ListeningEmptyData,
  MainQuestionData,
  OpenQuestionData,
  PinnedQuestionData,
  QuestionTag,
  TopicData,
  TranscriptFooter,
  TranscriptItem,
} from "./types";

/*
 * The backend's call state (`call_state_get`, agent-fast-loop design.md,
 * decisions 7, 8 and 11) as the shapes the call window and the overlay
 * draw. The backend decides what is visible and in which order; this only
 * reads it:
 * - the current topic: the whole visible list of the backend by `rank`,
 *   its pinned question, the main one (the first visible after the
 *   pinned) and the queue. A question pinned in another topic stays in
 *   it, tagged with that topic;
 * - earlier topics and "Без темы" with their open questions that aren't
 *   in the list;
 * - every topic's history: answered with the quote, hidden and asked
 *   with «Вернуть»;
 * - the final check, each question under its topic's title;
 * - transcript footers from the questions' evidence segments;
 * - the «Контекст» column: the sources the slow loop searches, its
 *   search, its findings with the question each points at
 *   (agent-slow-loop design.md, decision 8).
 *
 * Pure, so the reducer and the overlay share it and the tests read it.
 */

/** Topic id of the questions without a topic. */
export const NO_TOPIC_ID = "no-topic";

const NO_TOPIC_TITLE = "Без темы";

/** A question this fresh shows "Новый, только что". */
const NEW_QUESTION_MS = 60_000;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const PERCENT = 100;

/** Before the agent named a topic. */
export const AGENT_LISTENING: ListeningEmptyData = {
  description:
    "Обычно это первые две-три минуты. Вопросы появятся сами, их можно закрепить или скрыть.",
  title: "Слушаю. Первые вопросы появятся, когда станет понятна тема",
};

const TAGS: Record<GapType, QuestionTag> = {
  assumption: "assumption",
  contradiction: "contradiction",
  empty: "empty",
};

/* Time */

function pad(value: number) {
  return value.toString().padStart(2, "0");
}

/** "12:21": local wall clock of a moment, ms since the epoch. */
export function wallClock(at: number) {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "6:48": a countdown or an offset into the recording. */
function minutesSeconds(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / SECONDS_PER_MINUTE)}:${pad(whole % SECONDS_PER_MINUTE)}`;
}

/* Questions */

function byRank(a: Question, b: Question) {
  return (
    (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
  );
}

/** Waiting order of the backend: priority, then the oldest first. */
function byPriority(a: Question, b: Question) {
  return b.priority - a.priority || a.createdAt - b.createdAt;
}

function isOpen(question: Question) {
  return question.status === "open";
}

export function questionRow(question: Question): OpenQuestionData {
  return {
    description: question.description,
    id: question.id,
    tag: TAGS[question.gapType],
    title: question.text,
  };
}

function mainStatus(question: Question, now: number) {
  const fresh =
    question.shownAt !== null && now - question.shownAt < NEW_QUESTION_MS;
  switch (question.gapType) {
    case "contradiction":
      return fresh ? "Новый, противоречие" : "Противоречие";
    case "assumption":
      return fresh ? "Новый, допущение" : "Допущение";
    default:
      return fresh ? "Новый, только что" : "Сейчас важнее всего";
  }
}

/** "из темы «Очередь»": a question of another topic in the current list. */
function fromTopic(title: string) {
  return `из темы «${title}»`;
}

function mainQuestion(
  question: Question,
  now: number,
  topic: string | undefined
): MainQuestionData {
  const status = mainStatus(question, now);
  return {
    description: question.description,
    id: question.id,
    status: topic ? `${status}, ${fromTopic(topic)}` : status,
    title: question.text,
  };
}

function pinnedQuestion(
  question: Question,
  topic: string | undefined
): PinnedQuestionData {
  const label = `Закреплён вами в ${wallClock(question.updatedAt)}`;
  return {
    description: question.description,
    id: question.id,
    label: topic ? `${label}, ${fromTopic(topic)}` : label,
    title: question.text,
  };
}

/**
 * The quote an answer shows: the client's words first, a finding or the
 * project only when no phrase has one.
 */
function quoteOf(evidence: readonly Evidence[] | null) {
  const quoted = (evidence ?? []).filter((item) => item.quote.trim() !== "");
  const quote = (quoted.find((item) => item.source === "segment") ?? quoted[0])
    ?.quote;
  return quote ? `«${quote.trim()}»` : undefined;
}

/**
 * A question that left the list. The entry id is the question's, so
 * «Вернуть» acts on it; only answered rows have a time (and no «Вернуть»).
 */
export function historyEntry(question: Question): HistoryEntry | null {
  switch (question.status) {
    case "answered": {
      const answer = quoteOf(question.answerEvidence);
      return {
        ...(answer ? { answer } : {}),
        id: question.id,
        question: question.text,
        status: "answered",
        time: wallClock(question.updatedAt),
      };
    }
    case "hidden":
      return {
        id: question.id,
        note: "Вы скрыли",
        question: question.text,
        status: "hidden",
      };
    case "asked":
      return {
        id: question.id,
        note: "Вы отметили, что спросили",
        question: question.text,
        status: "unanswered",
      };
    default:
      return null;
  }
}

function history(questions: readonly Question[]) {
  const items = [...questions]
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .map(historyEntry)
    .filter((entry): entry is HistoryEntry => entry !== null);
  return items.length > 0 ? { items } : undefined;
}

/* Topics */

/** In the backend's visible list: drawn under the current topic. */
function isListed(question: Question) {
  return question.visible && isOpen(question);
}

/**
 * The topic under discussion: the backend's whole visible list, by rank.
 * A pinned question of another topic is in it too (the backend keeps it
 * visible), tagged with its topic's title from `titles`.
 */
function currentTopic(
  topic: Topic,
  questions: readonly Question[],
  titles: ReadonlyMap<string, string>,
  now: number
): TopicData {
  const visible = questions.filter(isListed).sort(byRank);
  const otherTopic = (question: Question) =>
    question.topicId === topic.id
      ? undefined
      : ((question.topicId === null
          ? undefined
          : titles.get(question.topicId)) ?? NO_TOPIC_TITLE);
  const pinned = visible.find((question) => question.pinned);
  const [main, ...queue] = visible.filter((question) => question !== pinned);
  return {
    history: history(
      questions.filter((question) => question.topicId === topic.id)
    ),
    id: topic.id,
    meta: `идёт сейчас, с ${wallClock(topic.createdAt)}`,
    questions: queue.map((question) => {
      const other = otherTopic(question);
      return {
        ...questionRow(question),
        ...(other ? { topic: `Из темы «${other}»` } : {}),
      };
    }),
    title: topic.title,
    ...(main ? { main: mainQuestion(main, now, otherTopic(main)) } : {}),
    ...(pinned ? { pinned: pinnedQuestion(pinned, otherTopic(pinned)) } : {}),
  };
}

/**
 * A topic the talk moved on from: what is still open (minus what the
 * current list shows), what was done.
 */
function pastTopic(
  topic: Topic,
  questions: readonly Question[],
  endedAt: number | undefined
): TopicData {
  const open = questions
    .filter((question) => isOpen(question) && !question.visible)
    .sort(byPriority);
  const range =
    endedAt === undefined
      ? `с ${wallClock(topic.createdAt)}`
      : `${wallClock(topic.createdAt)}–${wallClock(endedAt)}`;
  return {
    history: history(questions),
    id: topic.id,
    meta: `${range}, осталось ${open.length}`,
    questions: open.map(questionRow),
    title: topic.title,
  };
}

/* The whole state */

export interface AgentQuestions {
  current?: TopicData;
  /** Topics before `previous`, the newest first. */
  earlier: TopicData[];
  /** Before any topic: "Слушаю". */
  empty?: ListeningEmptyData;
  finalCheck?: FinalCheckData;
  noTopic?: TopicData;
  /** Open questions left in earlier topics ("прошлые"). */
  pastOpen: number;
  /** The topic the talk moved on from last. */
  previous?: TopicData;
}

function groupByTopic(questions: readonly Question[]) {
  const groups = new Map<string | null, Question[]>();
  for (const question of questions) {
    const group = groups.get(question.topicId) ?? [];
    group.push(question);
    groups.set(question.topicId, group);
  }
  return groups;
}

/** The call state as the topics of the questions panel. */
export function toAgentQuestions(
  state: CallState,
  { now }: { now: number }
): AgentQuestions {
  const groups = groupByTopic(state.questions);
  const topics = [...state.topics].sort((a, b) => a.position - b.position);
  const current = topics.find((topic) => topic.id === state.currentTopicId);

  // Earlier topics, the newest first; each ends where the next began.
  const past: TopicData[] = [];
  let pastOpen = 0;
  topics.forEach((topic, index) => {
    if (topic === current) {
      return;
    }
    const data = pastTopic(
      topic,
      groups.get(topic.id) ?? [],
      topics[index + 1]?.createdAt
    );
    pastOpen += data.questions.length;
    past.unshift(data);
  });
  const [previous, ...earlier] = past;

  const loose = groups.get(null) ?? [];
  const looseOpen = loose
    .filter((question) => isOpen(question) && !question.visible)
    .sort(byPriority);
  const looseHistory = history(loose);
  const noTopic: TopicData | undefined =
    looseOpen.length > 0 || looseHistory
      ? {
          history: looseHistory,
          id: NO_TOPIC_ID,
          meta: "ждут удобного момента",
          questions: looseOpen.map(questionRow),
          title: NO_TOPIC_TITLE,
        }
      : undefined;

  const finalCheck = toFinalCheck(state, topics);
  const titles = new Map(topics.map((topic) => [topic.id, topic.title]));
  return {
    earlier,
    pastOpen,
    ...(current
      ? { current: currentTopic(current, state.questions, titles, now) }
      : {}),
    ...(current || previous ? {} : { empty: AGENT_LISTENING }),
    ...(finalCheck ? { finalCheck } : {}),
    ...(noTopic ? { noTopic } : {}),
    ...(previous ? { previous } : {}),
  };
}

/* Final check */

/**
 * The agent's final check (decision 8): its open questions in the order
 * the backend chose, each under its topic's title. None once all of them
 * are closed.
 */
function toFinalCheck(
  state: CallState,
  topics: readonly Topic[]
): FinalCheckData | undefined {
  if (!state.finalCheck) {
    return;
  }
  const byId = new Map(
    state.questions.map((question) => [question.id, question])
  );
  const titles = new Map(topics.map((topic) => [topic.id, topic.title]));
  const topicOf = (question: Question) =>
    (question.topicId === null ? undefined : titles.get(question.topicId)) ??
    NO_TOPIC_TITLE;

  const items = state.finalCheck.questionIds
    .map((id) => byId.get(id))
    .filter((question): question is Question =>
      Boolean(question && isOpen(question))
    );
  const [first, ...rest] = items;
  if (!first) {
    return;
  }
  const open = state.questions.filter(isOpen).length;
  return {
    banner: {
      action: "Вернуться к темам",
      description: "Вот что важнее всего спросить, пока все на связи.",
      title: "Похоже, разговор идёт к концу",
    },
    main: {
      description: first.description,
      id: first.id,
      status: topicOf(first),
      title: first.text,
    },
    meta: `${items.length} ${plural(items.length, "самый важный", "самых важных", "самых важных")} из ${open} ${plural(open, "открытого", "открытых", "открытых")}`,
    questions: rest.map((question) => ({
      ...questionRow(question),
      topic: topicOf(question),
    })),
    title: "Финальная проверка",
  };
}

/* Transcript footers */

interface Footer {
  /** The earlier segment a contradiction points at. */
  refersTo?: string;
  status: "answered" | "contradiction";
}

function segmentIds(evidence: readonly Evidence[] | null) {
  return (evidence ?? [])
    .filter((item) => item.source === "segment")
    .map((item) => item.id);
}

/**
 * Footers by segment id: the last segment of an answer is "ответ на
 * вопрос"; the later of a contradiction's two phrases "противоречит
 * сказанному в" the earlier one.
 */
function footersBySegment(
  questions: readonly Question[],
  startOf: (segmentId: string) => number | undefined
) {
  const footers = new Map<string, Footer>();
  for (const question of questions) {
    const answer = segmentIds(question.answerEvidence).at(-1);
    if (question.status === "answered" && answer) {
      footers.set(answer, { status: "answered" });
    }
  }
  // A contradiction outweighs an answer on the same phrase.
  for (const question of questions) {
    if (question.gapType !== "contradiction") {
      continue;
    }
    const ids = [...new Set(segmentIds(question.evidence))];
    if (ids.length < 2) {
      continue;
    }
    const ordered = ids
      .map((id, index) => ({ at: startOf(id) ?? index, id }))
      .sort((a, b) => a.at - b.at);
    const [earlier] = ordered;
    const later = ordered.at(-1);
    if (earlier && later) {
      footers.set(later.id, { refersTo: earlier.id, status: "contradiction" });
    }
  }
  return footers;
}

/**
 * The transcript with the agent's footers on the phrases its questions
 * name. `startedAt` (ms since the epoch) turns the earlier phrase of a
 * contradiction into a wall clock; without it, the time into the
 * recording. Phrases the questions no longer name lose their footer.
 */
export function withFooters(
  items: readonly TranscriptItem[],
  questions: readonly Question[],
  startedAt?: number
): TranscriptItem[] {
  const starts = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== "topic" && item.kind !== "missing" && item.segment) {
      starts.set(item.segment.id, item.segment.startMs);
    }
  }
  const footers = footersBySegment(questions, (id) => starts.get(id));
  const timeOf = (segmentId: string | undefined) => {
    const startMs = segmentId === undefined ? undefined : starts.get(segmentId);
    if (startMs === undefined) {
      return;
    }
    return startedAt === undefined
      ? minutesSeconds(startMs / MS_PER_SECOND)
      : wallClock(startedAt + startMs);
  };

  return items.map((item) => {
    if (item.kind !== "client" || !item.segment) {
      return item;
    }
    const found = footers.get(item.segment.id);
    const footer = found ? toFooter(found, timeOf(found.refersTo)) : undefined;
    if (footer === undefined && item.footer === undefined) {
      return item;
    }
    return { ...item, footer };
  });
}

function toFooter(footer: Footer, time: string | undefined): TranscriptFooter {
  if (footer.status === "answered") {
    return { status: "answered", text: "ответ на вопрос" };
  }
  return {
    status: "contradiction",
    text: "противоречит сказанному в",
    ...(time ? { time } : {}),
  };
}

/* Agent status */

export interface AgentStatusView {
  agent: AgentStatusData;
  banner?: AgentBannerData;
  /** The agent stopped: the questions gray out. */
  frozen: boolean;
  /**
   * A threshold of Grill stops the agent: «Продолжить сверх лимита» lets
   * this call go past it.
   */
  grillLimit?: LimitHit;
  /** Seconds before the backend retries by itself; null: it doesn't. */
  retryIn: number | null;
  /** A call is running. */
  thinking: boolean;
  /** "лимит 42%"; none while unknown. */
  usage?: string;
}

const RETRY_ACTION = {
  id: "retry",
  label: "Повторить",
  variant: "secondary",
} as const;

/** The banner's id of «Продолжить сверх лимита». */
export const OVER_LIMIT_ACTION = "over-limit";

/** «Лимит Grill: сессия 91 % из 90 %». */
export function grillLimitTitle(hit: LimitHit) {
  return `Лимит Grill: ${hitLine(hit)}`;
}

/** The backend's agent state as the status, the banner and the countdown. */
export function toAgentStatusView(
  status: AgentStatus,
  now: number
): AgentStatusView {
  const { utilization } = status;
  const usage =
    utilization === null || utilization === undefined
      ? {}
      : { usage: `лимит ${Math.round(utilization * PERCENT)}%` };
  const { state } = status;

  switch (state.kind) {
    case "thinking":
      return {
        agent: { state: "thinking" },
        frozen: false,
        retryIn: null,
        thinking: true,
        ...usage,
      };
    case "error": {
      const retryIn =
        state.retryAt === null
          ? null
          : Math.max(0, Math.ceil((state.retryAt - now) / MS_PER_SECOND));
      return {
        agent: { label: "вопросы на паузе", state: "listening", tone: "muted" },
        banner: {
          actions: [RETRY_ACTION],
          description:
            "Новых вопросов пока нет. Запись и расшифровка идут, после восстановления догоню пропущенное.",
          ...(state.message ? { footnote: state.message } : {}),
          ...(retryIn === null
            ? {}
            : {
                hint: {
                  text: "Сам попробую через",
                  time: minutesSeconds(retryIn),
                },
              }),
          icon: "claude",
          title: "Claude Code не ответил",
        },
        frozen: true,
        retryIn,
        thinking: false,
        ...usage,
      };
    }
    case "needsLogin":
      return {
        agent: { label: "нужен вход", state: "listening", tone: "muted" },
        banner: {
          actions: [
            {
              href: routes.settings("agent"),
              id: "login",
              label: "Открыть настройки агента",
              variant: "secondary",
            },
          ],
          description:
            "Новых вопросов не будет, пока Claude Code не войдёт в аккаунт. Запись и расшифровка идут.",
          hint: { text: "Настройки → Агент → Войти" },
          icon: "claude",
          title: "Claude Code просит войти",
        },
        frozen: true,
        retryIn: null,
        thinking: false,
        ...usage,
      };
    case "grillLimit":
      return {
        agent: { label: "лимит Grill", state: "listening", tone: "muted" },
        banner: {
          actions: [
            {
              id: OVER_LIMIT_ACTION,
              label: "Продолжить сверх лимита",
              variant: "secondary",
            },
          ],
          description:
            "Новых вопросов пока нет: остаток лимита подписки бережём для вас. Запись и расшифровка идут, после сброса или «Продолжить сверх лимита» догоню пропущенное.",
          hint: { text: resetLine(state.hit.resetsAt, now) },
          icon: "claude",
          title: grillLimitTitle(state.hit),
        },
        frozen: true,
        grillLimit: state.hit,
        retryIn: null,
        thinking: false,
        ...usage,
      };
    case "rateLimited":
      return {
        agent: { label: "лимит исчерпан", state: "listening", tone: "muted" },
        banner: {
          actions: [],
          description:
            "Новых вопросов не будет, список заморожен. Запись и расшифровка идут, вопросы пойдут снова, когда лимит обновится.",
          icon: "claude",
          title:
            state.resetsAt === null
              ? "Лимит подписки Claude исчерпан"
              : `Лимит подписки Claude исчерпан до ${wallClock(state.resetsAt)}`,
        },
        frozen: true,
        retryIn: null,
        thinking: false,
        ...usage,
      };
    default:
      return {
        agent: { state: "listening" },
        frozen: false,
        retryIn: null,
        thinking: false,
        ...usage,
      };
  }
}

/* Context */

/** The column's note next to «Контекст». */
const CONTEXT_DESCRIPTION = "найдено в материалах";

/** No ready sources: nothing to search in, and no findings will come. */
const NO_SOURCES: ContextItem = {
  description:
    "Добавьте файлы, документы Outline или задачи ClickUp на странице проекта после звонка.",
  id: "ctx-no-sources",
  kind: "empty",
  title: "Искать негде: у проекта нет источников",
};

const FINDING_SOURCE: Record<
  FindingSourceKind,
  { label: string; source: "clickup" | "file" | "outline" }
> = {
  clickup: { label: "Задача ClickUp", source: "clickup" },
  file: { label: "Файл проекта", source: "file" },
  outline: { label: "Документ Outline", source: "outline" },
};

/** "3 файла", "12 документов", "1 задача". */
function sourceCount(count: number, one: string, few: string, many: string) {
  return `${count} ${plural(count, one, few, many)}`;
}

/** The ready sources the search covers, the kinds with none left out. */
function sourcesItem(state: CallState): ContextItem | undefined {
  const { clickup, files, outline } = state.contextSources;
  const items: Extract<ContextItem, { kind: "sources" }>["items"] = [];
  if (files > 0) {
    items.push({
      id: "files",
      name: "Файлы",
      source: "file",
      status: sourceCount(files, "файл", "файла", "файлов"),
    });
  }
  if (outline > 0) {
    items.push({
      id: "outline",
      name: "Outline",
      source: "outline",
      status: sourceCount(outline, "документ", "документа", "документов"),
    });
  }
  if (clickup > 0) {
    items.push({
      id: "clickup",
      name: "ClickUp",
      source: "clickup",
      status: sourceCount(clickup, "задача", "задачи", "задач"),
    });
  }
  if (items.length === 0) {
    return;
  }
  return { id: "ctx-sources", items, kind: "sources", label: "Где ищу" };
}

function cites(question: Question, findingId: string) {
  return question.evidence.some(
    (item) => item.source === "document" && item.id === findingId
  );
}

/**
 * The open question a finding points at: the one it is about, else the
 * first that cites it. Answered, asked or hidden ones are no longer in the
 * list, so there is nothing to show.
 */
function questionOf(
  finding: ContextFinding,
  questions: readonly Question[]
): Question | undefined {
  const open = questions.filter(isOpen);
  return (
    open.find((question) => question.id === finding.questionId) ??
    open.find((question) => cites(question, finding.id))
  );
}

/** A finding of the slow loop as a context card. */
export function findingItem(
  finding: ContextFinding,
  questions: readonly Question[]
): ContextItem {
  const { label, source } = FINDING_SOURCE[finding.sourceKind];
  const question = questionOf(finding, questions);
  const url = finding.sourceUrl ?? undefined;
  return {
    hideable: true,
    id: finding.id,
    kind: "finding",
    meta: label,
    source,
    time: wallClock(finding.createdAt),
    title: finding.sourceName,
    ...(finding.note.trim() === "" ? {} : { body: finding.note }),
    ...(finding.quote.trim() === "" ? {} : { quote: finding.quote }),
    ...(question
      ? {
          questionId: question.id,
          questionLink: `к вопросу «${question.text}»`,
        }
      : {}),
    ...(url ? { url } : {}),
  };
}

/**
 * The «Контекст» column from the call state: what the search covers, the
 * search while it runs, the findings, the newest first (the backend's
 * order). Without ready sources it says there is nothing to search in.
 */
export function toAgentContext(state: CallState): ContextData {
  const items: ContextItem[] = [];
  const sources = sourcesItem(state);
  if (sources) {
    items.push(sources);
  } else {
    items.push(NO_SOURCES);
  }
  if (sources && state.contextSearch?.running) {
    const queries = state.contextSearch.queries.filter(
      (query) => query.trim() !== ""
    );
    items.push({
      id: "ctx-searching",
      kind: "searching",
      text:
        queries.length > 0
          ? `Ищу в материалах: ${queries.join(", ")}`
          : "Ищу в материалах",
    });
  }
  for (const finding of state.findings) {
    items.push(findingItem(finding, state.questions));
  }
  return { description: CONTEXT_DESCRIPTION, items };
}
