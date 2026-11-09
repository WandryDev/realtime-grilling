import type {
  Brief,
  Call,
  CallQuestion,
  CallSummary,
  Person,
  Project,
  Proposal,
  SummaryTopic,
  TranscriptSegment,
  Value,
} from "@/bindings";
import { PROJECTS } from "@/features/mock/projects";
import {
  type HistoryCall,
  PROJECT_HISTORY,
  SEARCH,
} from "@/features/post-call/mock";
import { BRIEF } from "@/features/projects/mock";

import type { MockRecording } from "./mock-database";
import { demoRecords, notesDate, notesLine } from "./mock-records";

/*
 * The demo records the mock repository starts with, in the shapes of
 * `src/bindings.ts`. Seed ids stay readable ("telemedia", "olga"): the
 * demo links and the tests open them. Records created afterwards get
 * UUID v7 ids, like the Rust side.
 */

/** Id of the call the demo records; the post-call screens have its data. */
export const DEMO_CALL_ID = "telemedia-19-oct";

/** Seeds are older than anything created in the app, in list order. */
const SEED_CREATED_AT = Date.UTC(2026, 8, 1);

/** The demo briefs were built two hours before the app opened. */
const SEED_BRIEF_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * The Paper brief in the stored shape. The project page draws the Paper
 * version for the demo projects; this one gives them a brief state.
 */
function demoBrief(): Brief {
  return {
    gaps: BRIEF.gaps.map((gap) => ({ ...gap })),
    glossary: BRIEF.glossary.map((entry) => ({ ...entry })),
    keyDocuments: [],
    modules: BRIEF.modules.map((module) => ({
      description: module.conflict ?? module.stage ?? "",
      name: module.name,
    })),
    product: BRIEF.product,
    stack: [...BRIEF.stack],
  };
}

const SEED_PEOPLE: {
  id: string;
  name: string;
  profile: { [key: string]: Value };
  projectId: string;
  role: string;
}[] = [
  {
    id: "olga",
    name: "Ольга Демченко",
    profile: {
      howToAsk:
        "Спрашивать через последствия для бизнеса: деньги, пациенты, сроки. Без терминов.",
      initials: "ОД",
      project: 3,
      tech: 1,
    },
    projectId: "telemedia",
    role: "CEO, решает по срокам и бюджету",
  },
  {
    id: "igor",
    name: "Игорь Савчук",
    profile: {
      howToAsk:
        "Можно сразу про API, поля и форматы. Любит конкретику, не любит «потом решим».",
      initials: "ИС",
      // Accepted from the demo call's proposal (`./mock-records.ts`).
      portrait: { "Роль в бизнесе": "Держит доступы к amoCRM, выдаёт ключи" },
      project: 4,
      tech: 5,
    },
    projectId: "telemedia",
    role: "Техлид, amoCRM и телефония",
  },
];

/* The call found by search in "Ветклиника Лапа" gets a history row too. */
const LAPA_CALLS: HistoryCall[] = [
  {
    date: "8 окт",
    duration: "27:15",
    id: "oct-8",
    openCount: 0,
    participants: "Марина Котова",
    time: "12:10",
    title: "Онлайн-запись и напоминания",
  },
];

/** History ids of the mock that stand for the call the demo records. */
const CALL_ALIASES: Record<string, string> = {
  "oct-19": DEMO_CALL_ID,
  today: DEMO_CALL_ID,
};

const SHORT_MONTHS = ["сен", "окт"];
/** The demo history happens in this year. */
const DEMO_YEAR = 2026;
const FIRST_DEMO_MONTH = 8;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const AUDIO_DELETED = ", аудио удалено";

/** "19 окт" + "12:01" → local time of that moment. */
function startOf(call: HistoryCall) {
  const [day = "1", month = "окт"] = call.date.split(" ");
  const [hours = "0", minutes = "0"] = call.time.split(":");
  return new Date(
    DEMO_YEAR,
    FIRST_DEMO_MONTH + SHORT_MONTHS.indexOf(month),
    Number(day),
    Number(hours),
    Number(minutes)
  ).getTime();
}

/** "40:12" → milliseconds. */
function durationOf(call: HistoryCall) {
  const [minutes = "0", seconds = "0"] = call.duration.split(":");
  return (
    (Number(minutes) * SECONDS_PER_MINUTE + Number(seconds)) * MS_PER_SECOND
  );
}

function seedCall(call: HistoryCall, projectId: string, people: Person[]) {
  const id = CALL_ALIASES[call.id] ?? call.id;
  const label = call.participants.replace(AUDIO_DELETED, "");
  const names = label.split(", ");
  const known = names.map(
    (name) =>
      people.find(
        (person) => person.projectId === projectId && person.name === name
      )?.id
  );
  const participantIds = known.every((personId) => personId !== undefined)
    ? (known as string[])
    : [];
  const summary: { [key: string]: Value } = { summary: "ready" };
  // People the project doesn't have yet keep the names of the history.
  if (participantIds.length === 0) {
    summary.participants = label;
  }
  const startedAt = startOf(call);
  return {
    endedAt: startedAt + durationOf(call),
    id,
    openQuestions: call.openCount,
    participantIds,
    projectId,
    startedAt,
    summary,
    title: call.title,
  };
}

export interface MockSeed {
  calls: Call[];
  people: Person[];
  projects: Project[];
  proposals: Proposal[];
  questions: CallQuestion[];
  recordings: MockRecording[];
  summaries: CallSummary[];
}

/** The note the demo call's accepted brief proposal added. */
const DEMO_NOTE = "Операторы: 5 на старте, до 20 к лету";
const DEMO_NOTES_SECTION = "## Из звонков";

/** "Клиент, 12:38" → "12:38"; `null` for a match in the summary. */
const CLIENT_META = /^Клиент, (?<hours>\d+):(?<minutes>\d+)/u;
/** Where in a call without a time the summary's phrase was said. */
const SUMMARY_PHRASE_MS = 5 * 60 * 1000;
const PHRASE_MS = 6000;

/**
 * The records of an older demo call: a recording (without audio when the
 * history says so) whose transcript holds the phrases the demo search
 * finds, and a summary with the matches "в итогах звонка".
 */
function historyRecords(call: Call, audioDeleted: boolean) {
  const startedAt = call.startedAt ?? call.createdAt;
  const recordingId = `${call.id}-recording`;
  const found = SEARCH.results.filter(
    (result) => seedCallId(result.id) === call.id
  );
  const segments: TranscriptSegment[] = found.map((result, index) => {
    const { hours = "0", minutes = "0" } =
      CLIENT_META.exec(result.match.meta)?.groups ?? {};
    const start = new Date(startedAt);
    const at = new Date(start);
    at.setHours(Number(hours), Number(minutes), 0, 0);
    const startMs = CLIENT_META.test(result.match.meta)
      ? at.getTime() - startedAt
      : SUMMARY_PHRASE_MS + index;
    const text = `${result.match.before}${SEARCH.query}${result.match.after}`
      .replace("Итоги: ", "")
      .replaceAll(/[«»]/gu, "");
    return {
      callId: call.id,
      channel: "others",
      createdAt: startedAt + startMs,
      endMs: startMs + PHRASE_MS,
      id: `${call.id}-segment-${index + 1}`,
      pass: "refined",
      recordingId,
      startMs,
      text,
      updatedAt: startedAt + startMs,
    };
  });
  const topics: SummaryTopic[] = found.flatMap((result, index) => {
    const segment = segments[index];
    if (!segment || CLIENT_META.test(result.match.meta)) {
      return [];
    }
    const moment = {
      endMs: segment.endMs,
      recordingId,
      segmentId: segment.id,
      startMs: segment.startMs,
    };
    return [
      {
        from: moment,
        id: `${call.id}-topic-${index + 1}`,
        points: [
          {
            evidence: [
              {
                quote: segment.text,
                recordingId,
                segmentId: segment.id,
                startMs: segment.startMs,
              },
            ],
            status: "fact",
            text: segment.text,
          },
        ],
        title: call.title,
        to: moment,
        topicIds: [],
      },
    ];
  });
  const endedAt = call.endedAt ?? startedAt;
  const recording: MockRecording = {
    callId: call.id,
    recording: {
      audioDeleted,
      durationMs: endedAt - startedAt,
      endedAt,
      id: recordingId,
      meBytes: audioDeleted ? null : 0,
      othersBytes: audioDeleted ? null : 0,
      pass: "refined",
      segments,
      startedAt,
      transcriptState: "refined",
    },
  };
  const summary: CallSummary = {
    builtAt: endedAt,
    callId: call.id,
    content: { cards: [], next: [], topics },
    createdAt: endedAt,
    error: null,
    state: "ready",
    title: call.title,
    tldr: "",
    transcriptPass: "refined",
    updatedAt: endedAt,
  };
  return { recording, summary };
}

/** A fresh copy of the demo records. */
export function mockSeed(): MockSeed {
  let created = SEED_CREATED_AT;
  const stamp = () => {
    created += 1;
    return { createdAt: created, updatedAt: created };
  };

  const projects: Project[] = PROJECTS.map((project) => ({
    brief: demoBrief(),
    briefBuiltAt: Date.now() - SEED_BRIEF_AGE_MS,
    // Computed on read by the mock database.
    briefState: "fresh",
    briefTruncated: false,
    description: project.description,
    id: project.id,
    name: project.name,
    notes:
      project.id === "telemedia"
        ? `${DEMO_NOTES_SECTION}\n${notesLine(notesDate(demoCallStart()), DEMO_NOTE)}`
        : "",
    openQuestions: project.openQuestions,
    ...stamp(),
  }));

  const people: Person[] = SEED_PEOPLE.map((person) => ({
    ...person,
    profile: { ...person.profile },
    ...stamp(),
  }));

  const history: [HistoryCall, string][] = [];
  for (const [projectId, months] of Object.entries(PROJECT_HISTORY)) {
    for (const month of months) {
      for (const call of month.calls) {
        history.push([call, projectId]);
      }
    }
  }
  for (const call of LAPA_CALLS) {
    history.push([call, "lapa"]);
  }
  const calls: Call[] = history.map(([call, projectId]) => ({
    ...seedCall(call, projectId, people),
    status: "finished",
    ...stamp(),
  }));

  const records: Omit<MockSeed, "calls" | "people" | "projects"> = {
    proposals: [],
    questions: [],
    recordings: [],
    summaries: [],
  };
  for (const [item, call] of history.map(
    ([row], index) => [row, calls[index]] as const
  )) {
    if (!call) {
      continue;
    }
    if (call.id === DEMO_CALL_ID) {
      const demo = demoRecords(
        call.id,
        call.startedAt ?? call.createdAt,
        (name) => name,
        true
      );
      records.recordings.push({ callId: call.id, recording: demo.recording });
      records.questions.push(...demo.questions);
      records.summaries.push(demo.summary);
      records.proposals.push(...demo.proposals);
      continue;
    }
    const older = historyRecords(
      call,
      item.participants.includes(AUDIO_DELETED)
    );
    records.recordings.push(older.recording);
    records.summaries.push(older.summary);
  }

  return { calls, people, projects, ...records };
}

/** When the demo call started: its notes line carries that date. */
function demoCallStart() {
  const row = PROJECT_HISTORY.telemedia[0]?.calls.find(
    (call) => seedCallId(call.id) === DEMO_CALL_ID
  );
  return row ? startOf(row) : 0;
}

/** Resolves the history ids other screens use to the seeded call. */
export function seedCallId(id: string) {
  return CALL_ALIASES[id] ?? id;
}
