import type {
  CallEvidence,
  CallQuestion,
  CallRecording,
  CallSummary,
  CardFact,
  CardLens,
  NextQuestion,
  Proposal,
  SegmentMoment,
  SummaryCard,
  SummaryCardField,
  SummaryContent,
  SummaryPoint,
  SummaryTopic,
  TranscriptSegment,
} from "@/bindings";
import {
  NEXT_QUESTIONS,
  PROPOSAL_GROUPS,
  type ProposalState,
  SUMMARY_TLDR,
  SUMMARY_TOPICS,
  TASK_CARDS,
  type TaskFactData,
  TRANSCRIPT_SECTIONS,
} from "@/features/post-call/mock";

/*
 * The records of the demo call (the Телемедиа call of 19 October,
 * `src/features/post-call/mock.ts`) in the shapes of `src/bindings.ts`:
 * its recording with the transcript, the questions of the fast loop, the
 * summary and the proposals. The mock repository seeds them for the demo
 * call and writes them again when a mock summary is built (the browser's
 * call window plays the same call).
 *
 * `id` names a record: the seed keeps the readable names (`"calls"`,
 * `"operators"`), a build gives UUIDs v7 like Rust. The segments keep the
 * turn ids of the mock (`"t-122108"`), which the transcript links use.
 */

/** Names a record of the demo: a readable seed id, or a fresh UUID. */
export type RecordId = (name: string) => string;

/** The demo call starts at 12:01:00; the turns are wall-clock times. */
const DEMO_START_SECONDS = 12 * 3600 + 60;
/** 40:12, the length of the demo recording. */
export const DEMO_DURATION_MS = 2_412_000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
/** How long a character of a phrase takes to say, roughly. */
const MS_PER_CHAR = 60;
/** A pause before the next phrase. */
const GAP_MS = 200;
/** The summary was built a minute after the call. */
const BUILT_AFTER_MS = 60_000;
/** The demo files: Opus, 2 channels, 13 MB. */
const ME_BYTES = 6_300_000;
const OTHERS_BYTES = 6_700_000;

/** "12:02:14" → seconds since midnight. */
function clockSeconds(time: string) {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(":").map(Number);
  return (hours * MINUTES_PER_HOUR + minutes) * SECONDS_PER_MINUTE + seconds;
}

/** The fast loop's topics of the demo recording. */
const FAST_TOPICS: Record<string, string> = {
  calls: "topic-calls",
  crm: "topic-crm",
};

function demoSegments(
  recordingId: string,
  callId: string,
  startedAt: number
): TranscriptSegment[] {
  const turns = TRANSCRIPT_SECTIONS.flatMap((section) => section.turns);
  return turns.map((turn, index) => {
    const startMs =
      (clockSeconds(turn.time) - DEMO_START_SECONDS) * MS_PER_SECOND;
    const next = turns[index + 1];
    const said = startMs + turn.text.length * MS_PER_CHAR;
    const endMs = next
      ? Math.min(
          said,
          (clockSeconds(next.time) - DEMO_START_SECONDS) * MS_PER_SECOND -
            GAP_MS
        )
      : said;
    return {
      callId,
      channel: turn.speaker === "client" ? "others" : "me",
      createdAt: startedAt + endMs,
      endMs,
      id: turn.id,
      pass: "refined",
      recordingId,
      startMs,
      text: turn.text,
      updatedAt: startedAt + endMs,
    };
  });
}

export interface DemoRecords {
  proposals: Proposal[];
  questions: CallQuestion[];
  recording: CallRecording;
  summary: CallSummary;
}

/** What the screens' quote times ("12:02:14") point at. */
function segmentAt(segments: TranscriptSegment[], id: string) {
  const segment = segments.find((item) => item.id === id);
  if (!segment) {
    throw new Error(`The demo transcript has no turn ${id}`);
  }
  return segment;
}

/** The turn each demo summary point and fact rests on. */
const POINT_TURNS: Record<string, string[]> = {
  admin: ["t-122251"],
  card: ["t-122108"],
  mobile: ["t-120630", "t-121105"],
  operators: ["t-120415"],
  phone: ["t-123020"],
  queue: ["t-120214"],
};

const FACT_TURNS: Record<string, string[]> = {
  "crm-access": ["t-122251"],
  "crm-goal": ["t-122108"],
  goal: ["t-120214"],
  missed: ["t-121612"],
  mobile: ["t-120630", "t-121105"],
  operators: ["t-120415"],
  queue: ["t-120214"],
};

/** The lens of a field of the mock cards. */
const FIELD_LENS: Record<string, CardLens> = {
  constraints: "constraints",
  "done-criteria": "acceptance",
  "edge-cases": "edgeCases",
  goal: "goal",
  integrations: "integrations",
  scenario: "scenarios",
  users: "users",
};

const NEXT_PLACES: Record<string, { field: CardLens; topic: string }> = {
  busy: { field: "edgeCases", topic: "calls" },
  mobile: { field: "integrations", topic: "calls" },
  shift: { field: "users", topic: "calls" },
};

/** The fields of a proposal of the Paper review in the stored shape. */
const PROPOSAL_FIELDS: Record<
  string,
  { evidence: string[]; field: string; kind: Proposal["kind"] }
> = {
  channels: { evidence: ["t-121105"], field: "product", kind: "said" },
  crm: { evidence: ["t-122251"], field: "stack", kind: "said" },
  operators: { evidence: ["t-120415"], field: "product", kind: "said" },
  role: {
    evidence: ["t-122251"],
    field: "portrait:Роль в бизнесе",
    kind: "said",
  },
  tech: { evidence: ["t-122251"], field: "howToAsk", kind: "said" },
  temper: { evidence: [], field: "portrait:Темперамент", kind: "inferred" },
  understanding: {
    evidence: ["t-120630", "t-121105"],
    field: "portrait:Чего ждёт от проекта",
    kind: "inferred",
  },
};

/** The date of the demo call in the notes line, as Rust writes it. */
const pad2 = (value: number) => String(value).padStart(2, "0");
export function notesDate(ms: number) {
  const date = new Date(ms);
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

const WHITESPACE = /\s+/u;

/** `- <date>: <text>`, the line an accepted brief proposal adds to the notes. */
export function notesLine(date: string, text: string) {
  return `- ${date}: ${text.split(WHITESPACE).filter(Boolean).join(" ")}`;
}

/**
 * The demo records of `callId`, recorded from `startedAt`. With
 * `decided` the proposals keep the decisions of the Paper review (the
 * seed); otherwise all are pending (a new build).
 */
export function demoRecords(
  callId: string,
  startedAt: number,
  id: RecordId,
  decided: boolean
): DemoRecords {
  const recordingId = id(`${callId}-recording`);
  const segments = demoSegments(recordingId, callId, startedAt);
  const endedAt = startedAt + DEMO_DURATION_MS;
  const builtAt = endedAt + BUILT_AFTER_MS;

  const evidenceOf = (turns: string[]): CallEvidence[] =>
    turns.map((turnId) => {
      const segment = segmentAt(segments, turnId);
      return {
        quote: segment.text,
        recordingId,
        segmentId: segment.id,
        startMs: segment.startMs,
      };
    });
  const momentOf = (turnId: string): SegmentMoment => {
    const segment = segmentAt(segments, turnId);
    return {
      endMs: segment.endMs,
      recordingId,
      segmentId: segment.id,
      startMs: segment.startMs,
    };
  };

  const topicIds = new Map(
    SUMMARY_TOPICS.map((topic) => [topic.id, id(topic.id)])
  );
  const topics: SummaryTopic[] = SUMMARY_TOPICS.map((topic, index) => {
    const turns = TRANSCRIPT_SECTIONS[index]?.turns ?? [];
    const points: SummaryPoint[] = topic.points.map((point) => ({
      evidence: evidenceOf(POINT_TURNS[point.id] ?? []),
      status: point.status ?? "fact",
      text: point.text,
    }));
    return {
      from: momentOf(turns[0]?.id ?? ""),
      id: topicIds.get(topic.id) ?? topic.id,
      points,
      title: topic.title,
      to: momentOf(turns.at(-1)?.id ?? ""),
      topicIds: FAST_TOPICS[topic.id] ? [FAST_TOPICS[topic.id] ?? ""] : [],
    };
  });

  const factOf = (fact: TaskFactData): CardFact => {
    if (fact.status === "empty") {
      return {
        evidence: [],
        source: "agent",
        status: "empty",
        text: fact.text,
      };
    }
    const sources = {
      agent: "agent",
      docs: "project",
      none: "agent",
      said: "client",
    } as const;
    const source = sources[fact.source.kind];
    return {
      evidence:
        source === "client" ? evidenceOf(FACT_TURNS[fact.id] ?? []) : [],
      source,
      status: fact.status,
      text: fact.text,
    };
  };
  const cards: SummaryCard[] = TASK_CARDS.map((card) => ({
    decision: "pending",
    fields: card.fields.map(
      (field): SummaryCardField => ({
        facts: field.facts.map(factOf),
        field: FIELD_LENS[field.id] ?? "goal",
      })
    ),
    id: id(card.id),
    title: card.title,
    topicId: topicIds.get(card.id) ?? card.id,
  }));
  const next: NextQuestion[] = NEXT_QUESTIONS.map((question) => {
    const place = NEXT_PLACES[question.id];
    return {
      field: place?.field ?? null,
      gap: question.origin,
      text: question.question,
      topicId: place ? (topicIds.get(place.topic) ?? null) : null,
    };
  });
  const content: SummaryContent = { cards, next, topics };

  const summary: CallSummary = {
    builtAt,
    callId,
    content,
    createdAt: builtAt,
    error: null,
    state: "ready",
    title: "Приём звонков, Интеграция с CRM",
    tldr: SUMMARY_TLDR.text,
    transcriptPass: "refined",
    updatedAt: builtAt,
  };

  const recording: CallRecording = {
    audioDeleted: false,
    durationMs: DEMO_DURATION_MS,
    endedAt,
    id: recordingId,
    meBytes: ME_BYTES,
    othersBytes: OTHERS_BYTES,
    pass: "refined",
    segments,
    startedAt,
    transcriptState: "refined",
  };

  return {
    proposals: demoProposals(callId, startedAt, builtAt, id, decided, {
      evidenceOf,
    }),
    questions: demoQuestions(recordingId, startedAt, segments, id, evidenceOf),
    recording,
    summary,
  };
}

function demoQuestions(
  recordingId: string,
  startedAt: number,
  segments: TranscriptSegment[],
  id: RecordId,
  evidenceOf: (turns: string[]) => CallEvidence[]
): CallQuestion[] {
  const moment = (turnId: string | undefined) => {
    if (!turnId) {
      return null;
    }
    const segment = segmentAt(segments, turnId);
    return { recordingId, segmentId: segment.id, startMs: segment.startMs };
  };
  const plain = (turns: string[]) =>
    evidenceOf(turns).map((item) => ({
      id: item.segmentId,
      quote: item.quote,
      source: "segment" as const,
    }));
  const rows: {
    answer?: string;
    asked?: string;
    field: CardLens | null;
    gap: CallQuestion["gapType"];
    name: string;
    priority: number;
    status: CallQuestion["status"];
    text: string;
    topic: string | null;
  }[] = [
    {
      answer: "t-120415",
      asked: "t-120402",
      field: "users",
      gap: "empty",
      name: "operators",
      priority: 1,
      status: "answered",
      text: "Сколько операторов будет на старте?",
      topic: "calls",
    },
    {
      asked: "t-121410",
      field: "edgeCases",
      gap: "empty",
      name: "busy",
      priority: 1,
      status: "asked",
      text: "Что происходит, если все операторы заняты?",
      topic: "calls",
    },
    {
      answer: "t-121612",
      asked: "t-121600",
      field: "edgeCases",
      gap: "empty",
      name: "callback",
      priority: 2,
      status: "answered",
      text: "Перезванивать на пропущенные автоматически?",
      topic: "calls",
    },
    {
      answer: "t-122251",
      asked: "t-122240",
      field: "integrations",
      gap: "empty",
      name: "admin",
      priority: 2,
      status: "answered",
      text: "Кто администрирует amoCRM?",
      topic: "crm",
    },
    {
      asked: "t-123012",
      field: "scenarios",
      gap: "assumption",
      name: "phone",
      priority: 2,
      status: "open",
      text: "Карточку открывать только по номеру телефона?",
      topic: "crm",
    },
    {
      field: "acceptance",
      gap: "empty",
      name: "record",
      priority: 1,
      status: "open",
      text: "Записывать в CRM сам звонок или только факт и длительность?",
      topic: "crm",
    },
    {
      field: "users",
      gap: "assumption",
      name: "shift",
      priority: 3,
      status: "open",
      text: "Кто старший смены и как ему приходят напоминания?",
      topic: "calls",
    },
    {
      field: null,
      gap: "empty",
      name: "prototype",
      priority: 3,
      status: "open",
      text: "Можно ли показать прототип Игорю до конца месяца?",
      topic: null,
    },
  ];
  return rows.map((row, index) => {
    const asked = moment(row.asked);
    const created = startedAt + (asked?.startMs ?? 0) + index;
    return {
      answer: moment(row.answer),
      answerEvidence: row.answer ? plain([row.answer]) : null,
      cardField: row.field,
      cardId: null,
      createdAt: created,
      description: "",
      evidence: row.asked ? plain([row.asked]) : [],
      gapType: row.gap,
      id: id(row.name),
      moment: asked,
      priority: row.priority,
      recordingId,
      status: row.status,
      text: row.text,
      topicId: row.topic ? (FAST_TOPICS[row.topic] ?? null) : null,
      updatedAt: created,
    };
  });
}

/** The decision a proposal of the Paper review is seeded with. */
function seededDecision(state: ProposalState, decided: boolean) {
  if (decided && (state === "accepted" || state === "rejected")) {
    return state;
  }
  return "pending";
}

function demoProposals(
  callId: string,
  startedAt: number,
  builtAt: number,
  id: RecordId,
  decided: boolean,
  { evidenceOf }: { evidenceOf: (turns: string[]) => CallEvidence[] }
): Proposal[] {
  const items = PROPOSAL_GROUPS.flatMap((group) =>
    group.proposals.map((item) => ({ group: group.id, item }))
  );
  return items.map(({ group, item }, index): Proposal => {
    const place = PROPOSAL_FIELDS[item.id] ?? {
      evidence: [],
      field: "notes",
      kind: "inferred",
    };
    const created = builtAt + index;
    const decision = seededDecision(item.state, decided);
    const brief = group === "brief";
    const written = brief
      ? notesLine(notesDate(startedAt), item.suggestion)
      : item.suggestion;
    return {
      after: item.suggestion,
      applied:
        decision === "accepted"
          ? { previous: brief ? null : item.before, written }
          : null,
      before: item.before,
      callId,
      createdAt: created,
      decidedAt: decision === "pending" ? null : created,
      decision,
      edited: null,
      evidence: evidenceOf(place.evidence),
      field: place.field,
      id: id(item.id),
      kind: place.kind,
      personId: brief ? null : group,
      target: brief ? "brief" : "person",
      updatedAt: created,
    };
  });
}
