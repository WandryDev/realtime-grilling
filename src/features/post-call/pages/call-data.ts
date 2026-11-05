import type {
  CallCards,
  CallEvidence,
  CallQuestion,
  CallRecording,
  CallSummary,
  CardFact,
  CardLens,
  NextQuestion as NextQuestionRecord,
  SummaryCard,
  SummaryContent,
  SummaryProgress,
  SummaryStage,
} from "@/bindings";
import { CARD_LENS_LABELS } from "@/lib/card-lens";
import { plural } from "@/lib/plural";

import type {
  FactStatus,
  NextQuestion,
  ProcessingStepData,
  SummaryPointData,
  SummaryTopic,
  TaskCardData,
  TaskCardOverview,
  TaskFactData,
  UnaskedQuestion,
} from "../mock";

/*
 * The records of a finished call as the post-call screens draw them: the
 * summary, its build, the questions and the task cards. The pages read the
 * records with the hooks of `src/data/*` and pass them through here, so the
 * screens keep the shapes of their mocks (and `/dev` its defaults).
 *
 * Times on the screens are wall-clock: a phrase was said at its
 * recording's `startedAt + startMs`. A link to a moment of the transcript
 * is the id of a segment of the shown pass (`call_transcript`), the
 * `?moment=` of the details page.
 */

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "12:04", or "12:02:14" with seconds. */
export function clockOf(ms: number, seconds = false) {
  const date = new Date(ms);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return seconds ? `${time}:${pad2(date.getSeconds())}` : time;
}

/** A phrase of the call: its recording and when it starts in it. */
interface At {
  recordingId: string;
  segmentId: string;
  startMs: number;
}

/** When a phrase was said; `undefined` until the recordings are read. */
export function wallClock(
  recordings: readonly CallRecording[],
  at: At,
  seconds = false
) {
  const recording = recordings.find((item) => item.id === at.recordingId);
  return recording ? clockOf(recording.startedAt + at.startMs, seconds) : "";
}

/**
 * The `?moment=` of a phrase: its segment when the shown transcript has
 * it, otherwise the client's phrase of the shown pass at that time (the
 * summary was built from the live pass, the second pass came later).
 */
export function momentOf(recordings: readonly CallRecording[], at: At) {
  const recording = recordings.find((item) => item.id === at.recordingId);
  if (!recording || recording.segments.some((s) => s.id === at.segmentId)) {
    return at.segmentId;
  }
  const before = recording.segments.filter(
    (segment) => segment.startMs <= at.startMs
  );
  const said =
    before.filter((segment) => segment.channel === "others").at(-1) ??
    before.at(-1) ??
    recording.segments[0];
  return said?.id ?? at.segmentId;
}

/* ---------------------------------------------------------- Сборка итогов */

const STAGES: SummaryStage[] = ["transcript", "summary", "proposals", "saving"];

const REPLICAS: [string, string, string] = ["реплика", "реплики", "реплик"];
const TOPICS: [string, string, string] = ["тема", "темы", "тем"];

function count(value: number, forms: [string, string, string]) {
  return `${value} ${plural(value, ...forms)}`;
}

const PASS_NOTE = {
  live: "итоги по живой расшифровке",
  mixed: "часть записей по живой расшифровке",
  refined: "уточнённая версия",
} as const;

/** What a stage says while it waits, runs and once it is done. */
function stepOf(
  stage: SummaryStage,
  progress: SummaryProgress | null
): Pick<ProcessingStepData, "description" | "title"> {
  const counts = progress?.counts ?? null;
  switch (stage) {
    case "transcript":
      return counts
        ? {
            description: `${count(counts.segments, REPLICAS)}, ${count(counts.topics, TOPICS)}, ${PASS_NOTE[counts.transcriptPass]}`,
            title: "Расшифровка готова",
          }
        : {
            description: "Жду второй проход распознавания, до минуты",
            title: "Расшифровка",
          };
    case "summary":
      return {
        description: "Название, коротко, темы с пунктами и карточки задач",
        title: "Собираю итоги и карточки задач",
      };
    case "proposals":
      return {
        description:
          counts?.proposals === null || counts?.proposals === undefined
            ? "Ничего не применю без вашего подтверждения"
            : `${count(counts.proposals, ["предложение", "предложения", "предложений"])}, ничего не применю без вашего подтверждения`,
        title: "Предложения обновить бриф и профили",
      };
    default:
      return {
        description: "Проверяю цитаты и сверяю вопросы звонка",
        title: "Сохраняю итоги",
      };
  }
}

/**
 * The steps of «Сборка итогов» at `progress` (`null`: the build has not
 * said anything yet). A call without a project has no proposals stage.
 */
export function processingSteps(
  progress: SummaryProgress | null,
  hasProject: boolean
): ProcessingStepData[] {
  const stages = STAGES.filter((stage) => hasProject || stage !== "proposals");
  const reached = progress ? stages.indexOf(progress.stage) : 0;
  const finished =
    progress?.state.status === "done" ? reached + 1 : Math.max(reached, 0);
  return stages.map((stage, index) => {
    const step = stepOf(stage, progress);
    let status: ProcessingStepData["status"] = "waiting";
    if (index < finished) {
      status = "done";
    } else if (index === finished) {
      status = "active";
    }
    return { ...step, id: stage, status };
  });
}

/* ---------------------------------------------------------- Итоги звонка */

/** Why a summary is not there, as «Итоги не собраны: …» says it. */
export function failureReason(error: string | null) {
  if (error === "interrupted") {
    return "сборку прервал перезапуск приложения";
  }
  if (error === "cancelled") {
    return "сборку остановили";
  }
  const reason = error?.trim();
  if (!reason) {
    return "агент не ответил";
  }
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

const POINT_NOTE = {
  assumption: "Допущение, проверить на следующем звонке",
  contradiction: "Противоречие, уточнить у клиента",
} as const;

/** The topics of a saved summary with their time ranges and points. */
export function summaryTopics(
  content: SummaryContent,
  recordings: readonly CallRecording[]
): SummaryTopic[] {
  return content.topics.map((topic) => {
    const points: SummaryPointData[] = topic.points.flatMap(
      (point, index): SummaryPointData[] => {
        const [first] = point.evidence;
        // A point without its phrase is not shown (call-summary spec).
        if (!first) {
          return [];
        }
        const status = point.status === "fact" ? undefined : point.status;
        return [
          {
            id: `${topic.id}-${index}`,
            moment: momentOf(recordings, first),
            note: status ? POINT_NOTE[status] : undefined,
            status,
            text: point.text,
            time: wallClock(recordings, first),
          },
        ];
      }
    );
    const from = wallClock(recordings, topic.from);
    const to = wallClock(recordings, {
      ...topic.to,
      startMs: topic.to.endMs,
    });
    return {
      id: topic.id,
      points,
      range: from && to ? `${from}–${to}` : "",
      title: topic.title,
    };
  });
}

/** Asked or open, not answered or hidden: «Не успели спросить». */
export function isUnasked(question: CallQuestion) {
  return question.status === "open" || question.status === "asked";
}

/** The title of the topic a question of the fast loop belongs to. */
export function topicTitles(
  summary: CallSummary | null,
  cards: CallCards
): Map<string, string> {
  const titles = new Map<string, string>();
  for (const topic of summary?.content?.topics ?? []) {
    for (const id of topic.topicIds) {
      titles.set(id, topic.title);
    }
  }
  if (cards.source === "live") {
    for (const card of cards.cards) {
      if (!titles.has(card.topicId)) {
        titles.set(card.topicId, card.title);
      }
    }
  }
  return titles;
}

/** «Не успели спросить»: the most important first, with the topic. */
export function unaskedQuestions(
  questions: readonly CallQuestion[],
  titles: Map<string, string>
): UnaskedQuestion[] {
  const left = questions
    .filter(isUnasked)
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
  return left.map((question, index) => {
    const topic = question.topicId ? titles.get(question.topicId) : undefined;
    let note = topic ?? "Без темы";
    if (question.status === "asked") {
      note = `${note}, спросили, ответа не было`;
    } else if (index === 0) {
      note = `${note}, самый важный`;
    }
    return { id: question.id, note, question: question.text };
  });
}

/** The chips under the TL;DR, counted from the records. */
export function summaryChips({
  live,
  questions,
  topics,
}: {
  live: boolean;
  questions: readonly CallQuestion[];
  topics: number;
}) {
  const closed = questions.filter((item) => item.status === "answered").length;
  const missed = questions.filter(isUnasked).length;
  const chips: { accent?: true; id: string; label: string }[] = [
    { id: "topics", label: count(topics, TOPICS) },
    {
      id: "closed",
      label: `${closed} ${plural(closed, "вопрос закрыт", "вопроса закрыто", "вопросов закрыто")}`,
    },
    { accent: true, id: "missed", label: `${missed} не успели спросить` },
  ];
  if (live) {
    chips.push({ id: "live", label: "по живой расшифровке" });
  }
  return chips;
}

const STATUSES: FactStatus[] = [
  "confirmed",
  "assumption",
  "contradiction",
  "empty",
];

const STATUS_FORMS: Record<FactStatus, [string, string, string]> = {
  assumption: ["допущение", "допущения", "допущений"],
  confirmed: ["подтверждено", "подтверждено", "подтверждено"],
  contradiction: ["противоречие", "противоречия", "противоречий"],
  empty: ["пусто", "пусто", "пусто"],
};

/** The lenses in the order of a card. */
export const LENSES: CardLens[] = [
  "goal",
  "users",
  "scenarios",
  "edgeCases",
  "integrations",
  "constraints",
  "acceptance",
];

/** A status per lens: its facts', an empty lens counts as `empty`. */
function lensStatuses(card: SummaryCard): FactStatus[] {
  return LENSES.flatMap((lens) => {
    const facts = card.fields.find((field) => field.field === lens)?.facts;
    return facts && facts.length > 0
      ? facts.map((fact) => fact.status)
      : ["empty"];
  });
}

/** The right column's «Карточки задач»: how complete each card is. */
export function cardsOverview(cards: readonly SummaryCard[]) {
  return cards.map((card): TaskCardOverview => {
    const statuses = lensStatuses(card);
    const segments = STATUSES.flatMap((status) => {
      const total = statuses.filter((item) => item === status).length;
      return total > 0 ? [{ count: total, status }] : [];
    });
    return {
      caption: segments
        .map(
          (item) =>
            `${item.count} ${plural(item.count, ...STATUS_FORMS[item.status])}`
        )
        .join(", "),
      id: card.id,
      segments,
      title: card.title,
    };
  });
}

/* -------------------------------------------------------- Карточки задач */

/**
 * Who said it: a call with one person of the client names them, otherwise
 * «сказал клиент» (the «Остальные» channel mixes everyone).
 */
export function speakerOf(participants: readonly string[]) {
  const [only] = participants;
  return participants.length === 1 && only
    ? (only.trim().split(" ")[0] ?? only)
    : "клиент";
}

const ORIGIN_LABEL: Record<NextQuestion["origin"], string> = {
  assumption: "проверить допущение",
  contradiction: "из противоречия",
  empty: "из пустого поля",
};

/** «Спросить в следующий раз» of the summary. */
export function nextQuestions(next: readonly NextQuestionRecord[]) {
  return next.map(
    (item, index): NextQuestion => ({
      id: `next-${index}`,
      label: ORIGIN_LABEL[item.gap],
      origin: item.gap,
      question: item.text,
    })
  );
}

interface CardContext {
  /** Fast loop's topic ids of each card's topic. */
  fastTopics: (card: SummaryCard) => string[];
  questions: readonly CallQuestion[];
  recordings: readonly CallRecording[];
  speaker: string;
}

function sourceOf(
  fact: CardFact,
  time: string,
  speaker: string
): TaskFactData["source"] {
  if (fact.status === "empty") {
    return { kind: "none", text: "Не обсуждали" };
  }
  if (fact.source === "client") {
    const said =
      speaker === "клиент" ? "сказал клиент" : `сказал(а) ${speaker}`;
    return { kind: "said", text: time ? `${said}, ${time}` : said };
  }
  if (fact.source === "project") {
    return { kind: "docs", text: "из документов проекта" };
  }
  return { kind: "agent", text: "вывод агента" };
}

function factOf(
  fact: CardFact,
  id: string,
  context: CardContext
): TaskFactData {
  const [quote] = fact.status === "empty" ? [] : fact.evidence;
  const time = quote ? wallClock(context.recordings, quote) : "";
  return {
    id,
    quote: quote ? quoteOf(quote, context.recordings) : undefined,
    source: sourceOf(fact, time, context.speaker),
    status: fact.status,
    text: fact.text,
  };
}

function quoteOf(
  evidence: CallEvidence,
  recordings: readonly CallRecording[]
): NonNullable<TaskFactData["quote"]> {
  return {
    initial: "К",
    moment: momentOf(recordings, evidence),
    text: evidence.quote,
    time: wallClock(recordings, evidence, true),
  };
}

/** An empty lens: the question about it, or «Не обсуждали». */
function emptyLens(
  card: SummaryCard,
  lens: CardLens,
  context: CardContext
): TaskFactData {
  const topics = context.fastTopics(card);
  const [question] = context.questions
    .filter(
      (item) =>
        item.cardField === lens &&
        item.topicId !== null &&
        topics.includes(item.topicId) &&
        isUnasked(item)
    )
    .sort((a, b) => a.priority - b.priority);
  return {
    id: `${card.id}-${lens}-empty`,
    source:
      question?.status === "asked"
        ? { kind: "none", text: "Спросили, ответа не было" }
        : { kind: "none", text: "Не обсуждали" },
    status: "empty",
    text: question?.text ?? "Не обсуждали",
  };
}

/** The cards of a call with all seven lenses, in the screens' shape. */
export function taskCards(
  cards: CallCards,
  content: SummaryContent | null,
  context: Omit<CardContext, "fastTopics">
): TaskCardData[] {
  const topics = new Map(
    (content?.topics ?? []).map((topic) => [topic.id, topic])
  );
  const full: CardContext = {
    ...context,
    fastTopics: (card) =>
      cards.source === "live"
        ? [card.topicId]
        : (topics.get(card.topicId)?.topicIds ?? []),
  };
  return cards.cards.map((card) => {
    const topic = topics.get(card.topicId);
    const from = topic ? wallClock(context.recordings, topic.from) : "";
    const to = topic
      ? wallClock(context.recordings, { ...topic.to, startMs: topic.to.endMs })
      : "";
    let discussed = "собрана во время звонка";
    if (from && to) {
      discussed = `обсуждали ${from}–${to}`;
    }
    return {
      discussed,
      fields: LENSES.map((lens) => {
        const facts =
          card.fields.find((field) => field.field === lens)?.facts ?? [];
        return {
          facts:
            facts.length > 0
              ? facts.map((fact, index) =>
                  factOf(fact, `${card.id}-${lens}-${index}`, full)
                )
              : [emptyLens(card, lens, full)],
          id: lens,
          label: CARD_LENS_LABELS[lens],
        };
      }),
      id: card.id,
      title: card.title || "Без названия",
    };
  });
}
